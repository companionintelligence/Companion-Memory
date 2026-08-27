import * as crypto from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, MoreThan, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type ServiceContext, SYSTEM_USER, UserServiceContext } from '@ci/common/context';
import { EventService } from '@ci/domains/events';

import { SavedSearch, SavedSearchEntity } from '../entities/SavedSearchEntity';
import { SavedSearchCreatedEvent, SavedSearchUpdatedEvent, SavedSearchDeletedEvent } from '../events';
import { DEFAULT_SAVED_SEARCHES } from '../seeds/defaultSavedSearches';
import type { CreateSavedSearchDto, UpdateSavedSearchDto } from '../types';

const TAG_REGEX = /#([\w-]+)/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether `entity`'s name, description or tags contain the lowercased `query`. */
function matchesSavedSearchQuery(entity: SavedSearchEntity, query: string): boolean {
  if (entity.name?.toLowerCase().includes(query)) {
    return true;
  }

  if (entity.description?.toLowerCase().includes(query)) {
    return true;
  }

  return (entity.tags ?? []).some((tag) => tag.toLowerCase().includes(query));
}

@Injectable()
export class SavedSearchService {
  constructor(
    @InjectRepository(SavedSearchEntity)
    private readonly savedSearchRepository: Repository<SavedSearchEntity>,
    private readonly eventService: EventService,
  ) {}

  async create(context: UserServiceContext, data: CreateSavedSearchDto): Promise<SavedSearch> {
    const id = data.id ?? uuidv7();

    const instance = await this.savedSearchRepository.create({
      id,
      name: data.name,
      description: data.description,
      query: data.query,
      entityTypes: data.entityTypes,
      tags: this.assembleTags(data),
      filters: data.filters ?? null,
      userId: context.userId,
    });

    const entity = await this.savedSearchRepository.save(instance);

    await this.eventService.send(SavedSearchCreatedEvent, {
      savedSearchId: id,
    });

    return SavedSearchEntity.toEgressType(entity);
  }

  /**
   * Insert the starter library for a user who has no saved searches yet.
   * Idempotent: a user who already has any row (including after deleting some
   * seeds but keeping others) is left alone, so a boot or a revisit cannot
   * duplicate the catalog. Matches the actions-seed pattern.
   *
   * @returns true when the catalog was inserted
   */
  async ensureDefaults(context: UserServiceContext): Promise<boolean> {
    const existing = await this.savedSearchRepository.count({
      where: { userId: context.userId },
    });

    if (existing > 0) {
      return false;
    }

    const rows = DEFAULT_SAVED_SEARCHES.map((seed) => {
      const entity = new SavedSearchEntity();
      entity.id = uuidv7();
      entity.name = seed.name;
      entity.description = seed.description;
      entity.query = seed.query ?? '';
      entity.entityTypes = seed.entityTypes ?? [];
      entity.tags = this.assembleTags({ query: seed.query, tags: seed.tags });
      entity.filters = seed.filters ?? null;
      entity.userId = context.userId;
      entity.isSeed = true;

      return entity;
    });

    await this.savedSearchRepository.save(rows);

    return true;
  }

  async findAll(
    context: ServiceContext,
    options?: { query?: string; isSeed?: boolean },
  ): Promise<SavedSearch[]> {
    const results = await this.savedSearchRepository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
        ...(options?.isSeed !== undefined && { isSeed: options.isSeed }),
      },
    });

    // In-memory rather than a query-builder ILIKE: a user's saved-search table
    // tops out in the low hundreds (the starter library plus their own), so
    // there's no scale reason to reach for SQL here.
    const trimmed = options?.query?.trim().toLowerCase();
    const filtered = trimmed ? results.filter((entity) => matchesSavedSearchQuery(entity, trimmed)) : results;

    return filtered.map((entity) => SavedSearchEntity.toEgressType(entity));
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(SavedSearch | null)[]> {
    const results = await this.savedSearchRepository.find({
      where: {
        id: In(ids),
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    const map = new Map(results.map((entity) => [entity.id, SavedSearchEntity.toEgressType(entity)]));

    return ids.map((id) => map.get(id) ?? null);
  }

  async findById(context: ServiceContext, id: string): Promise<SavedSearch | null> {
    return this.savedSearchRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });
  }

  async update(context: ServiceContext, id: string, data: UpdateSavedSearchDto): Promise<SavedSearch | null> {
    // ═══ AN ABSENT `tags` MEANS "LEAVE IT ALONE", NOT "CLEAR IT" ═══
    //
    // `assembleTags` was called unconditionally with `data.tags || []`, so a
    // caller that updates only `name` — the edit dialog's own request, before
    // it selected `tags` at all — silently wrote `[]` (or whatever hashtags
    // happened to be in `data.query`, if that was also part of the payload)
    // over the row's actual tags. Renaming a search deleted its tag filter.
    // `UpdateSavedSearchInput` makes every field optional at the schema level,
    // so this protects every current and future caller, not just the one that
    // exposed it — `assembleTags` is only reached, and the column only
    // touched, when the caller actually named `tags` on this request.
    const result = await this.savedSearchRepository.update(
      {
        id,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
      {
        ...data,
        ...(data.tags !== undefined && { tags: this.assembleTags(data) }),
      },
    );

    if (result.affected === 0) {
      return null;
    }

    await this.eventService.send(SavedSearchUpdatedEvent, {
      savedSearchId: id,
    });

    return this.findById(context, id);
  }

  /**
   * Re-point every saved search that filters on `from` so it filters on `to`,
   * after the underlying tag was renamed.
   *
   * Saved searches store tag **labels**, not tag ids, so a rename that only
   * touched `ci_search.tags` would silently leave them filtering on a label
   * nothing carries any more — they would just stop returning results.
   *
   * Both places the label lives get rewritten: the `tags` array and any
   * `#label` in the query text. `assembleTags` re-derives the array from the
   * query on every save, so rewriting one without the other would resurrect
   * the stale label the next time the user edits the search.
   *
   * @returns the number of saved searches changed
   */
  async replaceTagLabel(context: UserServiceContext, from: string, to: string): Promise<number> {
    if (from === to) {
      return 0;
    }

    const rows = await this.savedSearchRepository.find({
      where: { userId: context.userId },
    });

    // `(?![\w-])` rather than `\b`, so renaming `foo` leaves `#foo-bar` alone
    // — TAG_REGEX treats hyphens as part of a label.
    const hashtag = new RegExp(`#${escapeRegExp(from)}(?![\\w-])`, 'gi');

    const changed = rows.filter((row) => {
      const tags = row.tags ?? [];
      const nextTags = [...new Set(tags.map((tag) => (tag === from ? to : tag)))];
      const nextQuery = row.query?.replace(hashtag, () => `#${to}`) ?? row.query;

      const tagsUnchanged =
        nextTags.length === tags.length && nextTags.every((tag, index) => tag === tags[index]);

      if (tagsUnchanged && nextQuery === row.query) {
        return false;
      }

      row.tags = nextTags;
      row.query = nextQuery;

      return true;
    });

    if (changed.length === 0) {
      return 0;
    }

    await this.savedSearchRepository.save(changed);

    for (const row of changed) {
      await this.eventService.send(SavedSearchUpdatedEvent, {
        savedSearchId: row.id,
      });
    }

    return changed.length;
  }

  /**
   * Turn link-sharing on or off for a saved search the caller owns. Enabling
   * mints a fresh unguessable capability token (128 bits of entropy); disabling
   * clears it, which revokes any outstanding share links. Re-enabling always
   * rotates the token, so a previously shared link cannot be resurrected.
   *
   * The token is now the INVITATION only. What a reader may actually receive is
   * decided by the `ci.ask_grants` row `SharedSearchConsentService` mints for
   * them on first use, stamped with `posture.maxDisclosure` and
   * `posture.expiresAt` from here.
   *
   * TURNING SHARING OFF CLEARS THE POSTURE TOO. Leaving a stale ceiling behind
   * would mean a later re-share silently inherited a restriction the owner set
   * for a different link and a different audience — and, worse, the reverse:
   * an owner who had shared at `count` and re-shares expecting the default
   * would get their old cap or lose it depending on which field the mutation
   * happened to send. The posture belongs to the link, and the link is gone.
   */
  async setSharing(
    context: UserServiceContext,
    id: string,
    isPublic: boolean,
    posture: { maxDisclosure?: string | null; expiresAt?: Date | null } = {},
  ): Promise<SavedSearch | null> {
    const result = await this.savedSearchRepository.update(
      {
        id,
        userId: context.userId,
      },
      {
        isPublic,
        shareToken: isPublic ? crypto.randomBytes(16).toString('hex') : null,
        shareMaxDisclosure: isPublic ? (posture.maxDisclosure ?? null) : null,
        shareExpiresAt: isPublic ? (posture.expiresAt ?? null) : null,
      },
    );

    if (result.affected === 0) {
      return null;
    }

    return this.findById(context, id);
  }

  /**
   * Resolve a saved search by its share token. Not user-scoped — this is the
   * shared-viewer path: a signed-in viewer presents the token and the search is
   * run as the owner (see SearchResolver). Only public searches with a token
   * match, so clearing `isPublic` immediately stops resolution.
   */
  async findByShareToken(token: string, now: Date = new Date()): Promise<SavedSearch | null> {
    if (!token) {
      return null;
    }

    // A LAPSED LINK RESOLVES TO NOTHING, exactly like an unknown or revoked
    // one. The two-element `where` is an OR: no expiry, or an expiry still in
    // the future. Filtering in SQL rather than after the read is what keeps
    // "expired" and "never existed" indistinguishable to the caller — there is
    // no branch above that could accidentally report which it was.
    return this.savedSearchRepository.findOne({
      where: [
        { shareToken: token, isPublic: true, shareExpiresAt: IsNull() },
        { shareToken: token, isPublic: true, shareExpiresAt: MoreThan(now) },
      ],
    });
  }

  async remove(context: ServiceContext, id: string): Promise<boolean> {
    const result = await this.savedSearchRepository.delete({
      id,
      ...(context.userId !== SYSTEM_USER && {
        userId: context.userId,
      }),
    });

    if (result.affected === 0) {
      return false;
    }

    await this.eventService.send(SavedSearchDeletedEvent, {
      savedSearchId: id,
    });

    return true;
  }

  private assembleTags(data: CreateSavedSearchDto | UpdateSavedSearchDto): string[] {
    let match;
    const tags = [...new Set(data.tags || [])];

    do {
      match = TAG_REGEX.exec(data.query || '');
      if (match) {
        tags.push(match[1]);
      }
    } while (match);

    return tags;
  }
}

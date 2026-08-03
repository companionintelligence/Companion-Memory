import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { classifyParticipant } from '@ci/common/identifiers';
import { LoggerService } from '@ci/common/logging';
import { type Person, PersonService } from '@ci/domains/memory';

import { type PersonProfile } from '../entities/PersonProfileEntity';

import { PersonMergeService } from './PersonMergeService';

/** How a lookup hit was found — surfaced to agents so answers are explainable. */
export type LookupMatchKind = 'email' | 'phone' | 'handle' | 'name';

export interface PersonLookupHit {
  person: Person;
  matchedVia: LookupMatchKind;
  /** The identifier/handle/name value that matched. */
  matchedValue: string;
}

const PROFILE_SELECT = `
  profile_id AS "id", owner_user_id AS "ownerUserId", source_system AS "sourceSystem",
  remote_key AS "remoteKey", display_name AS "displayName", handle, avatar_url AS "avatarUrl",
  emails, phones, properties, person_entity_id AS "personEntityId",
  pinned_by_user AS "pinnedByUser", created_at AS "createdAt", updated_at AS "updatedAt"`;

/**
 * Read surface of the rebuilt people system — the single service every API
 * plane (GraphQL resolvers, agent tools, REST) delegates to, so they all
 * return the same answers.
 *
 * - Tombstone-aware person reads: a merged-away id resolves to its survivor,
 *   old links never 404.
 * - Assembled-profile reads: a person's source profiles and the deduped
 *   email/phone identifier sets across them.
 * - Identifier-aware lookup: "who is liam@x.com?" resolves via the identifier
 *   index and profile handles, not just entity names.
 */
@Injectable()
export class PeopleService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly personService: PersonService,
    private readonly personMergeService: PersonMergeService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PeopleService.name);
  }

  /**
   * Person by id, following merge tombstones. Returns the SURVIVOR when the
   * requested id was merged away (plus the canonical id, so callers can expose
   * the redirect).
   */
  async findByIdFollowingTombstone(
    context: UserServiceContext,
    id: string,
  ): Promise<{ person: Person; canonicalId: string } | null> {
    const person = await this.personService.findById(context, id);
    const mergedInto = await this.mergedInto(context.userId, id);

    if (mergedInto == null) {
      return person ? { person, canonicalId: id } : null;
    }

    const canonicalId = await this.personMergeService.resolveCanonicalEntityId(context.userId, id);
    const survivor = await this.personService.findById(context, canonicalId);

    return survivor ? { person: survivor, canonicalId } : null;
  }

  /** The `merged_into_entity_id` pointer of an entity, or null. */
  async mergedInto(ownerUserId: string, entityId: string): Promise<string | null> {
    const rows: Array<{ merged_into_entity_id: string | null }> = await this.dataSource.query(
      `SELECT merged_into_entity_id FROM ci.entities
        WHERE owner_user_id = $1 AND entity_id = $2`,
      [ownerUserId, entityId],
    );

    return rows[0]?.merged_into_entity_id ?? null;
  }

  /** Source profiles assembled into one person, oldest first. */
  async getProfilesForPerson(ownerUserId: string, personEntityId: string): Promise<PersonProfile[]> {
    return this.dataSource.query(
      `SELECT ${PROFILE_SELECT}
         FROM ci.person_profiles
        WHERE owner_user_id = $1 AND person_entity_id = $2
        ORDER BY created_at ASC`,
      [ownerUserId, personEntityId],
    );
  }

  async getProfileById(ownerUserId: string, profileId: string): Promise<PersonProfile | null> {
    const rows: PersonProfile[] = await this.dataSource.query(
      `SELECT ${PROFILE_SELECT}
         FROM ci.person_profiles
        WHERE owner_user_id = $1 AND profile_id = $2`,
      [ownerUserId, profileId],
    );

    return rows[0] ?? null;
  }

  /**
   * Deduped strong identifiers of a person: the union of the identifier-index
   * rows pointing at it and the arrays on its assembled profiles.
   */
  async getIdentifiersForPerson(
    ownerUserId: string,
    personEntityId: string,
  ): Promise<{ emails: string[]; phones: string[] }> {
    const rows: Array<{ kind: string; value: string }> = await this.dataSource.query(
      `SELECT kind, value_normalized AS value
         FROM ci.entity_identifiers
        WHERE owner_user_id = $1 AND entity_id = $2 AND kind IN ('email', 'phone')
       UNION
       SELECT 'email' AS kind, unnest(emails) AS value
         FROM ci.person_profiles
        WHERE owner_user_id = $1 AND person_entity_id = $2
       UNION
       SELECT 'phone' AS kind, unnest(phones) AS value
         FROM ci.person_profiles
        WHERE owner_user_id = $1 AND person_entity_id = $2`,
      [ownerUserId, personEntityId],
    );

    const emails = new Set<string>();
    const phones = new Set<string>();
    for (const row of rows) {
      (row.kind === 'email' ? emails : phones).add(row.value);
    }

    return { emails: [...emails].sort(), phones: [...phones].sort() };
  }

  /**
   * Identifier-aware person lookup — the primary agent entry point. The query
   * is classified with the shared participant rule (contains '@' -> email,
   * phone-shaped -> phone, else name/handle) and resolved against, in order:
   * the identifier index, profile handles/display names, then entity names
   * (substring, case-insensitive). Tombstones are followed; results dedupe to
   * canonical persons.
   */
  async lookup(
    context: UserServiceContext,
    query: string,
    options: { limit?: number } = {},
  ): Promise<PersonLookupHit[]> {
    const limit = Math.min(options.limit ?? 10, 50);
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      return [];
    }

    const classified = classifyParticipant(trimmed);
    const hits = new Map<string, { matchedVia: LookupMatchKind; matchedValue: string }>();

    // 1. Identifier index (exact, normalized).
    if (classified != null) {
      const rows: Array<{ entity_id: string }> = await this.dataSource.query(
        `SELECT i.entity_id
           FROM ci.entity_identifiers i
           JOIN ci.entities e ON e.entity_id = i.entity_id AND e.entity_type = 'Person'
          WHERE i.owner_user_id = $1 AND i.kind = $2 AND i.value_normalized = $3`,
        [context.userId, classified.kind, classified.valueNormalized],
      );
      for (const row of rows) {
        hits.set(row.entity_id, {
          matchedVia: classified.kind === 'name' ? 'name' : classified.kind,
          matchedValue: classified.valueNormalized,
        });
      }
    }

    // 2. Profile handles + display names (substring). Covers "hegemon" ->
    // the Discord profile of a person whose canonical name is Liam.
    if (hits.size < limit) {
      const rows: Array<{ person_entity_id: string; handle: string | null; display_name: string | null }> =
        await this.dataSource.query(
          `SELECT person_entity_id, handle, display_name
             FROM ci.person_profiles
            WHERE owner_user_id = $1
              AND person_entity_id IS NOT NULL
              AND (handle ILIKE $2 OR display_name ILIKE $2)
            LIMIT $3`,
          [context.userId, `%${escapeLike(trimmed)}%`, limit * 2],
        );
      for (const row of rows) {
        if (!hits.has(row.person_entity_id)) {
          hits.set(row.person_entity_id, {
            matchedVia: 'handle',
            matchedValue: row.handle ?? row.display_name ?? trimmed,
          });
        }
      }
    }

    // 3. Entity names (substring).
    if (hits.size < limit) {
      const rows: Array<{ entity_id: string; name: string | null }> = await this.dataSource.query(
        `SELECT entity_id, name FROM ci.entities
          WHERE owner_user_id = $1 AND entity_type = 'Person'
            AND merged_into_entity_id IS NULL
            AND name ILIKE $2
          ORDER BY length(name) ASC
          LIMIT $3`,
        [context.userId, `%${escapeLike(trimmed)}%`, limit * 2],
      );
      for (const row of rows) {
        if (!hits.has(row.entity_id)) {
          hits.set(row.entity_id, { matchedVia: 'name', matchedValue: row.name ?? trimmed });
        }
      }
    }

    // Resolve tombstones and hydrate, deduping to canonical persons.
    const canonicalMeta = new Map<string, { matchedVia: LookupMatchKind; matchedValue: string }>();
    for (const [entityId, meta] of hits) {
      const canonical = await this.personMergeService.resolveCanonicalEntityId(context.userId, entityId);
      if (!canonicalMeta.has(canonical)) {
        canonicalMeta.set(canonical, meta);
      }

      if (canonicalMeta.size >= limit) {
        break;
      }
    }

    const ids = [...canonicalMeta.keys()];
    const persons = await this.personService.findByIds(context, ids);

    const out: PersonLookupHit[] = [];
    for (let i = 0; i < ids.length; i += 1) {
      const person = persons[i];
      if (person != null) {
        const meta = canonicalMeta.get(ids[i])!;
        out.push({ person, matchedVia: meta.matchedVia, matchedValue: meta.matchedValue });
      }
    }

    return out;
  }
}

/** Escape LIKE wildcards in user input. */
function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, (char) => `\\${char}`);
}

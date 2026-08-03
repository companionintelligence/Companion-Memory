import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { type UserServiceContext } from '@ci/common/context';
import {
  normalizeEmail,
  normalizeName,
  normalizePhone,
  splitPersonName,
} from '@ci/common/identifiers';
import { LoggerService } from '@ci/common/logging';
import { EventService } from '@ci/domains/events';
// Deep import (not the barrel) so the graph domain can depend on this module
// without an import cycle: graph/index.ts -> GraphIngestService -> people.
import { PersonService } from '@ci/domains/memory';
import { PersonUpdatedEvent } from '@ci/domains/memory/events';

import { PersonMergeService } from './PersonMergeService';

/**
 * One observed source-profile: what a single source knows about someone.
 * Identifier fields are raw — normalization happens here with the shared rule.
 */
export interface ObservedProfileInput {
  /** e.g. 'google:contacts', 'discord', 'communications:participant', 'files:face', 'manual'. */
  sourceSystem: string;
  /** Stable per-source key (remote id, importer natural key, kind:value composite). */
  remoteKey: string;
  displayName?: string | null;
  handle?: string | null;
  avatarUrl?: string | null;
  /** Raw emails/phones — strong identifiers, drive create/attach/merge. */
  emails?: unknown;
  phones?: unknown;
  /** Raw display-name identifiers — indexed for lookup, never drive merges. */
  names?: unknown;
  /** Description for a Person created fresh (defaults to "Contact from <source>"). */
  description?: string | null;
  properties?: Record<string, unknown> | null;
  /**
   * Pre-resolved Person entity id when the caller already created/resolved the
   * entity (the graph-ingest path). Otherwise observeProfile creates or
   * attaches one itself.
   */
  personEntityId?: string;
}

export interface ObserveProfileResult {
  profileId: string;
  /** The canonical Person the profile resolved to. */
  personEntityId: string;
  /** A brand-new Person was created for this profile. */
  created: boolean;
  /** Persons consumed by identity chaining during this observation. */
  mergedEntityIds: string[];
}

interface UpsertedProfile {
  profile_id: string;
  person_entity_id: string | null;
  pinned_by_user: boolean;
  emails: string[];
  phones: string[];
  display_name: string | null;
}

/**
 * The single entry point every people-creation path funnels through
 * (issue #1810): upsert the source profile, index its identifiers, and resolve
 * it to a canonical Person — create (0 matches), attach (1 match), or
 * transitive-merge (a profile whose strong identifiers span 2+ Persons chains
 * them into one via {@link PersonMergeService}). Respects sticky user
 * corrections: `person_distinctions` rows block auto-merges and re-attachment
 * of detached profiles; `pinned_by_user` profiles never move automatically.
 *
 * Strong identifiers (email/phone) are person-equivalence edges; name
 * identifiers are indexed for lookup but NEVER drive merges (name-only matches
 * become duplicate suggestions instead — see PersonDuplicateSuggestionService).
 *
 * Replaces the find-or-create logic formerly scattered across PromoteService,
 * PersonStubBackfillService, and the per-source ETL transforms.
 */
@Injectable()
export class PeoplePromotionService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly personService: PersonService,
    private readonly personMergeService: PersonMergeService,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PeoplePromotionService.name);
  }

  /**
   * Observe one source-profile and resolve it to a canonical Person.
   * Idempotent on (owner, sourceSystem, remoteKey): re-observing updates the
   * profile in place and re-runs resolution (which may chain newly-shared
   * identifiers into a merge).
   */
  async observeProfile(
    context: UserServiceContext,
    input: ObservedProfileInput,
  ): Promise<ObserveProfileResult> {
    const ownerUserId = context.userId;

    const emails = normalizeAll(input.emails, normalizeEmail);
    const phones = normalizeAll(input.phones, normalizePhone);
    const names = normalizeAll(input.names, normalizeName);

    const profile = await this.upsertProfile(ownerUserId, input, emails, phones);

    // ---- Candidate resolution (strong identifiers only) ----
    const mergedEntityIds: string[] = [];

    // A pinned profile is a user decision: keep its person, index identifiers
    // to it, and skip all automatic moves/merges.
    if (profile.pinned_by_user && profile.person_entity_id != null) {
      const pinned = await this.personMergeService.resolveCanonicalEntityId(
        ownerUserId,
        profile.person_entity_id,
      );
      await this.indexIdentifiers(ownerUserId, pinned, emails, phones, names);

      return { profileId: profile.profile_id, personEntityId: pinned, created: false, mergedEntityIds };
    }

    const candidates = new Set<string>();

    for (const seed of [input.personEntityId, profile.person_entity_id]) {
      if (seed != null) {
        candidates.add(await this.personMergeService.resolveCanonicalEntityId(ownerUserId, seed));
      }
    }

    for (const match of await this.lookupStrongIdentifiers(ownerUserId, emails, phones)) {
      candidates.add(await this.personMergeService.resolveCanonicalEntityId(ownerUserId, match));
    }

    // Profile-level distinctions: never re-attach a profile the user detached.
    const detachedFrom = await this.detachedPersonIds(ownerUserId, profile.profile_id);
    for (const excluded of detachedFrom) {
      candidates.delete(excluded);
    }

    let personEntityId: string;
    let created = false;

    if (candidates.size === 0) {
      // 0 matches: create. linked (people:<source>, remoteKey) keeps creation
      // idempotent under retries without colliding with graph-ingest's
      // import:* namespace.
      const person = await this.personService.create(context, {
        name: displayNameOf(input, emails, phones),
        description: input.description ?? `Contact from ${input.sourceSystem}`,
        linkedTable: `people:${input.sourceSystem}`,
        linkedId: input.remoteKey,
        properties: buildPersonProperties(input, emails, phones, names),
      });
      personEntityId = person.id;
      created = true;
    } else {
      // 1+ matches: attach to a winner; 2+ means this profile's identifiers
      // span multiple Persons — the transitive chain — so merge the rest in.
      const ordered = [...candidates];
      const preferred =
        (input.personEntityId != null &&
          ordered.find(
            (c) => c === input.personEntityId || c === profile.person_entity_id,
          )) ||
        undefined;
      // Stable winner: preferred (caller/profile-linked) else oldest (uuid7 is
      // time-ordered, so the smallest id is the earliest-created person).
      personEntityId = preferred ?? ordered.sort()[0];

      for (const other of ordered) {
        if (other === personEntityId) {
          continue;
        }

        const result = await this.personMergeService.merge(ownerUserId, personEntityId, other, {
          initiator: 'auto',
        });
        if (result.merged) {
          mergedEntityIds.push(other);
        }
      }

      await this.enrichPerson(ownerUserId, personEntityId, input, emails, phones);
    }

    // Point the profile at its person and index identifiers to it.
    await this.dataSource.query(
      `UPDATE ci.person_profiles SET person_entity_id = $3, updated_at = now()
        WHERE owner_user_id = $1 AND profile_id = $2`,
      [ownerUserId, profile.profile_id, personEntityId],
    );
    await this.indexIdentifiers(ownerUserId, personEntityId, emails, phones, names);

    return { profileId: profile.profile_id, personEntityId, created, mergedEntityIds };
  }

  /**
   * Bulk companion for the graph-ingest path: the entities are already
   * upserted (and their identifiers indexed first-wins), so this (1) upserts
   * one profile per ingested Person keyed by the importer's natural key, and
   * (2) detects strong-identifier collisions — a value whose index row points
   * at a DIFFERENT Person than the one carrying it — and auto-merges each
   * pair (distinctions respected inside merge). One lookup query for the whole
   * batch; merges only run when identities actually collapse.
   */
  async observeIngestedPeople(
    ownerUserId: string,
    entries: Array<{
      entityId: string;
      key: string;
      sourceSystem: string;
      name?: string | null;
      properties?: Record<string, unknown> | null;
    }>,
  ): Promise<{ profilesUpserted: number; merges: number }> {
    if (entries.length === 0) {
      return { profilesUpserted: 0, merges: 0 };
    }

    // 1. Profiles, one per ingested Person.
    let profilesUpserted = 0;
    for (const entry of entries) {
      const emails = normalizeAll(entry.properties?.emails, normalizeEmail);
      const phones = normalizeAll(entry.properties?.phones, normalizePhone);
      await this.upsertProfile(
        ownerUserId,
        {
          sourceSystem: entry.sourceSystem,
          remoteKey: entry.key,
          displayName: entry.name ?? null,
          properties: entry.properties ?? null,
          personEntityId: entry.entityId,
        },
        emails,
        phones,
      );
      profilesUpserted += 1;
    }

    // 2. Identity chaining: for every strong identifier in the batch, find
    // where the index points; a pointer at a different Person is a merge pair.
    const claims = new Map<string, Set<string>>(); // `${kind}:${value}` -> entity ids carrying it
    for (const entry of entries) {
      const emails = normalizeAll(entry.properties?.emails, normalizeEmail);
      const phones = normalizeAll(entry.properties?.phones, normalizePhone);
      for (const value of emails) {
        addToSetMap(claims, `email:${value}`, entry.entityId);
      }

      for (const value of phones) {
        addToSetMap(claims, `phone:${value}`, entry.entityId);
      }
    }

    if (claims.size === 0) {
      return { profilesUpserted, merges: 0 };
    }

    const pointers = await this.lookupIndexPointers(ownerUserId, [...claims.keys()]);

    // Union the collision pairs into groups, then merge each group into its
    // canonical (oldest) member.
    const pairs: Array<[string, string]> = [];
    for (const [composite, carriers] of claims) {
      const pointed = pointers.get(composite);
      const all = new Set(carriers);
      if (pointed != null) {
        all.add(pointed);
      }

      if (all.size > 1) {
        const list = [...all].sort();
        for (let i = 1; i < list.length; i += 1) {
          pairs.push([list[0], list[i]]);
        }
      }
    }

    let merges = 0;
    for (const [a, b] of pairs) {
      const winner = await this.personMergeService.resolveCanonicalEntityId(ownerUserId, a);
      const loser = await this.personMergeService.resolveCanonicalEntityId(ownerUserId, b);
      if (winner === loser) {
        continue;
      }

      const result = await this.personMergeService.merge(ownerUserId, winner, loser, {
        initiator: 'auto',
      });
      if (result.merged) {
        merges += 1;
      }
    }

    return { profilesUpserted, merges };
  }

  /**
   * Detach a profile from its person: the profile moves to a fresh Person and
   * a profile/person distinction pins it away from the old one (the sticky
   * "these are NOT the same" correction). Returns the new person's entity id.
   */
  async detachProfile(
    context: UserServiceContext,
    profileId: string,
  ): Promise<{ profileId: string; personEntityId: string } | null> {
    const ownerUserId = context.userId;

    const rows: Array<{
      profile_id: string;
      person_entity_id: string | null;
      source_system: string;
      remote_key: string;
      display_name: string | null;
      handle: string | null;
      avatar_url: string | null;
      emails: string[];
      phones: string[];
      properties: Record<string, unknown>;
    }> = await this.dataSource.query(
      `SELECT profile_id, person_entity_id, source_system, remote_key, display_name,
              handle, avatar_url, emails, phones, properties
         FROM ci.person_profiles
        WHERE owner_user_id = $1 AND profile_id = $2`,
      [ownerUserId, profileId],
    );

    const profile = rows[0];
    if (!profile) {
      return null;
    }

    const previousPersonId = profile.person_entity_id;

    // Fresh Person for the detached profile.
    const person = await this.personService.create(context, {
      name: profile.display_name ?? profile.handle ?? profile.emails[0] ?? profile.phones[0] ?? 'Unknown',
      description: `Contact from ${profile.source_system}`,
      linkedTable: `people:detached`,
      linkedId: profile.profile_id,
      properties: {
        ...(profile.emails.length > 0 ? { emails: profile.emails } : {}),
        ...(profile.phones.length > 0 ? { phones: profile.phones } : {}),
        contact_type: profile.source_system,
      },
    });

    await this.dataSource.query(
      `UPDATE ci.person_profiles
          SET person_entity_id = $3, pinned_by_user = TRUE, updated_at = now()
        WHERE owner_user_id = $1 AND profile_id = $2`,
      [ownerUserId, profileId, person.id],
    );

    if (previousPersonId != null) {
      // Sticky corrections: never re-attach this profile to the old person,
      // and never auto-merge the new person back into it.
      await this.dataSource.query(
        `INSERT INTO ci.person_distinctions (distinction_id, owner_user_id, entity_id_a, profile_id, reason)
         VALUES ($1, $2, $3, $4, 'detach')
         ON CONFLICT DO NOTHING`,
        [uuid7(), ownerUserId, previousPersonId, profileId],
      );
      const [a, b] = previousPersonId < person.id ? [previousPersonId, person.id] : [person.id, previousPersonId];
      await this.dataSource.query(
        `INSERT INTO ci.person_distinctions (distinction_id, owner_user_id, entity_id_a, entity_id_b, reason)
         VALUES ($1, $2, $3, $4, 'detach')
         ON CONFLICT DO NOTHING`,
        [uuid7(), ownerUserId, a, b],
      );

      // Repoint the profile's own identifiers at the new person so lookups
      // resolve to it. Only values this profile actually carries move.
      const identifierMoves: Array<[string, string]> = [
        ...profile.emails.map((value): [string, string] => ['email', value]),
        ...profile.phones.map((value): [string, string] => ['phone', value]),
      ];
      for (const [kind, value] of identifierMoves) {
        await this.dataSource.query(
          `UPDATE ci.entity_identifiers SET entity_id = $4
            WHERE owner_user_id = $1 AND kind = $2 AND value_normalized = $3 AND entity_id = $5`,
          [ownerUserId, kind, value, person.id, previousPersonId],
        );
      }

      await this.eventService.send(PersonUpdatedEvent, { personId: previousPersonId });
    }

    this.logger.log('Detached profile', { ownerUserId, profileId, newPersonId: person.id });

    return { profileId, personEntityId: person.id };
  }

  // ---------------------------------------------------------------- helpers

  /** Idempotent profile upsert on (owner, source_system, remote_key). */
  private async upsertProfile(
    ownerUserId: string,
    input: ObservedProfileInput,
    emails: string[],
    phones: string[],
  ): Promise<UpsertedProfile> {
    const rows: UpsertedProfile[] = await this.dataSource.query(
      `INSERT INTO ci.person_profiles
         (profile_id, owner_user_id, source_system, remote_key, display_name, handle,
          avatar_url, emails, phones, properties, person_entity_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
       ON CONFLICT (owner_user_id, source_system, remote_key) DO UPDATE SET
         display_name = COALESCE(EXCLUDED.display_name, ci.person_profiles.display_name),
         handle       = COALESCE(EXCLUDED.handle, ci.person_profiles.handle),
         avatar_url   = COALESCE(EXCLUDED.avatar_url, ci.person_profiles.avatar_url),
         emails       = (SELECT COALESCE(array_agg(DISTINCT e), '{}')
                           FROM unnest(ci.person_profiles.emails || EXCLUDED.emails) AS e),
         phones       = (SELECT COALESCE(array_agg(DISTINCT p), '{}')
                           FROM unnest(ci.person_profiles.phones || EXCLUDED.phones) AS p),
         properties   = ci.person_profiles.properties || EXCLUDED.properties,
         person_entity_id = CASE
           WHEN ci.person_profiles.pinned_by_user THEN ci.person_profiles.person_entity_id
           ELSE COALESCE(ci.person_profiles.person_entity_id, EXCLUDED.person_entity_id)
         END,
         updated_at = now()
       RETURNING profile_id, person_entity_id, pinned_by_user, emails, phones, display_name`,
      [
        uuid7(),
        ownerUserId,
        input.sourceSystem,
        input.remoteKey,
        emptyToNull(input.displayName),
        emptyToNull(input.handle),
        emptyToNull(input.avatarUrl),
        emails,
        phones,
        JSON.stringify(input.properties ?? {}),
        input.personEntityId ?? null,
      ],
    );

    return rows[0];
  }

  /** Resolve strong identifiers against ci.entity_identifiers. */
  private async lookupStrongIdentifiers(
    ownerUserId: string,
    emails: string[],
    phones: string[],
  ): Promise<string[]> {
    const composites = [
      ...emails.map((value) => `email:${value}`),
      ...phones.map((value) => `phone:${value}`),
    ];
    if (composites.length === 0) {
      return [];
    }

    const pointers = await this.lookupIndexPointers(ownerUserId, composites);

    return [...new Set(pointers.values())];
  }

  /** Batched `${kind}:${value}` -> entity_id lookup (Persons only). */
  private async lookupIndexPointers(
    ownerUserId: string,
    composites: string[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (composites.length === 0) {
      return out;
    }

    const params: unknown[] = [ownerUserId];
    const placeholders = composites
      .map((composite) => {
        const sep = composite.indexOf(':');
        params.push(composite.slice(0, sep), composite.slice(sep + 1));

        return `($${params.length - 1}, $${params.length})`;
      })
      .join(', ');

    const rows: Array<{ kind: string; value_normalized: string; entity_id: string }> =
      await this.dataSource.query(
        `SELECT i.kind, i.value_normalized, i.entity_id
           FROM ci.entity_identifiers i
           JOIN ci.entities e ON e.entity_id = i.entity_id AND e.entity_type = 'Person'
          WHERE i.owner_user_id = $1
            AND (i.kind, i.value_normalized) IN (${placeholders})`,
        params,
      );

    for (const row of rows) {
      out.set(`${row.kind}:${row.value_normalized}`, row.entity_id);
    }

    return out;
  }

  /** Person ids this profile was explicitly detached from (never re-attach). */
  private async detachedPersonIds(ownerUserId: string, profileId: string): Promise<string[]> {
    const rows: Array<{ entity_id_a: string }> = await this.dataSource.query(
      `SELECT entity_id_a FROM ci.person_distinctions
        WHERE owner_user_id = $1 AND profile_id = $2`,
      [ownerUserId, profileId],
    );

    return rows.map((row) => row.entity_id_a);
  }

  /** ON CONFLICT DO NOTHING identifier upsert (first-wins, per the index contract). */
  private async indexIdentifiers(
    ownerUserId: string,
    entityId: string,
    emails: string[],
    phones: string[],
    names: string[],
  ): Promise<void> {
    const rows: Array<[string, string]> = [
      ...emails.map((value): [string, string] => ['email', value]),
      ...phones.map((value): [string, string] => ['phone', value]),
      ...names.map((value): [string, string] => ['name', value]),
    ];
    if (rows.length === 0) {
      return;
    }

    const params: unknown[] = [ownerUserId, entityId];
    const values = rows
      .map(([kind, value]) => {
        params.push(kind, value);

        return `($1, $2, $${params.length - 1}, $${params.length})`;
      })
      .join(', ');

    await this.dataSource.query(
      `INSERT INTO ci.entity_identifiers (owner_user_id, entity_id, kind, value_normalized)
       VALUES ${values}
       ON CONFLICT DO NOTHING`,
      params,
    );
  }

  /**
   * Light enrichment of an attached-to Person: fill a missing name and union
   * the identifier arrays in properties, so the canonical row reflects every
   * profile assembled into it. Skips the write (and event) when nothing new.
   */
  private async enrichPerson(
    ownerUserId: string,
    entityId: string,
    input: ObservedProfileInput,
    emails: string[],
    phones: string[],
  ): Promise<void> {
    const rows: Array<{ name: string | null; properties: Record<string, unknown> }> =
      await this.dataSource.query(
        `SELECT name, properties FROM ci.entities
          WHERE owner_user_id = $1 AND entity_id = $2`,
        [ownerUserId, entityId],
      );
    const row = rows[0];
    if (!row) {
      return;
    }

    const props = row.properties ?? {};
    const nextEmails = union(readStringArray(props.emails), emails);
    const nextPhones = union(readStringArray(props.phones), phones);
    const displayName = displayNameOf(input, emails, phones);
    const nextName = row.name && row.name.trim().length > 0 ? row.name : displayName;

    const changed =
      nextEmails.length !== readStringArray(props.emails).length ||
      nextPhones.length !== readStringArray(props.phones).length ||
      nextName !== row.name;
    if (!changed) {
      return;
    }

    const nextProps = { ...props };
    if (nextEmails.length > 0) {
      nextProps.emails = nextEmails;
    }

    if (nextPhones.length > 0) {
      nextProps.phones = nextPhones;
    }

    await this.dataSource.query(
      `UPDATE ci.entities SET properties = $3::jsonb, name = $4, updated_at = now()
        WHERE owner_user_id = $1 AND entity_id = $2`,
      [ownerUserId, entityId, JSON.stringify(nextProps), nextName],
    );

    await this.eventService.send(PersonUpdatedEvent, { personId: entityId });
  }
}

/** Normalize a raw string-or-array value with the given rule, dropping unusable entries. */
function normalizeAll(value: unknown, normalize: (raw: string) => string | null): string[] {
  const out = new Set<string>();
  for (const raw of readStringArray(value)) {
    const normalized = normalize(raw);
    if (normalized != null) {
      out.add(normalized);
    }
  }

  return [...out];
}

function readStringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }

  return [];
}

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();

  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/** Best display name for a person created from this profile. */
function displayNameOf(input: ObservedProfileInput, emails: string[], phones: string[]): string {
  return (
    emptyToNull(input.displayName) ??
    emptyToNull(input.handle) ??
    emails[0] ??
    phones[0] ??
    'Unknown'
  );
}

/** Properties for a Person created fresh from a profile. */
function buildPersonProperties(
  input: ObservedProfileInput,
  emails: string[],
  phones: string[],
  names: string[],
): Record<string, unknown> {
  const nameParts = splitPersonName(displayNameOf(input, emails, phones));

  return {
    ...(input.properties ?? {}),
    ...(emails.length > 0 ? { emails } : {}),
    ...(phones.length > 0 ? { phones } : {}),
    ...(names.length > 0 ? { names } : {}),
    ...(nameParts ?? {}),
    contact_type: input.sourceSystem,
  };
}

function addToSetMap(map: Map<string, Set<string>>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing) {
    existing.add(value);
  } else {
    map.set(key, new Set([value]));
  }
}

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import {
  normalizeEmail,
  normalizeName,
  normalizePhone,
} from '@ci/common/identifiers';
import { LoggerService } from '@ci/common/logging';

import { PersonDuplicateSuggestionService } from './PersonDuplicateSuggestionService';
import { PersonMergeService } from './PersonMergeService';

/** Page size for the person scan (keyset on entity_id). */
const SCAN_PAGE_SIZE = 2000;

export interface PeopleDedupeOptions {
  /** Skip the weak-signal suggestion sweep at the end (default: run it). */
  skipSuggestions?: boolean;
}

export interface PeopleDedupeResult {
  peopleScanned: number;
  profilesUpserted: number;
  identifiersIndexed: number;
  /** Groups of persons found sharing a strong identifier. */
  duplicateGroups: number;
  /** Persons actually merged away (tombstoned). */
  merged: number;
  /** New weak-signal suggestions written by the closing sweep. */
  suggestionsCreated: number;
  errors: string[];
}

interface PersonScanRow {
  entity_id: string;
  name: string | null;
  linked_table: string | null;
  linked_id: string | null;
  properties: Record<string, unknown>;
}

/**
 * One-shot maintenance pass that retrofits the profile layer onto an existing
 * corpus and runs the dedupe the old system never could (issue #1810).
 * Existing per-source Person entities — "liam from discord", "liam from
 * google" — ARE the profiles: each row's import provenance
 * (linked_table/linked_id) becomes a `ci.person_profiles` row, its raw
 * emails/phones re-index into `ci.entity_identifiers`, and persons sharing a
 * strong identifier merge into one canonical Person (oldest wins, distinctions
 * respected, losers tombstoned). Closes with the weak-signal name sweep so
 * near-misses land as suggestions.
 *
 * Idempotent: profiles upsert on their provenance key, identifiers on the
 * index's unique tuple, and already-merged persons resolve to their survivor.
 * Operator-invoked via POST /api/maintenance/dedupe-people or the
 * orchestrator's `dedupe_people` leg.
 */
@Injectable()
export class PeopleBackfillService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly personMergeService: PersonMergeService,
    private readonly suggestionService: PersonDuplicateSuggestionService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PeopleBackfillService.name);
  }

  async dedupe(userId: string, options: PeopleDedupeOptions = {}): Promise<PeopleDedupeResult> {
    let peopleScanned = 0;
    let profilesUpserted = 0;
    let identifiersIndexed = 0;
    const errors: string[] = [];

    // `${kind}:${value}` -> entity ids carrying that strong identifier.
    const strongValues = new Map<string, Set<string>>();

    let cursor = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const page: PersonScanRow[] = await this.dataSource.query(
        `SELECT entity_id, name, linked_table, linked_id, properties
           FROM ci.entities
          WHERE owner_user_id = $1
            AND entity_type = 'Person'
            AND merged_into_entity_id IS NULL
            AND entity_id > $2
          ORDER BY entity_id ASC
          LIMIT $3`,
        [userId, cursor, SCAN_PAGE_SIZE],
      );

      if (page.length === 0) {
        break;
      }

      cursor = page[page.length - 1].entity_id;
      peopleScanned += page.length;

      try {
        profilesUpserted += await this.upsertProfilesForPage(userId, page);
        identifiersIndexed += await this.indexIdentifiersForPage(userId, page);
      } catch (err) {
        errors.push((err as Error).message);
      }

      for (const row of page) {
        for (const value of extractEmails(row)) {
          addToSetMap(strongValues, `email:${value}`, row.entity_id);
        }

        for (const value of extractPhones(row)) {
          addToSetMap(strongValues, `phone:${value}`, row.entity_id);
        }
      }
    }

    // Dedupe: merge each strong-identifier group into its oldest member.
    // resolveCanonicalEntityId keeps chains correct as groups overlap (person
    // A merged in the email group is followed to its survivor in the phone
    // group).
    let duplicateGroups = 0;
    let merged = 0;
    for (const [composite, ids] of strongValues) {
      if (ids.size < 2) {
        continue;
      }

      duplicateGroups += 1;
      const ordered = [...ids].sort(); // uuid7: smallest = oldest
      try {
        const winner = await this.personMergeService.resolveCanonicalEntityId(userId, ordered[0]);
        for (const id of ordered.slice(1)) {
          const loser = await this.personMergeService.resolveCanonicalEntityId(userId, id);
          if (loser === winner) {
            continue;
          }

          const result = await this.personMergeService.merge(userId, winner, loser, {
            initiator: 'auto',
          });
          if (result.merged) {
            merged += 1;
          }
        }
      } catch (err) {
        errors.push(`${composite}: ${(err as Error).message}`);
      }
    }

    let suggestionsCreated = 0;
    if (options.skipSuggestions !== true) {
      try {
        const sweep = await this.suggestionService.generate(userId);
        suggestionsCreated = sweep.suggestionsCreated;
      } catch (err) {
        errors.push(`suggestion sweep: ${(err as Error).message}`);
      }
    }

    this.logger.log('People dedupe pass complete', {
      userId,
      peopleScanned,
      profilesUpserted,
      identifiersIndexed,
      duplicateGroups,
      merged,
      suggestionsCreated,
      errors: errors.length,
    });

    return {
      peopleScanned,
      profilesUpserted,
      identifiersIndexed,
      duplicateGroups,
      merged,
      suggestionsCreated,
      errors,
    };
  }

  /**
   * One profile per person with import provenance; the provenance key
   * (linked_table minus its 'import:'/'people:' prefix, linked_id) becomes the
   * profile's (source_system, remote_key). ON CONFLICT DO NOTHING: profiles
   * the live promotion path already owns are never clobbered.
   */
  private async upsertProfilesForPage(userId: string, page: PersonScanRow[]): Promise<number> {
    const params: unknown[] = [userId];
    const tuples: string[] = [];

    for (const row of page) {
      if (!row.linked_table || !row.linked_id) {
        continue;
      }

      const emails = extractEmails(row);
      const phones = extractPhones(row);
      params.push(
        uuid7(),
        sourceSystemOf(row.linked_table),
        row.linked_id,
        row.name,
        avatarUrlOf(row),
        emails,
        phones,
        row.entity_id,
      );
      const base = params.length - 8;
      tuples.push(
        `($${base + 1}, $1, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`,
      );
    }

    if (tuples.length === 0) {
      return 0;
    }

    const result: Array<{ profile_id: string }> = await this.dataSource.query(
      `INSERT INTO ci.person_profiles
         (profile_id, owner_user_id, source_system, remote_key, display_name, avatar_url,
          emails, phones, person_entity_id)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (owner_user_id, source_system, remote_key) DO NOTHING
       RETURNING profile_id`,
      params,
    );

    return result.length;
  }

  /** Re-index the page's strong + name identifiers (ON CONFLICT DO NOTHING). */
  private async indexIdentifiersForPage(userId: string, page: PersonScanRow[]): Promise<number> {
    const params: unknown[] = [userId];
    const tuples: string[] = [];
    const seen = new Set<string>();

    for (const row of page) {
      const push = (kind: string, value: string) => {
        const composite = `${kind}:${value}`;
        if (seen.has(composite)) {
          return;
        }

        seen.add(composite);
        params.push(row.entity_id, kind, value);
        const base = params.length - 3;
        tuples.push(`($1, $${base + 1}, $${base + 2}, $${base + 3})`);
      };

      for (const value of extractEmails(row)) {
        push('email', value);
      }

      for (const value of extractPhones(row)) {
        push('phone', value);
      }

      const name = normalizeName(row.name);
      if (name != null) {
        push('name', name);
      }
    }

    if (tuples.length === 0) {
      return 0;
    }

    const result: Array<{ entity_id: string }> = await this.dataSource.query(
      `INSERT INTO ci.entity_identifiers (owner_user_id, entity_id, kind, value_normalized)
       VALUES ${tuples.join(', ')}
       ON CONFLICT DO NOTHING
       RETURNING entity_id`,
      params,
    );

    return result.length;
  }
}

/** 'import:google:contacts' -> 'google:contacts'; 'people:manual' -> 'manual'. */
function sourceSystemOf(linkedTable: string): string {
  return linkedTable.replace(/^(import|people):/, '');
}

/**
 * A person's raw emails: the `emails: string[]` contract shape plus the legacy
 * singular `email` some writers (PromoteService) used. Google's `{value,type}`
 * object shape is unwrapped too. All normalized with the shared rule.
 */
function extractEmails(row: PersonScanRow): string[] {
  return normalizeAll(collectRaw(row.properties, ['emails', 'email']), normalizeEmail);
}

function extractPhones(row: PersonScanRow): string[] {
  return normalizeAll(collectRaw(row.properties, ['phones', 'phone', 'phone_number']), normalizePhone);
}

function avatarUrlOf(row: PersonScanRow): string | null {
  const value = row.properties?.avatar_url;

  return typeof value === 'string' && value.length > 0 ? value : null;
}

function collectRaw(properties: Record<string, unknown>, keys: string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const value = properties?.[key];
    if (typeof value === 'string') {
      out.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') {
          out.push(item);
        } else if (item != null && typeof item === 'object' && typeof (item as { value?: unknown }).value === 'string') {
          // Google contacts export emails as {value, type} objects.
          out.push((item as { value: string }).value);
        }
      }
    }
  }

  return out;
}

function normalizeAll(values: string[], normalize: (raw: string) => string | null): string[] {
  const out = new Set<string>();
  for (const raw of values) {
    const normalized = normalize(raw);
    if (normalized != null) {
      out.add(normalized);
    }
  }

  return [...out];
}

function addToSetMap(map: Map<string, Set<string>>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing) {
    existing.add(value);
  } else {
    map.set(key, new Set([value]));
  }
}

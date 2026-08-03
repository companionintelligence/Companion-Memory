import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { type UserServiceContext } from '@ci/common/context';
import { normalizeName } from '@ci/common/identifiers';
import { LoggerService } from '@ci/common/logging';

import { type PersonDuplicateSuggestion } from '../entities/PersonDuplicateSuggestionEntity';

import { PersonMergeService } from './PersonMergeService';

/** Confidence assigned per signal kind. */
const CONFIDENCE = {
  /** Two persons whose full normalized names are byte-identical. */
  exactName: 0.75,
  /** Unambiguous token-subset relation ("Priya" <-> "Priya Sharma"). */
  nameVariant: 0.5,
} as const;

export interface GenerateSuggestionsResult {
  peopleScanned: number;
  suggestionsCreated: number;
}

interface PersonNameRow {
  entity_id: string;
  name: string | null;
}

/**
 * Weak-signal duplicate detection: name collisions and name-variant subsets
 * between Persons that share NO strong identifier (those auto-merge in
 * promotion instead). Never merges — writes `person_duplicate_suggestions`
 * rows a user confirms (mergePersons) or rejects. Rejecting writes a
 * person/person distinction so the pair is never suggested or auto-merged
 * again.
 *
 * The variant matcher is the same unambiguous token-subset rule
 * MemoryCompactionService used inline (resolvePersonVariant), moved here so
 * compaction can stop deciding identity questions on its own.
 */
@Injectable()
export class PersonDuplicateSuggestionService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly personMergeService: PersonMergeService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PersonDuplicateSuggestionService.name);
  }

  /**
   * Scan the user's (live, non-tombstoned) Persons and upsert pending
   * suggestions for exact-normalized-name collisions and unambiguous name
   * variants. Idempotent: existing pairs are skipped (a 'stale' pair is
   * revived to pending; 'rejected'/'accepted' stay settled). Distinction
   * pairs are never suggested.
   */
  async generate(ownerUserId: string): Promise<GenerateSuggestionsResult> {
    const rows: PersonNameRow[] = await this.dataSource.query(
      `SELECT entity_id, name FROM ci.entities
        WHERE owner_user_id = $1
          AND entity_type = 'Person'
          AND merged_into_entity_id IS NULL
          AND name IS NOT NULL AND btrim(name) <> ''`,
      [ownerUserId],
    );

    const pairs = new Map<string, { a: string; b: string; confidence: number; signals: object }>();

    const addPair = (x: string, y: string, confidence: number, signals: object) => {
      const [a, b] = x < y ? [x, y] : [y, x];
      const key = `${a}:${b}`;
      const existing = pairs.get(key);
      if (!existing || existing.confidence < confidence) {
        pairs.set(key, { a, b, confidence, signals });
      }
    };

    // 1. Exact normalized-name collisions ("liam broza" x2).
    const byNormalized = new Map<string, PersonNameRow[]>();
    for (const row of rows) {
      if (isRelationalDescriptor(row.name ?? '')) {
        continue;
      }

      const normalized = normalizeName(row.name);
      if (normalized == null) {
        continue;
      }

      const bucket = byNormalized.get(normalized);
      if (bucket) {
        bucket.push(row);
      } else {
        byNormalized.set(normalized, [row]);
      }
    }

    for (const [value, bucket] of byNormalized) {
      if (bucket.length < 2 || bucket.length > 8) {
        // >8 identical names is a degenerate corpus (e.g. "Unknown") — pairing
        // it explodes quadratically and none of the pairs are meaningful.
        continue;
      }

      for (let i = 0; i < bucket.length; i += 1) {
        for (let j = i + 1; j < bucket.length; j += 1) {
          addPair(bucket[i].entity_id, bucket[j].entity_id, CONFIDENCE.exactName, {
            kind: 'exact-name',
            value,
          });
        }
      }
    }

    // 2. Unambiguous token-subset variants ("Priya" <-> "Priya Sharma").
    // A candidate matches when one token set strictly contains the other and
    // exactly ONE candidate fits — several fits mean ambiguity, no suggestion.
    const tokenized = [...byNormalized.entries()].map(([normalized, bucket]) => ({
      normalized,
      tokens: new Set(normalized.split(' ')),
      bucket,
    }));

    for (const source of tokenized) {
      const matches = tokenized.filter((candidate) => {
        if (candidate === source || setsEqual(candidate.tokens, source.tokens)) {
          return false;
        }

        return isSubset(source.tokens, candidate.tokens);
      });

      if (matches.length !== 1) {
        continue;
      }

      const target = matches[0];
      for (const a of source.bucket) {
        for (const b of target.bucket) {
          addPair(a.entity_id, b.entity_id, CONFIDENCE.nameVariant, {
            kind: 'name-variant',
            from: source.normalized,
            to: target.normalized,
          });
        }
      }
    }

    // Upsert, skipping distinction pairs. ON CONFLICT revives only stale rows.
    let suggestionsCreated = 0;
    for (const { a, b, confidence, signals } of pairs.values()) {
      const distinct: Array<{ exists: boolean }> = await this.dataSource.query(
        `SELECT TRUE AS exists FROM ci.person_distinctions
          WHERE owner_user_id = $1 AND entity_id_a = $2 AND entity_id_b = $3 LIMIT 1`,
        [ownerUserId, a, b],
      );
      if (distinct.length > 0) {
        continue;
      }

      const inserted: Array<{ suggestion_id: string }> = await this.dataSource.query(
        `INSERT INTO ci.person_duplicate_suggestions
           (suggestion_id, owner_user_id, entity_id_a, entity_id_b, confidence, signals, status)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'pending')
         ON CONFLICT (owner_user_id, entity_id_a, entity_id_b) DO UPDATE SET
           status = 'pending',
           confidence = EXCLUDED.confidence,
           signals = EXCLUDED.signals,
           updated_at = now()
         WHERE ci.person_duplicate_suggestions.status = 'stale'
         RETURNING suggestion_id`,
        [uuid7(), ownerUserId, a, b, confidence, JSON.stringify(signals)],
      );
      suggestionsCreated += inserted.length;
    }

    this.logger.log('Duplicate suggestion sweep complete', {
      ownerUserId,
      peopleScanned: rows.length,
      candidatePairs: pairs.size,
      suggestionsCreated,
    });

    return { peopleScanned: rows.length, suggestionsCreated };
  }

  /** Pending suggestions, newest first. */
  async listPending(
    ownerUserId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<{ suggestions: PersonDuplicateSuggestion[]; totalCount: number }> {
    const limit = Math.min(options.limit ?? 50, 200);
    const offset = options.offset ?? 0;

    const [rows, countRows] = await Promise.all([
      this.dataSource.query(
        `SELECT suggestion_id AS id, owner_user_id AS "ownerUserId",
                entity_id_a AS "entityIdA", entity_id_b AS "entityIdB",
                confidence, signals, status,
                created_at AS "createdAt", updated_at AS "updatedAt"
           FROM ci.person_duplicate_suggestions
          WHERE owner_user_id = $1 AND status = 'pending'
          ORDER BY confidence DESC, created_at DESC
          LIMIT $2 OFFSET $3`,
        [ownerUserId, limit, offset],
      ),
      this.dataSource.query(
        `SELECT COUNT(*)::int AS count FROM ci.person_duplicate_suggestions
          WHERE owner_user_id = $1 AND status = 'pending'`,
        [ownerUserId],
      ),
    ]);

    return { suggestions: rows, totalCount: countRows[0]?.count ?? 0 };
  }

  async findById(ownerUserId: string, suggestionId: string): Promise<PersonDuplicateSuggestion | null> {
    const rows: PersonDuplicateSuggestion[] = await this.dataSource.query(
      `SELECT suggestion_id AS id, owner_user_id AS "ownerUserId",
              entity_id_a AS "entityIdA", entity_id_b AS "entityIdB",
              confidence, signals, status,
              created_at AS "createdAt", updated_at AS "updatedAt"
         FROM ci.person_duplicate_suggestions
        WHERE owner_user_id = $1 AND suggestion_id = $2`,
      [ownerUserId, suggestionId],
    );

    return rows[0] ?? null;
  }

  /**
   * Confirm a suggestion: merge b into a (a, the smaller/older id, survives).
   * The merge itself marks the suggestion accepted (settleSuggestions).
   * Returns the surviving person's entity id, or null when the suggestion
   * doesn't exist / isn't pending.
   */
  async accept(context: UserServiceContext, suggestionId: string): Promise<string | null> {
    const suggestion = await this.findById(context.userId, suggestionId);
    if (!suggestion || suggestion.status !== 'pending') {
      return null;
    }

    const result = await this.personMergeService.merge(
      context.userId,
      suggestion.entityIdA,
      suggestion.entityIdB,
      { initiator: 'user' },
    );

    return result.winnerEntityId;
  }

  /**
   * Reject a suggestion: mark it rejected AND write the person/person
   * distinction so the pair is never suggested or auto-merged again.
   */
  async reject(context: UserServiceContext, suggestionId: string): Promise<boolean> {
    const suggestion = await this.findById(context.userId, suggestionId);
    if (!suggestion || suggestion.status !== 'pending') {
      return false;
    }

    await this.dataSource.query(
      `UPDATE ci.person_duplicate_suggestions SET status = 'rejected', updated_at = now()
        WHERE owner_user_id = $1 AND suggestion_id = $2`,
      [context.userId, suggestionId],
    );
    await this.dataSource.query(
      `INSERT INTO ci.person_distinctions (distinction_id, owner_user_id, entity_id_a, entity_id_b, reason)
       VALUES ($1, $2, $3, $4, 'suggestion-rejected')
       ON CONFLICT DO NOTHING`,
      [uuid7(), context.userId, suggestion.entityIdA, suggestion.entityIdB],
    );

    return true;
  }
}

/** Possessive names ("Priya's brother") are their own person, never a variant. */
function isRelationalDescriptor(name: string): boolean {
  return /['’]s(?=\s|$)/i.test(name ?? '');
}

function isSubset(inner: Set<string>, outer: Set<string>): boolean {
  if (inner.size === 0 || inner.size >= outer.size) {
    return false;
  }

  for (const token of inner) {
    if (!outer.has(token)) {
      return false;
    }
  }

  return true;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }

  for (const token of a) {
    if (!b.has(token)) {
      return false;
    }
  }

  return true;
}

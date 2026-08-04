import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { computeChunkSize } from '@ci/common/persistence';

import { ObjectIdentifierEntity, type ObjectIdentifierSubjectType } from '../entities/ObjectIdentifierEntity';
import {
  computeQualifier,
  detectObjectIdentifier,
  normalizeObjectIdentifier,
  type ObjectIdentifierNamespace,
} from '../utils/normalizeObjectIdentifier';

/** A resolved claim: which thing an identifier belongs to. */
export interface ObjectIdentifierMatch {
  subjectType: ObjectIdentifierSubjectType;
  subjectId: string;
  namespace: ObjectIdentifierNamespace;
  valueNormalized: string;
  qualifier: string;
  confidence: number;
}

/** One raw identifier asserted about a subject, pre-normalization. */
export interface RawObjectIdentifier {
  namespace: ObjectIdentifierNamespace;
  value: string | null | undefined;
  /** Scope for non-globally-unique namespaces. Ignored for gtin/isbn/asin/imei/vin. */
  brand?: string | null;
  sourceSystem?: string | null;
  confidence?: number;
  isPrimary?: boolean;
}

/**
 * The column set a batch insert writes. Surrogate id, timestamps and the jsonb
 * `metadata` are left to the database defaults.
 */
type ObjectIdentifierInsertRow = Omit<ObjectIdentifierEntity, 'id' | 'createdAt' | 'updatedAt' | 'metadata'>;

/** One subject's identifier payload within an {@link ObjectIdentifierService.upsertForSubjects} batch. */
export interface ObjectIdentifierBatchEntry {
  subjectType: ObjectIdentifierSubjectType;
  subjectId: string;
  identifiers: RawObjectIdentifier[];
  /** Provenance stamped onto newly-inserted rows (importer:amazon, receipt_ocr, user, ...). */
  source?: string;
}

/**
 * Read/write surface for `ci.object_identifiers`: the normalized barcode ->
 * physical-thing index. The object-side counterpart of
 * {@link EntityIdentifierService}, and deliberately shaped like it so the two
 * read the same.
 *
 * Everything here funnels raw values through `normalizeObjectIdentifier`. No
 * caller may write `value_normalized` itself — a value normalized by a second
 * rule is a claim that can never be found again.
 *
 * FIRST-WRITER-WINS on the claim index. When a second subject asserts a value
 * another subject already claims, the write is silently ignored rather than
 * re-pointed: two things claiming one barcode is a duplicate signal for review,
 * not something to resolve automatically. That is also why duplicate detection
 * must scan `ci.inventory` / `ci.product_models` directly — the losing claim was
 * never inserted, so it is invisible in this table.
 */
@Injectable()
export class ObjectIdentifierService {
  constructor(
    @InjectRepository(ObjectIdentifierEntity)
    private readonly repository: Repository<ObjectIdentifierEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ObjectIdentifierService.name);
  }

  /**
   * Register identifiers for a whole batch of subjects in ONE set-based INSERT
   * (chunked to the bind-param budget), idempotent on the claim index.
   *
   * Values that do not normalize (an unreadable barcode, a failed check digit)
   * are SKIPPED, never fatal — a receipt line with a garbled code is still a
   * valid line. Duplicate claims within the batch collapse to the first subject
   * carrying them, which also keeps a multi-row INSERT from tripping the unique
   * index against itself.
   *
   * A failed chunk is recorded and the remaining chunks still run, then the
   * first failure is rethrown so callers that treat identifier indexing as
   * non-fatal still see it.
   *
   * Returns the number of rows actually inserted.
   */
  async upsertForSubjects(ownerUserId: string, entries: ObjectIdentifierBatchEntry[]): Promise<number> {
    // Plain rows, NOT repository.create() instances: TypeORM's insert builder
    // types a jsonb `Record<string, unknown>` column as a deep-partial it
    // cannot accept, and `metadata` is defaulted by the database anyway.
    const rows: ObjectIdentifierInsertRow[] = [];
    const seen = new Set<string>();

    for (const entry of entries) {
      for (const raw of entry.identifiers) {
        const normalized = normalizeObjectIdentifier(raw.namespace, raw.value);
        if (normalized == null) {
          continue;
        }

        // NOTE the qualifier is computed from the namespace the normalizer
        // RETURNED, not the one requested — an all-digit ASIN becomes an ISBN,
        // which is globally unique and therefore takes an empty qualifier.
        const qualifier = computeQualifier(normalized.namespace, {
          brand: raw.brand,
          sourceSystem: raw.sourceSystem,
        });

        const dedupeKey = claimKey(normalized.namespace, normalized.valueNormalized, qualifier);
        if (seen.has(dedupeKey)) {
          continue;
        }

        seen.add(dedupeKey);

        rows.push({
          ownerUserId,
          subjectType: entry.subjectType,
          subjectId: entry.subjectId,
          namespace: normalized.namespace,
          valueNormalized: normalized.valueNormalized,
          valueRaw: normalized.valueRaw === normalized.valueNormalized ? null : normalized.valueRaw,
          qualifier,
          confidence: raw.confidence ?? 1.0,
          isPrimary: raw.isPrimary ?? false,
          source: entry.source ?? null,
        });
      }
    }

    if (rows.length === 0) {
      return 0;
    }

    const chunkSize = computeChunkSize(this.repository.metadata.columns.length);
    let inserted = 0;
    const failures: string[] = [];

    for (let offset = 0; offset < rows.length; offset += chunkSize) {
      try {
        const result = await this.repository
          .createQueryBuilder()
          .insert()
          .into(ObjectIdentifierEntity)
          .values(rows.slice(offset, offset + chunkSize))
          .orIgnore() // ON CONFLICT DO NOTHING on object_identifiers_claim_uniq.
          .execute();

        inserted += result.identifiers.length;
      } catch (err) {
        failures.push((err as Error).message);
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `${failures.length} object-identifier insert chunk(s) failed (${inserted} rows inserted): ${failures[0]}`,
      );
    }

    return inserted;
  }

  /** Single-subject convenience over {@link upsertForSubjects}. */
  async upsertForSubject(
    ownerUserId: string,
    subjectType: ObjectIdentifierSubjectType,
    subjectId: string,
    identifiers: RawObjectIdentifier[],
    source?: string,
  ): Promise<number> {
    return this.upsertForSubjects(ownerUserId, [{ subjectType, subjectId, identifiers, source }]);
  }

  /**
   * Resolve one raw identifier to the thing that claims it. Normalizes with the
   * shared rule first, so callers may pass whatever the source printed.
   */
  async resolve(
    ownerUserId: string,
    namespace: ObjectIdentifierNamespace,
    rawValue: string,
    scope: { brand?: string | null; sourceSystem?: string | null } = {},
  ): Promise<ObjectIdentifierMatch | null> {
    const normalized = normalizeObjectIdentifier(namespace, rawValue);
    if (normalized == null) {
      return null;
    }

    const qualifier = computeQualifier(normalized.namespace, scope);

    const row = await this.repository.findOne({
      where: {
        ownerUserId,
        namespace: normalized.namespace,
        valueNormalized: normalized.valueNormalized,
        qualifier,
      },
    });

    return row ? toMatch(row) : null;
  }

  /**
   * Scan-anything resolution: the user scanned a code and nobody knows what
   * kind it is. Detects the namespace from the value's own grammar, then
   * resolves. Only globally-unique namespaces can be resolved this way — a bare
   * serial number is meaningless without knowing whose it is — so the qualifier
   * is always empty here.
   */
  async resolveScan(ownerUserId: string, rawValue: string): Promise<ObjectIdentifierMatch | null> {
    const detected = detectObjectIdentifier(rawValue);
    if (detected == null) {
      return null;
    }

    const row = await this.repository.findOne({
      where: {
        ownerUserId,
        namespace: detected.namespace,
        valueNormalized: detected.valueNormalized,
        qualifier: '',
      },
    });

    return row ? toMatch(row) : null;
  }

  /**
   * Batched lookup for the import path: resolve many raw identifiers in one
   * round-trip. Returns a Map keyed by `${namespace}:${value}:${qualifier}` of
   * the NORMALIZED claim, holding only keys that matched. Callers treat a
   * missing key as "no match".
   */
  async resolveMany(
    ownerUserId: string,
    identifiers: Array<RawObjectIdentifier>,
  ): Promise<Map<string, ObjectIdentifierMatch>> {
    const out = new Map<string, ObjectIdentifierMatch>();

    // Normalize and de-dup first so the IN-list stays tight and every probe is
    // in the same form the column holds.
    const unique = new Map<
      string,
      { namespace: ObjectIdentifierNamespace; value: string; qualifier: string }
    >();
    for (const raw of identifiers) {
      const normalized = normalizeObjectIdentifier(raw.namespace, raw.value);
      if (normalized == null) {
        continue;
      }

      const qualifier = computeQualifier(normalized.namespace, {
        brand: raw.brand,
        sourceSystem: raw.sourceSystem,
      });

      unique.set(claimKey(normalized.namespace, normalized.valueNormalized, qualifier), {
        namespace: normalized.namespace,
        value: normalized.valueNormalized,
        qualifier,
      });
    }

    if (unique.size === 0) {
      return out;
    }

    const tuples = [...unique.values()];
    const params: unknown[] = [ownerUserId];
    const placeholders = tuples
      .map((key) => {
        params.push(key.namespace, key.value, key.qualifier);

        return `($${params.length - 2}, $${params.length - 1}, $${params.length})`;
      })
      .join(', ');

    const rows: Array<{
      namespace: string;
      value_normalized: string;
      qualifier: string;
      subject_type: string;
      subject_id: string;
      confidence: number;
    }> = await this.repository.manager.query(
      `SELECT namespace, value_normalized, qualifier, subject_type, subject_id, confidence
         FROM ci.object_identifiers
        WHERE owner_user_id = $1
          AND (namespace, value_normalized, qualifier) IN (${placeholders})`,
      params,
    );

    for (const row of rows) {
      out.set(claimKey(row.namespace as ObjectIdentifierNamespace, row.value_normalized, row.qualifier), {
        subjectType: row.subject_type as ObjectIdentifierSubjectType,
        subjectId: row.subject_id,
        namespace: row.namespace as ObjectIdentifierNamespace,
        valueNormalized: row.value_normalized,
        qualifier: row.qualifier,
        confidence: row.confidence,
      });
    }

    return out;
  }

  /**
   * All identifiers claimed by the given subjects, for detail pages and the
   * search-index text. Returns a Map subjectId -> rows, ordered for stable
   * display (primary first, then namespace, then value).
   */
  async listForSubjects(
    ownerUserId: string,
    subjectType: ObjectIdentifierSubjectType,
    subjectIds: string[],
  ): Promise<Map<string, ObjectIdentifierEntity[]>> {
    const out = new Map<string, ObjectIdentifierEntity[]>();
    if (subjectIds.length === 0) {
      return out;
    }

    const rows = await this.repository.find({
      where: { ownerUserId, subjectType, subjectId: In(subjectIds) },
      order: { isPrimary: 'DESC', namespace: 'ASC', valueNormalized: 'ASC' },
    });

    for (const row of rows) {
      const list = out.get(row.subjectId);
      if (list) {
        list.push(row);
      } else {
        out.set(row.subjectId, [row]);
      }
    }

    return out;
  }

  /**
   * User-asserted identifier add. Upserts under source='user' with confidence
   * 1.0 — a user assertion is ground truth.
   *
   * If the claim is already held by ANOTHER subject the claim is NOT stolen
   * (first-writer-wins, same as ingest); the existing claimant is returned so
   * the caller can surface "already belongs to X". Merging the two things is
   * the right fix, not a silent re-point.
   *
   * Returns the claim as it stands after the call, or null when the value does
   * not normalize into a usable identifier.
   */
  async addForSubject(
    ownerUserId: string,
    subjectType: ObjectIdentifierSubjectType,
    subjectId: string,
    namespace: ObjectIdentifierNamespace,
    rawValue: string,
    scope: { brand?: string | null; sourceSystem?: string | null } = {},
  ): Promise<ObjectIdentifierMatch | null> {
    const normalized = normalizeObjectIdentifier(namespace, rawValue);
    if (normalized == null) {
      return null;
    }

    const qualifier = computeQualifier(normalized.namespace, scope);

    await this.repository
      .createQueryBuilder()
      .insert()
      .into(ObjectIdentifierEntity)
      .values({
        ownerUserId,
        subjectType,
        subjectId,
        namespace: normalized.namespace,
        valueNormalized: normalized.valueNormalized,
        valueRaw: normalized.valueRaw === normalized.valueNormalized ? null : normalized.valueRaw,
        qualifier,
        confidence: 1.0,
        source: 'user',
      })
      .orIgnore()
      .execute();

    const row = await this.repository.findOne({
      where: {
        ownerUserId,
        namespace: normalized.namespace,
        valueNormalized: normalized.valueNormalized,
        qualifier,
      },
    });

    // The claim already existed for this same subject but was machine-asserted:
    // promote it to user-verified. Never touch a row belonging to another
    // subject.
    if (row && row.subjectId === subjectId && row.source !== 'user') {
      await this.repository.update({ id: row.id }, { source: 'user', confidence: 1.0 });
      row.source = 'user';
      row.confidence = 1.0;
    }

    return row ? toMatch(row) : null;
  }

  /**
   * Remove an identifier claim from a subject. Scoped to the subject so a stale
   * UI can never delete another thing's claim. Returns true when a row went.
   */
  async removeForSubject(
    ownerUserId: string,
    subjectType: ObjectIdentifierSubjectType,
    subjectId: string,
    namespace: ObjectIdentifierNamespace,
    rawValue: string,
    scope: { brand?: string | null; sourceSystem?: string | null } = {},
  ): Promise<boolean> {
    const normalized = normalizeObjectIdentifier(namespace, rawValue);
    const valueNormalized = normalized?.valueNormalized ?? rawValue;
    const resolvedNamespace = normalized?.namespace ?? namespace;
    const qualifier = computeQualifier(resolvedNamespace, scope);

    const result = await this.repository.delete({
      ownerUserId,
      subjectType,
      subjectId,
      namespace: resolvedNamespace,
      valueNormalized,
      qualifier,
    });

    return (result.affected ?? 0) > 0;
  }

  /**
   * Re-point every claim held by `fromSubjectId` onto `toSubjectId`, for the
   * merge path. Returns the number of claims moved.
   *
   * A PLAIN UPDATE IS CORRECT AND SUFFICIENT — no pre-delete of "colliding"
   * claims, because a collision is not representable. `object_identifiers_claim_uniq`
   * is UNIQUE on (owner_user_id, namespace, value_normalized, qualifier) and
   * does NOT include subject_id, so a given claim key has at most ONE row per
   * owner. If the losing subject holds it, the surviving subject by definition
   * does not, and an UPDATE that touches only subject_id cannot violate an
   * index subject_id is not part of. This mirrors PersonMergeService, which
   * re-points ci.entity_identifiers (identically shaped index) with a bare
   * UPDATE for the same reason.
   *
   * Self-merge is rejected rather than executed: it is always a caller bug (a
   * retried merge job, or a UI posting one id as both sides), and treating it
   * as a no-op would hide that.
   */
  async repointSubject(
    ownerUserId: string,
    subjectType: ObjectIdentifierSubjectType,
    fromSubjectId: string,
    toSubjectId: string,
  ): Promise<number> {
    if (fromSubjectId === toSubjectId) {
      throw new Error(
        `repointSubject: refusing to merge ${subjectType} ${fromSubjectId} into itself — the caller should filter self-merges (see PersonMergeService.mergePeople).`,
      );
    }

    const result = await this.repository.update(
      { ownerUserId, subjectType, subjectId: fromSubjectId },
      { subjectId: toSubjectId },
    );

    return result.affected ?? 0;
  }
}

/** The claim index key, in one place so lookups and de-dup cannot drift apart. */
function claimKey(namespace: ObjectIdentifierNamespace, valueNormalized: string, qualifier: string): string {
  return `${namespace}:${valueNormalized}:${qualifier}`;
}

function toMatch(row: ObjectIdentifierEntity): ObjectIdentifierMatch {
  return {
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    namespace: row.namespace,
    valueNormalized: row.valueNormalized,
    qualifier: row.qualifier,
    confidence: row.confidence,
  };
}

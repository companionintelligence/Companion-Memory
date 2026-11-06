import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type ServiceContext, type UserServiceContext } from '@ci/common/context';
import {
  DEVICE_INDEXED_ENTITIES,
  DEVICE_RECORD_VERSION,
  entityDeviceRecordSql,
  entityTimeSql,
} from '@ci/domains/search-next';

import { DOCUMENT_BODY_MAX_CHARS } from '../entities/MobileSearchDocumentEntity';
import { type Vector, VectorEntity } from '../entities/VectorEntity';
import { UpsertVectorDto, RemoveVectorDto, WeightedText } from '../types';

type TsVectorWeight = 'A' | 'B' | 'C' | 'D';

/**
 * Maps a scalar weight to PostgreSQL tsvector weight category.
 * Higher scalars map to higher-priority categories.
 */
function mapScalarToWeight(scalar: number): TsVectorWeight {
  if (scalar >= 8) {
    return 'A';
  }

  if (scalar >= 4) {
    return 'B';
  }

  if (scalar >= 2) {
    return 'C';
  }

  return 'D';
}

/**
 * Builds a weighted tsvector SQL expression using POSITIONAL ($n) placeholders
 * starting at `startIndex`, plus the ordered param values. Groups texts by weight
 * category and emits one setweight() call per non-empty group. Positional (not
 * named) params so the expression can be spliced into a raw parameterized
 * `INSERT ... ON CONFLICT` upsert.
 */
const TS_WEIGHTS = ['A', 'B', 'C', 'D'] as const;

/** The texts of each tsvector weight category, joined; `''` for a category with none. */
export function weightedTextGroups(texts: WeightedText[]): Record<TsVectorWeight, string> {
  const groups: Record<TsVectorWeight, string[]> = { A: [], B: [], C: [], D: [] };

  for (const item of texts) {
    if (item.text && item.text.trim().length > 0) {
      groups[mapScalarToWeight(item.weight)].push(item.text.trim());
    }
  }

  return { A: groups.A.join(' '), B: groups.B.join(' '), C: groups.C.join(' '), D: groups.D.join(' ') };
}

export function buildWeightedVectorSql(
  texts: WeightedText[],
  startIndex: number,
): {
  sql: string;
  params: string[];
} {
  const groups = weightedTextGroups(texts);

  // Build SQL parts for each non-empty weight group
  const sqlParts: string[] = [];
  const params: string[] = [];
  let paramIndex = startIndex;

  for (const weight of TS_WEIGHTS) {
    if (groups[weight].length > 0) {
      sqlParts.push(`setweight(to_tsvector('english', $${paramIndex}), '${weight}')`);
      params.push(groups[weight]);
      paramIndex += 1;
    }
  }

  // If no text at all, create empty tsvector
  const sql = sqlParts.length > 0 ? sqlParts.join(' || ') : "''::tsvector";

  return { sql, params };
}

/** The title and body a device shows for a row: the search document split in two. */
export interface SearchDocumentText {
  title: string;
  body: string;
}

/**
 * The plain-text document a device carries for a row, derived from the same
 * weighted texts the tsvector is built from.
 *
 * Every builder in `searchTexts.ts` pushes the row's name first and at weight
 * A (>= 8): a person's name, an event's title, a file's title, a message's
 * subject. That first A text is the title. A row with no A text at all (a
 * message with no subject) takes its first text instead, so a result row is
 * never blank. Everything else is the body, in builder order, cut at
 * {@link DOCUMENT_BODY_MAX_CHARS}: enough for a snippet and for FTS to match
 * on, not the whole of a long note.
 */
export function searchDocumentText(texts: WeightedText[]): SearchDocumentText {
  const kept = texts
    .map((t) => ({ text: t.text?.trim() ?? '', weight: t.weight }))
    .filter((t) => t.text.length > 0);
  const titleIndex = kept.findIndex((t) => t.weight >= 8);
  const title = titleIndex === -1 ? (kept[0]?.text ?? '') : kept[titleIndex].text;
  const body = kept
    .filter((_, index) => index !== (titleIndex === -1 ? 0 : titleIndex))
    .map((t) => t.text)
    .join(' ')
    .slice(0, DOCUMENT_BODY_MAX_CHARS);

  return { title, body };
}

/**
 * The one statement that writes a row's search index: its tsvector into
 * `ci_search.vectors`, and — for a device-indexed type — its plain-text
 * document into `ci_search.mobile_search_documents` in the same statement, keyed by the
 * vectors row's id. Used by {@link VectorService.upsert} (the live listeners)
 * and by the pipeline's vector stages, so the two paths can never write
 * different text for the same row.
 *
 * The documents half is a data-modifying CTE reading the vectors CTE's
 * RETURNING, so on a conflict it carries the EXISTING vectors row's id, which
 * is what the documents PK references. Types outside
 * {@link DEVICE_INDEXED_ENTITIES} fall out of the `WHERE` and write no
 * document; a type that stops being device-indexed keeps its old document
 * until the orphan sweep or a delete removes the vectors row (CASCADE).
 *
 * The document also carries the device record's `related_id` and `detail`,
 * derived here from the source row by {@link entityDeviceRecordSql} (one
 * primary-key lookup), and stamped with {@link DEVICE_RECORD_VERSION} so
 * `MobileSearchDocumentDetailCron` knows it is current. Derived in SQL rather
 * than passed in, so none of the listeners or pipeline stages had to change.
 *
 * A re-index that would leave the document as it is writes nothing: the
 * `DO UPDATE ... WHERE` compares every stored column. PowerSync replicates this
 * table, and it sends a phone a fresh copy of any row that is written, changed
 * or not (measured 2026-10-30), so a no-op rewrite used to cost every phone a
 * download -- one per entity on a full re-index. `updated_at` moves only when
 * the document did.
 *
 * Indexing an EVENT also moves its place's document forward: a place's time is its latest
 * visit (`entityTimeSql`), and the place itself is not re-indexed when a new event is held
 * there. The `place_visit` CTE writes only when the event is later than what the place
 * document carries, so a re-index of an old event is free. Postgres runs a data-modifying
 * CTE whether or not anything reads it.
 *
 * Batch-shaped: the rows arrive as parallel arrays through `unnest`, so a
 * pipeline slice is one statement where it was one per row (200 of these,
 * three CTEs each, per slice; seven stages times the corpus on a re-index).
 * The four weight categories are fixed columns — an empty one concatenates to
 * nothing, so the tsvector is the one the per-row expression built. The live
 * listeners write a batch of one through {@link buildVectorUpsertStatement}.
 *
 * Positional params: $1 ids, $2 entity ids, $3..$6 the A..D weight groups,
 * $7 titles, $8 bodies (one entry per row each), then $9 entity_type, $10
 * user_id, $11 the device-type list.
 */
export function buildVectorUpsertBatchStatement(
  rows: Array<{ id: string; entityId: string; texts: WeightedText[] }>,
  scope: { entityType: string; userId: string },
): { sql: string; params: (string | string[])[] } {
  const groups = rows.map((row) => weightedTextGroups(row.texts));
  const documents = rows.map((row) => searchDocumentText(row.texts));
  const vectorSql = TS_WEIGHTS.map(
    (weight) => `setweight(to_tsvector('english', i.text_${weight.toLowerCase()}), '${weight}')`,
  ).join(' || ');

  const sql = `
    WITH input AS (
      SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[])
        AS t(id, entity_id, text_a, text_b, text_c, text_d, title, body)
    ),
    vector_row AS (
      INSERT INTO ci_search.vectors (id, entity_type, entity_id, vector, user_id)
      SELECT i.id, $9, i.entity_id, ${vectorSql}, $10::uuid
        FROM input i
      ON CONFLICT (entity_type, entity_id)
      DO UPDATE SET vector = EXCLUDED.vector, updated_at = now()
      RETURNING id, entity_type, entity_id, user_id, created_at, updated_at
    ),
    document_row AS (
      INSERT INTO ci_search.mobile_search_documents AS doc
             (id, entity_type, entity_id, user_id, title, body, occurred_at, related_id, detail, detail_version)
      SELECT v.id, v.entity_type, v.entity_id, v.user_id, i.title, i.body,
             ${entityTimeSql('v')},
             rec.related_id, rec.detail, ${DEVICE_RECORD_VERSION}
        FROM vector_row v
        JOIN input i ON i.entity_id = v.entity_id
        LEFT JOIN LATERAL (${entityDeviceRecordSql('v')}) rec ON true
       WHERE v.entity_type = ANY($11::text[])
      ON CONFLICT (entity_type, entity_id)
      DO UPDATE SET title = EXCLUDED.title,
                    body = EXCLUDED.body,
                    occurred_at = EXCLUDED.occurred_at,
                    related_id = EXCLUDED.related_id,
                    detail = EXCLUDED.detail,
                    detail_version = EXCLUDED.detail_version,
                    updated_at = now()
              WHERE (doc.title, doc.body, doc.occurred_at, doc.related_id, doc.detail, doc.detail_version)
                    IS DISTINCT FROM
                    (EXCLUDED.title, EXCLUDED.body, EXCLUDED.occurred_at, EXCLUDED.related_id,
                     EXCLUDED.detail, EXCLUDED.detail_version)
    ),
    place_visit AS (
      UPDATE ci_search.mobile_search_documents d
         SET occurred_at = e.start_time,
             updated_at = now()
        FROM vector_row v
        JOIN ci.events e ON e.event_id = v.entity_id
       WHERE v.entity_type = 'event'
         AND d.entity_type = 'place'
         AND d.entity_id = e.location_entity_id
         AND e.start_time IS NOT NULL
         AND (d.occurred_at IS NULL OR d.occurred_at < e.start_time)
    )
    SELECT id, entity_type, entity_id, user_id, created_at, updated_at FROM vector_row`;

  return {
    sql,
    params: [
      rows.map((row) => row.id),
      rows.map((row) => row.entityId),
      groups.map((group) => group.A),
      groups.map((group) => group.B),
      groups.map((group) => group.C),
      groups.map((group) => group.D),
      documents.map((document) => document.title),
      documents.map((document) => document.body),
      scope.entityType,
      scope.userId,
      [...DEVICE_INDEXED_ENTITIES],
    ],
  };
}

/** {@link buildVectorUpsertBatchStatement} for one row: what the live listeners write. */
export function buildVectorUpsertStatement(
  texts: WeightedText[],
  row: { id: string; entityType: string; entityId: string; userId: string },
): { sql: string; params: (string | string[])[] } {
  return buildVectorUpsertBatchStatement([{ id: row.id, entityId: row.entityId, texts }], {
    entityType: row.entityType,
    userId: row.userId,
  });
}

@Injectable()
export class VectorService {
  constructor(
    @InjectRepository(VectorEntity)
    private readonly vectorRepo: Repository<VectorEntity>,
  ) {}

  async upsert(context: UserServiceContext, data: UpsertVectorDto): Promise<Vector | null> {
    // Single-statement upsert on the (entity_type, entity_id) unique key. The
    // weighted tsvector is computed inline in the INSERT and copied via
    // EXCLUDED.vector on conflict. Replaces the previous SELECT-then-
    // INSERT/UPDATE-then-SELECT wrapped in an explicit transaction — the per-row
    // cost that left the search-index queue >95% undrained. The same statement
    // writes the device document (see buildVectorUpsertStatement).
    const { sql, params } = buildVectorUpsertStatement(data.searchableText, {
      id: uuidv7(),
      entityType: data.entityType,
      entityId: data.entityId,
      userId: context.userId,
    });

    const rows: Array<{
      id: string;
      entity_type: string;
      entity_id: string;
      user_id: string;
      created_at: Date;
      updated_at: Date;
    }> = await this.vectorRepo.query(sql, params);

    const row = rows[0];

    return row
      ? {
          id: row.id,
          entityType: row.entity_type,
          entityId: row.entity_id,
          userId: row.user_id,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : null;
  }

  /** Removes the tsvector row; its `ci_search.mobile_search_documents` row goes with it (ON DELETE CASCADE). */
  async remove(context: ServiceContext, data: RemoveVectorDto): Promise<boolean> {
    const result = await this.vectorRepo.delete({
      entityType: data.entityType,
      entityId: data.entityId,
    });

    return result.affected ? result.affected > 0 : false;
  }
}

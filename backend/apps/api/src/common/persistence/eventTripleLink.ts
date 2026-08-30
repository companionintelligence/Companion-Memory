import type { EntityManager } from 'typeorm';

/**
 * The (source_type, source_system, source_id) provenance triple a captured row
 * shares with the `ci.events` row it was recorded alongside. Mirrors
 * {@link SourceTriple} from `bulkUpsert.ts`, narrowed to non-nullable/undefined
 * `sourceType`/`sourceId` — callers filter out triple-less rows before building
 * one of these (see {@link resolveEventIdsByTriple}'s callers).
 */
export interface EventTriple {
  sourceType: string;
  sourceSystem: string | null;
  sourceId: string;
}

/**
 * Stable string key for a triple. NULL-safe: a null `sourceSystem` is its own
 * bucket, matching the `events_source_triple_uniq` partial unique index (WHERE
 * source_id IS NOT NULL) and every other triple-keyed lookup in this codebase.
 */
const TRIPLE_KEY_SEPARATOR = String.fromCharCode(0);

export const eventTripleKey = (triple: EventTriple): string =>
  [triple.sourceType, triple.sourceSystem ?? '', triple.sourceId].join(TRIPLE_KEY_SEPARATOR);

/**
 * Set-based provenance-triple lookup against `ci.events`, for ingest paths that
 * auto-link a row to the event it was captured alongside. Generalizes the exact
 * matching semantics of `ContentService`'s private `resolveEventIdsByTriple`
 * (NULL-safe `source_system`, first-match-wins, triple-less rows skipped) so
 * FileService's capture-screenshot upload (`FileService.uploadWithDedupInfo`)
 * doesn't reimplement them from scratch. `ContentService` itself keeps its own
 * `Repository<EventEntity>`/`QueryBuilder` implementation rather than switching
 * to this one — its `resolveEventIdsByTriple` is pinned by
 * `ContentService.eventLink.test.ts`'s mocks, and (being IN the `memory`
 * domain) it can import `EventEntity` directly with no cycle risk, unlike here.
 *
 * Deliberately raw SQL against `ci.events` rather than going through
 * `EventEntity`/`Repository<EventEntity>` (the `memory` domain's entity): this
 * lives in `common/persistence`, which BOTH `memory` (ContentService) and
 * `files` (FileService) already depend on. `memory` already imports `files`
 * (`MemoryModule` -> `FilesModule`), and `EventEntity.ts` imports the `user`
 * domain BARREL, which itself imports `files` — so a value-level import of
 * `EventEntity` here (or from `files`) would close a real CommonJS require
 * cycle: whichever module loaded second would see `{}` for the other, and the
 * class symbols used in `@Module()` decorator arrays would evaluate to
 * `undefined` (see the identical warning in `memory/index.ts` about the `graph`
 * barrel). The table/column names duplicated below are part of the stable
 * migrated schema (`ci.events`: `event_id`, `user_id`, `source_type`,
 * `source_system`, `source_id`) — schema sync is off everywhere in this
 * codebase; the migration is the source of truth, not the TypeORM entity.
 *
 * `source_system` is matched NULL-safely via a two-armed `= $n` / `IS NULL`
 * condition rather than `IS NOT DISTINCT FROM` — Postgres cannot use a btree
 * index (including `events_source_triple_uniq`, the index this lookup is meant
 * to hit) to satisfy an `IS NOT DISTINCT FROM` qual (see the identical note on
 * `ContentService.resolveEventIdsByTriple`).
 */
export async function resolveEventIdsByTriple(
  manager: EntityManager,
  userId: string,
  triples: EventTriple[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  // Dedupe so the OR-list stays compact when many rows share a triple.
  const distinct = new Map<string, EventTriple>();
  for (const triple of triples) {
    if (!triple.sourceType || !triple.sourceId) {
      continue;
    }

    distinct.set(eventTripleKey(triple), triple);
  }

  if (distinct.size === 0) {
    return result;
  }

  const values = [...distinct.values()];
  const params: unknown[] = [userId];
  const clauses = values.map((triple) => {
    const typeParam = params.push(triple.sourceType);
    const idParam = params.push(triple.sourceId);

    if (triple.sourceSystem == null) {
      return `(source_type = $${typeParam} AND source_system IS NULL AND source_id = $${idParam})`;
    }

    const systemParam = params.push(triple.sourceSystem);

    return `(source_type = $${typeParam} AND source_system = $${systemParam} AND source_id = $${idParam})`;
  });

  const rows: Array<{
    event_id: string;
    source_type: string | null;
    source_system: string | null;
    source_id: string | null;
  }> = await manager.query(
    `SELECT event_id, source_type, source_system, source_id
       FROM ci.events
      WHERE user_id = $1 AND (${clauses.join(' OR ')})`,
    params,
  );

  for (const row of rows) {
    if (row.source_type == null || row.source_id == null) {
      continue;
    }

    const key = eventTripleKey({
      sourceType: row.source_type,
      sourceSystem: row.source_system,
      sourceId: row.source_id,
    });

    // First match wins — the triple is unique per user via
    // events_source_triple_uniq, so there is at most one anyway.
    if (!result.has(key)) {
      result.set(key, row.event_id);
    }
  }

  return result;
}

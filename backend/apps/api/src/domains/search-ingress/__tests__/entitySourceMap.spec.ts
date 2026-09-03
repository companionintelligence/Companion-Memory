import { type IndexableEntity } from '@ci/domains/search-next';

import { ENTITY_SOURCE_MAP } from '../entitySourceMap';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MAP MUST NAME THE ROWS THE WRITERS ACTUALLY WROTE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ENTITY_SOURCE_MAP` is the answer to "does the source row behind this index
 * row still exist?", and `OrphanCleanupService` DELETES every index row it
 * answers no for. So a wrong entry is not a cosmetic drift — it is silent,
 * nightly, recurring data loss from search, and one nobody sees because the
 * sweep reports exactly the same "deleted N orphans" line it reports when it is
 * right.
 *
 * That is what happened to `file`: the map pointed at `ci.entities` /
 * `entity_id` with `entity_type = 'File'` (the GRAPH NODE for a file), while
 * every writer keys on `ci.files.id`. The two are 1:1 but their ids are
 * disjoint — GraphIngest mints a fresh `entity_id` rather than reusing the
 * file's uuid — so the sweep's EXISTS matched nothing and reaped the entire
 * `file` index every night, and the backfill re-enqueued graph-node ids that
 * `FileSearchIndexListener` then dropped as "File not found". Measured on the
 * live appliance before the fix: 7,775 File nodes, 12,823 `ci.files` rows, zero
 * id overlap; 12,823 of 12,823 written rows classified as orphans.
 *
 * The pipeline's `StageSource`s are the OTHER half of the same contract — they
 * are the writers (`FileEmbedStage`, `FileVectorStage`, ...) — and they carry
 * the schema/table/id independently.
 *
 * Those constants are mirrored here as literals rather than imported: the
 * `no-cross-domain-internals` dependency rule forbids `search-ingress` reaching
 * into `domains/pipeline/stages/**`, and a test is not a good reason to punch a
 * hole in a boundary the whole codebase keeps. The trade-off is real and worth
 * stating — this pins the READER (the map, which is the half that was wrong)
 * but cannot fail automatically if a WRITER stage moves its table or id column.
 * If these ever need to be enforced against each other mechanically, the fix is
 * to lift the `StageSource` definitions into a package both domains may import,
 * not to relax the rule.
 */
describe('ENTITY_SOURCE_MAP agrees with the pipeline stage sources that write the index', () => {
  // Mirrors INDEX_EMBED_*_SOURCE in domains/pipeline/stages/index/entityEmbedStages.ts.
  const cases: Array<[IndexableEntity, { schema: string; table: string; idColumn: string }]> = [
    ['browser-activity', { schema: 'ci', table: 'browser_activity', idColumn: 'id' }],
    ['communication', { schema: 'ci', table: 'communications', idColumn: 'id' }],
    ['event', { schema: 'ci', table: 'events', idColumn: 'event_id' }],
    ['file', { schema: 'ci', table: 'files', idColumn: 'id' }],
    ['item', { schema: 'ci', table: 'objects', idColumn: 'object_id' }],
    ['person', { schema: 'ci', table: 'entities', idColumn: 'entity_id' }],
  ];

  it.each(cases)('%s resolves the same table + id column its embed stage writes', (entityType, stageSource) => {
    const mapped = ENTITY_SOURCE_MAP[entityType];

    expect({
      schema: mapped.schema,
      table: mapped.table,
      idColumn: mapped.idColumn,
    }).toEqual({
      schema: stageSource.schema,
      table: stageSource.table,
      idColumn: stageSource.idColumn,
    });
  });
});

describe('ENTITY_SOURCE_MAP.file', () => {
  /**
   * Named explicitly rather than left to the cross-check above, because the
   * wrong answer here is a specific, plausible one: `ci.entities` DOES hold a
   * row per file (`entity_type = 'File'`), it IS 1:1 with `ci.files`, and it is
   * where person/place/concept legitimately live. Only the id disagrees.
   */
  it('points at ci.files / id, not the ci.entities File graph node', () => {
    expect(ENTITY_SOURCE_MAP.file.schema).toBe('ci');
    expect(ENTITY_SOURCE_MAP.file.table).toBe('files');
    expect(ENTITY_SOURCE_MAP.file.idColumn).toBe('id');
  });

  /**
   * `FileService.update` emits `FileUpdatedEvent` for ANY variant, and
   * `FileSearchIndexListener` has no variant guard — so a PREVIEW row can carry
   * a legitimate index row. A discriminator is applied by the ORPHAN sweep, so
   * adding one here (on `variant`, say) would reap exactly those rows. The
   * variant restriction belongs in `backfillPredicate`, which the sweep never
   * applies, and does — see below.
   */
  it('carries no discriminator, so the sweep cannot reap a legitimately indexed variant', () => {
    expect(ENTITY_SOURCE_MAP.file.discriminator).toBeUndefined();
  });

  /**
   * Backfill-only. It must mirror `INDEX_EMBED_FILE_SOURCE.predicate` so the
   * backfill re-enqueues the same population the pipeline stage indexes,
   * instead of pulling in the derived PREVIEW variants (5,048 of them live)
   * that repeat the original's filename with no text of their own.
   */
  it('restricts the BACKFILL to the same population the embed stage indexes', () => {
    const predicate = ENTITY_SOURCE_MAP.file.backfillPredicate;

    expect(predicate).toBeDefined();
    expect(predicate).toContain("s.variant = 'ORIGINAL'");
    expect(predicate).toContain('s.deleted_at IS NULL');
    // Same restriction, same alias, as the stage that writes the rows —
    // mirroring INDEX_EMBED_FILE_SOURCE.predicate, which this domain may not
    // import (see the note on the cross-check above).
    expect(predicate).toBe("s.variant = 'ORIGINAL' AND s.deleted_at IS NULL");
  });
});

describe('ENTITY_SOURCE_MAP.event', () => {
  /**
   * Backfill-only, and it must mirror `INDEX_EMBED_EVENT_SOURCE.predicate`
   * exactly, for the same reason the file entry mirrors its stage: the sweep
   * must never enqueue a row the stage would refuse. For events the refused row
   * is a planned block — planning's own object, whose words live on the task —
   * and before this predicate existed every one of them was re-found on every
   * pass and re-enqueued as a permanent no-op.
   */
  it('mirrors the embed stage predicate, excluding planned blocks and deleted rows', () => {
    const predicate = ENTITY_SOURCE_MAP.event.backfillPredicate;

    expect(predicate).toBeDefined();
    expect(predicate).toContain("s.event_type <> 'planned_block'");
    expect(predicate).toContain('s.is_deleted IS NOT TRUE');
    expect(predicate).toBe("s.is_deleted IS NOT TRUE AND s.event_type <> 'planned_block'");
  });
});

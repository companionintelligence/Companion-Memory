import type { DataSource, Repository } from 'typeorm';

import type { ObjectObservationEntity } from '../../entities/ObjectObservationEntity';
import { platformIdentity } from '../../identity';
import type { CreateObjectObservationDto } from '../../types';
import { ObjectObservationService, detectionKeyFor } from '../ObjectObservationService';

/**
 * `ObjectObservationService` — the first writer `ci.object_observations` has
 * ever had.
 *
 * The table shipped in migration `20260803223022` with a full column set, two
 * partial unique indexes, a review index and a downstream edge projection
 * already built against it — and nothing that could put a row in it. This suite
 * is about the four things a writer of an empty table has to get right before
 * the rows are worth reading:
 *
 *  1. **Every row has an arbiter, or it is refused.** A row with neither a
 *     provenance triple nor a derivable detection key duplicates on every
 *     retry. The table has two unique indexes precisely so that cannot happen;
 *     inserting around them would be worse than not inserting.
 *  2. **The derived key discriminates.** The migration specifies
 *     `(content_id, detector, rounded bbox)`, which is right for a detector
 *     that emits boxes and collapses an entire photo to one row for one that
 *     does not. Both schemes are covered, including the collapse that motivates
 *     the second.
 *  3. **Detection never writes resolution.** Not by DTO (there is no field),
 *     not by SQL (the columns are absent from `DO UPDATE SET`), and not after a
 *     human has confirmed (the `WHERE` clause).
 *  4. **A mixed batch is two statements.** One `ON CONFLICT` target per
 *     statement is a Postgres constraint, not a style choice, and a batch
 *     carrying both arbiters that issued one statement would silently key half
 *     its rows on the wrong index.
 *
 * The SQL-shaped guarantees are asserted here against the emitted statement
 * text, and proved for real against a live Postgres in the sibling
 * `ObjectObservationService.integration.spec.ts` (ON CONFLICT arbiter
 * correctness for both schemes, the DO UPDATE SET exclusion list, the jsonb
 * merge behavior, and `ST_MakePoint`'s argument order) — gated on
 * `MEMORY_TEST_DATABASE_URL`, which SKIPS, never silently passes, when no
 * database is reachable. A string match here catches a dropped branch at
 * review time; the integration suite catches a predicate that is present but
 * wrong, which grepping the SQL text cannot.
 */

const USER = '00000000-0000-4000-8000-0000000000aa';
const CONTENT = '00000000-0000-4000-8000-00000000c001';
const FILE = '00000000-0000-4000-8000-0000000000f1';

function ctx() {
  return { userId: USER };
}

/** A minimal detection DTO; override whatever the test is about. */
function sighting(overrides: Partial<CreateObjectObservationDto> = {}): CreateObjectObservationDto {
  return {
    observedAt: new Date('2026-05-01T10:00:00.000Z'),
    label: 'coffee mug',
    contentId: CONTENT,
    detector: 'yolov8',
    ...overrides,
  };
}

interface Harness {
  service: ObjectObservationService;
  query: jest.Mock;
  find: jest.Mock;
  findOne: jest.Mock;
  update: jest.Mock;
  /** Every `INSERT` statement issued, in order. */
  inserts: () => Array<{ sql: string; params: unknown[] }>;
}

function makeService(): Harness {
  const calls: Array<{ sql: string; params: unknown[] }> = [];

  // Default: every row handed to the statement comes back from RETURNING, i.e.
  // nothing was excluded by the confirmed_by_user guard. Tests that care about
  // the guard override this.
  const query = jest.fn(async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });

    const ids = (params[1] ?? []) as unknown[];

    return ids.map((_value, index) => ({ observation_id: `obs-${calls.length}-${index}` }));
  });

  const find = jest.fn(async () => [] as ObjectObservationEntity[]);
  const findOne = jest.fn(async () => null);
  const update = jest.fn(async () => ({ affected: 1 }));

  const repository = {
    metadata: { columns: Array.from({ length: 23 }, () => null) },
    find,
    findOne,
    update,
  } as unknown as Repository<ObjectObservationEntity>;

  const dataSource = { query } as unknown as DataSource;

  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new ObjectObservationService(
    repository,
    dataSource,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
  );

  return {
    service,
    query,
    find,
    findOne,
    update,
    inserts: () => calls.filter((call) => call.sql.includes('INSERT INTO ci.object_observations')),
  };
}

/* ===================================================================== *
 * detectionKeyFor — the arbiter for rows with no provenance triple
 * ===================================================================== */

describe('detectionKeyFor — the scheme is chosen by what the detector supplied', () => {
  it('uses the spatial scheme when a bbox is present', () => {
    const key = detectionKeyFor(sighting({ bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } }));

    expect(key).toMatch(/^obs:v1:box:[0-9a-f]{64}$/);
  });

  it('uses the label scheme when there is no bbox', () => {
    expect(detectionKeyFor(sighting())).toMatch(/^obs:v1:label:[0-9a-f]{64}$/);
  });

  it('KEEPS TWO BOXLESS ITEMS IN ONE PHOTO APART', () => {
    // The defect this scheme exists for. `ThingVisionListener`'s vision pass
    // returns a list of items with no boxes; keying on (content, detector)
    // alone would digest every one of them identically and the whole photo
    // would collapse to a single observation — the `hashItem` failure
    // `identity/naturalKey.ts` documents, where a constant filename and no
    // record id collapsed a day of Netflix history into one row.
    const mug = detectionKeyFor(sighting({ label: 'coffee mug' }));
    const lamp = detectionKeyFor(sighting({ label: 'desk lamp' }));

    expect(mug).not.toBe(lamp);
  });

  it('does NOT put the label in the spatial key, so a relabel updates in place', () => {
    const bbox = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };

    // The same object, read by a better model that calls it something finer.
    // "must update in place, not duplicate" is the migration's requirement.
    expect(detectionKeyFor(sighting({ label: 'cup', bbox }))).toBe(
      detectionKeyFor(sighting({ label: 'coffee mug', bbox })),
    );
  });

  it('does NOT put detector_version in the key, so a model upgrade updates in place', () => {
    expect(detectionKeyFor(sighting({ detectorVersion: '8.0.1' }))).toBe(
      detectionKeyFor(sighting({ detectorVersion: '8.2.0' })),
    );
  });

  it('absorbs detector jitter below the rounding precision', () => {
    // The same model over the same JPEG re-decodes to boxes differing in the
    // fourth place. That must not fork the row.
    expect(detectionKeyFor(sighting({ bbox: { x: 0.10001, y: 0.2, w: 0.3, h: 0.4 } }))).toBe(
      detectionKeyFor(sighting({ bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } })),
    );
  });

  it('separates two genuinely different boxes', () => {
    expect(detectionKeyFor(sighting({ bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } }))).not.toBe(
      detectionKeyFor(sighting({ bbox: { x: 0.5, y: 0.6, w: 0.3, h: 0.4 } })),
    );
  });

  it('separates two detectors reading the same pixels', () => {
    expect(detectionKeyFor(sighting({ detector: 'yolov8' }))).not.toBe(
      detectionKeyFor(sighting({ detector: 'ollama_vision' })),
    );
  });

  it('falls back to the file when there is no content row yet', () => {
    // A CV pass over an upload knows the file long before ci.content exists.
    expect(detectionKeyFor(sighting({ contentId: null, fileId: FILE }))).toMatch(/^obs:v1:label:/);
  });

  it('never collides across the two schemes', () => {
    const box = detectionKeyFor(sighting({ bbox: { x: 0, y: 0, w: 1, h: 1 } })) as string;
    const label = detectionKeyFor(sighting()) as string;

    expect(box.split(':')[2]).toBe('box');
    expect(label.split(':')[2]).toBe('label');
  });

  it('returns null with no anchor to hang the key on', () => {
    expect(detectionKeyFor(sighting({ contentId: null, fileId: null }))).toBeNull();
  });

  it('returns null when there is neither a bbox nor a usable label', () => {
    expect(detectionKeyFor(sighting({ label: '   ' }))).toBeNull();
  });

  it('ignores a malformed bbox rather than digesting NaN', () => {
    const key = detectionKeyFor(sighting({ bbox: { x: Number.NaN, y: 0.2, w: 0.3, h: 0.4 } })) as string;

    // Falls through to the label scheme instead of producing a "box" key that
    // every other NaN box would also produce.
    expect(key).toMatch(/^obs:v1:label:/);
  });
});

/* ===================================================================== *
 * createMany — arbiters, partitioning, refusals
 * ===================================================================== */

describe('ObjectObservationService.createMany — every row has an arbiter or it is refused', () => {
  it('refuses a row with no triple and no derivable key, and never inserts it', async () => {
    const { service, inserts } = makeService();

    const result = await service.createMany(ctx(), [sighting({ contentId: null, fileId: null })]);

    expect(result.rejectedUnarbitered).toBe(1);
    expect(result.written).toHaveLength(0);
    expect(inserts()).toHaveLength(0);
  });

  it('refuses a whitespace-only label, which NOT NULL would have let through', async () => {
    const { service } = makeService();

    const result = await service.createMany(ctx(), [sighting({ label: '   ' })]);

    expect(result.rejectedUnarbitered).toBe(1);
  });

  it('keys a row on the provenance triple when it has one, leaving detection_key NULL', async () => {
    const { service, inserts } = makeService();

    await service.createMany(ctx(), [
      sighting({
        sourceType: 'cv_detection',
        ...(() => {
          const identity = platformIdentity('cv-server', 'file-1:det-1');

          return { sourceSystem: identity.system, sourceId: identity.id };
        })(),
      }),
    ]);

    const [insert] = inserts();

    // Identity is the (source_system, source_id) pair — source_type is
    // provenance and stays out of the key (docs/design/cross-pipeline-identity.md).
    expect(insert.sql).toContain(
      'ON CONFLICT (owner_user_id, source_system, source_id) WHERE source_id IS NOT NULL',
    );
    // $19 is the detection_key array; a triple-keyed row carries no key.
    expect(insert.params[18]).toEqual([null]);
    expect(insert.params[22]).toEqual(['file-1:det-1']);
  });

  it('derives a detection key when there is no triple, leaving source_id NULL', async () => {
    const { service, inserts } = makeService();

    await service.createMany(ctx(), [sighting()]);

    const [insert] = inserts();

    expect(insert.sql).toContain(
      'ON CONFLICT (owner_user_id, detection_key) WHERE detection_key IS NOT NULL',
    );
    expect(insert.params[18]).toEqual([expect.stringMatching(/^obs:v1:label:/)]);
    expect(insert.params[22]).toEqual([null]);
  });

  it('SPLITS A MIXED BATCH INTO TWO STATEMENTS, one per conflict target', async () => {
    const { service, inserts } = makeService();

    await service.createMany(ctx(), [
      sighting({
        ...(() => {
          const identity = platformIdentity('cv-server', 'triple-1');

          return { sourceSystem: identity.system, sourceId: identity.id };
        })(),
      }),
      sighting({ label: 'desk lamp' }),
    ]);

    const emitted = inserts();

    // Postgres allows ONE conflict target per statement. A single statement
    // here would have keyed one of these rows on an index it does not satisfy.
    expect(emitted).toHaveLength(2);
    expect(emitted[0].sql).toContain('source_id IS NOT NULL');
    expect(emitted[1].sql).toContain('detection_key IS NOT NULL');
  });

  it('folds within-batch repeats instead of letting Postgres abort the chunk', async () => {
    const { service, inserts } = makeService();

    // Two rows deriving one arbiter. Left alone, Postgres raises "ON CONFLICT
    // DO UPDATE command cannot affect row a second time" and the WHOLE chunk
    // dies — so a detector that emitted one box twice would lose the slice.
    const result = await service.createMany(ctx(), [sighting(), sighting()]);

    expect(result.duplicatesInBatch).toBe(1);
    expect(inserts()[0].params[10]).toHaveLength(1);
  });

  it('keeps the last write when a batch repeats an arbiter', async () => {
    const { service, inserts } = makeService();

    await service.createMany(ctx(), [
      sighting({ detectionConfidence: 0.4 }),
      sighting({ detectionConfidence: 0.9 }),
    ]);

    expect(inserts()[0].params[14]).toEqual([0.9]);
  });

  it('sets owner_user_id, because both unique indexes are keyed on it', async () => {
    const { service, inserts } = makeService();

    await service.createMany(ctx(), [sighting()]);

    // Leaving it NULL would make the whole idempotency argument false — the
    // trap ObjectPromoteStage documents for ci.objects.
    expect(inserts()[0].sql).toContain('owner_user_id');
    expect(inserts()[0].params[0]).toBe(USER);
  });

  it('clamps a confidence into [0, 1] rather than failing the CHECK', async () => {
    const { service, inserts } = makeService();

    await service.createMany(ctx(), [sighting({ detectionConfidence: 1.4 })]);

    expect(inserts()[0].params[14]).toEqual([1]);
  });

  it('writes both coordinates or neither', async () => {
    const { service, inserts } = makeService();

    await service.createMany(ctx(), [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sighting({ coordinates: { lat: 51.5, lon: Number.NaN } as any }),
    ]);

    expect(inserts()[0].params[8]).toEqual([null]);
    expect(inserts()[0].params[9]).toEqual([null]);
  });

  it('reports rows the confirmation guard excluded rather than counting them written', async () => {
    const { service, query } = makeService();

    // RETURNING comes back empty: the row matched an existing sighting a human
    // had confirmed, so the DO UPDATE ... WHERE excluded it.
    query.mockResolvedValueOnce([]);

    const result = await service.createMany(ctx(), [sighting()]);

    expect(result.protectedByConfirmation).toBe(1);
    expect(result.written).toHaveLength(0);
  });

  it('does nothing at all for an empty batch', async () => {
    const { service, query } = makeService();

    const result = await service.createMany(ctx(), []);

    expect(query).not.toHaveBeenCalled();
    expect(result).toEqual({
      written: [],
      protectedByConfirmation: 0,
      duplicatesInBatch: 0,
      rejectedUnarbitered: 0,
    });
  });
});

/* ===================================================================== *
 * The statement itself — what a re-detection may and may not touch
 * ===================================================================== */

describe('ObjectObservationService — a re-detection never rewrites a decision', () => {
  async function emittedSql(): Promise<string> {
    const { service, inserts } = makeService();

    await service.createMany(ctx(), [sighting()]);

    return inserts()[0].sql;
  }

  it.each([
    'resolved_object_id',
    'resolved_product_id',
    'resolution_method',
    'resolution_confidence',
    'confirmed_by_user',
  ])('excludes %s from DO UPDATE SET', async (column) => {
    const sql = await emittedSql();
    const setClause = sql.slice(sql.indexOf('DO UPDATE SET'), sql.indexOf('RETURNING'));

    expect(setClause).not.toContain(`${column} = excluded.`);
  });

  it('freezes a confirmed row entirely, detection columns included', async () => {
    const sql = await emittedSql();

    // Stronger than ObjectPromoteStage's timestamp comparison, which can be
    // fooled by a writer that forgets updated_at: this reads the flag whose
    // whole purpose is to mean "a human said so".
    expect(sql).toContain('WHERE NOT o.confirmed_by_user');
  });

  it('refreshes the detection columns on an unconfirmed row', async () => {
    const sql = await emittedSql();

    expect(sql).toContain('label = excluded.label');
    expect(sql).toContain('bbox = excluded.bbox');
    expect(sql).toContain('detection_confidence = excluded.detection_confidence');
  });

  it('MERGES the jsonb bags rather than replacing them', async () => {
    const sql = await emittedSql();

    // A reviewer's note in attributes survives the next detector pass.
    expect(sql).toContain("attributes = COALESCE(o.attributes, '{}'::jsonb) || excluded.attributes");
    expect(sql).toContain("metadata   = COALESCE(o.metadata, '{}'::jsonb) || excluded.metadata");
  });

  it('lets the database mint the id, so uuid v7 ordering survives', async () => {
    const sql = await emittedSql();

    expect(sql).toContain('COALESCE(u.id, ci.gen_uuid_v7())');
  });

  it('writes geography from lon/lat in that order', async () => {
    const sql = await emittedSql();

    // ST_MakePoint takes X then Y. Transposing them is the one bug that
    // matters here, and it is silent.
    expect(sql).toContain('ST_SetSRID(ST_MakePoint(u.lon, u.lat), 4326)::geography');
  });

  it('touches ci.object_observations and nothing else', async () => {
    // Comments stripped first: the statement is what is under test, and the
    // prose explaining it legitimately names the tables this must not write.
    const sql = (await emittedSql()).replace(/--[^\n]*/g, '');

    // Nothing here mints an owned unit. That is ObjectResolutionService's job,
    // above an auto-mint confidence that does not exist yet.
    expect(sql).toContain('INSERT INTO ci.object_observations');
    expect(sql).not.toContain('ci.objects');
    expect(sql).not.toContain('ci.entities');
    expect(sql).not.toContain('ci.relationships');
  });
});

/* ===================================================================== *
 * resolve / confirm — the layers stay apart
 * ===================================================================== */

describe('ObjectObservationService.resolve — a machine decision is not a human one', () => {
  it("refuses resolutionMethod 'user'", async () => {
    const { service } = makeService();

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      service.resolve(ctx(), 'obs-1', { resolutionMethod: 'user' as any }),
    ).rejects.toThrow(/reserved for ObjectObservationService.confirm/);
  });

  it('never writes confirmed_by_user', async () => {
    const { service, findOne, update } = makeService();

    findOne.mockResolvedValue({ id: 'obs-1', confirmedByUser: false });

    await service.resolve(ctx(), 'obs-1', {
      resolvedObjectId: 'item-1',
      resolutionMethod: 'label',
    });

    expect(update.mock.calls[0][1]).not.toHaveProperty('confirmedByUser');
  });

  it('leaves a user-confirmed sighting untouched', async () => {
    const { service, findOne, update } = makeService();

    findOne.mockResolvedValue({ id: 'obs-1', confirmedByUser: true });

    const result = await service.resolve(ctx(), 'obs-1', {
      resolvedObjectId: 'item-2',
      resolutionMethod: 'embedding',
    });

    // Returned unchanged rather than thrown: a resolver sweeping a batch should
    // skip these, not abort.
    expect(update).not.toHaveBeenCalled();
    expect(result).toEqual({ id: 'obs-1', confirmedByUser: true });
  });

  it('clamps a resolution confidence and never invents one', async () => {
    const { service, findOne, update } = makeService();

    findOne.mockResolvedValue({ id: 'obs-1', confirmedByUser: false });

    await service.resolve(ctx(), 'obs-1', { resolutionMethod: 'label' });

    expect(update.mock.calls[0][1]).toEqual(expect.objectContaining({ resolutionConfidence: null }));
  });

  it('retracts a wrong resolution without destroying the sighting', async () => {
    const { service, findOne, update } = makeService();

    findOne.mockResolvedValue({ id: 'obs-1', confirmedByUser: false });

    await service.resolve(ctx(), 'obs-1', {
      resolvedObjectId: null,
      resolvedProductId: null,
      resolutionMethod: 'none',
    });

    expect(update.mock.calls[0][1]).toEqual(
      expect.objectContaining({ resolvedObjectId: null, resolutionMethod: 'none' }),
    );
  });

  it('returns null for an id that is not this user’s', async () => {
    const { service, findOne, update } = makeService();

    findOne.mockResolvedValue(null);

    expect(await service.resolve(ctx(), 'obs-x', { resolutionMethod: 'label' })).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });
});

describe('ObjectObservationService.confirm — the only writer of confirmed_by_user', () => {
  it('sets the flag and records the method as user', async () => {
    const { service, findOne, update } = makeService();

    findOne.mockResolvedValue({ id: 'obs-1', confirmedByUser: false });

    await service.confirm(ctx(), 'obs-1');

    expect(update.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        confirmedByUser: true,
        resolutionMethod: 'user',
        resolutionConfidence: 1,
      }),
    );
  });

  it('retracts the flag but keeps the link, because those are different claims', async () => {
    const { service, findOne, update } = makeService();

    findOne.mockResolvedValue({ id: 'obs-1', confirmedByUser: true, resolvedObjectId: 'item-1' });

    await service.confirm(ctx(), 'obs-1', false);

    const patch = update.mock.calls[0][1];

    // "I am no longer certain" is not "this was never linked".
    expect(patch.confirmedByUser).toBe(false);
    expect(patch).not.toHaveProperty('resolvedObjectId');
  });

  it('can attach the unit the human picked in the same call', async () => {
    const { service, findOne, update } = makeService();

    findOne.mockResolvedValue({ id: 'obs-1', confirmedByUser: false });

    await service.confirm(ctx(), 'obs-1', true, { resolvedObjectId: 'item-7' });

    expect(update.mock.calls[0][1]).toEqual(
      expect.objectContaining({ confirmedByUser: true, resolvedObjectId: 'item-7' }),
    );
  });
});

/* ===================================================================== *
 * Scoped reads
 * ===================================================================== */

describe('ObjectObservationService — reads are user-scoped', () => {
  it('scopes findById to the context user', async () => {
    const { service, findOne } = makeService();

    await service.findById(ctx(), 'obs-1');

    expect(findOne.mock.calls[0][0].where).toEqual({ id: 'obs-1', userId: USER });
  });

  it('drives the review queue off the same predicate as the partial index', async () => {
    const { service, find } = makeService();

    await service.findForReview(ctx());

    // object_observations_review_idx is WHERE NOT confirmed_by_user AND
    // resolved_object_id IS NULL — this query must match it to use it.
    const { where, order } = find.mock.calls[0][0];

    expect(where.confirmedByUser).toBe(false);
    expect(where.resolvedObjectId).toBeDefined();
    expect(order).toEqual({ observedAt: 'DESC' });
  });
});

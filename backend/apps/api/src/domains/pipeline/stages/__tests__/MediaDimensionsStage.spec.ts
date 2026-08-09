import { PipelineStateService } from '../../services/PipelineStateService';
import type { StageResult } from '../../types';
import { MediaDimensionsStage } from '../enrich/MediaDimensionsStage';

/**
 * `enrich.media_dimensions` — the first real leg on the ledger.
 *
 * Two halves, and the split is the whole argument for the rebuild:
 *
 *  1. **Selection** (`PipelineStateService.selectStale` driven with THIS stage's
 *     real `source`) — proves candidacy is decided by `ci.pipeline_state` and
 *     never by `ci.files.width`. The old listener's `width IS NULL` page is the
 *     canonical instance of the defect: the predicate that FOUND work was the
 *     predicate that DECLARED it done, so an unreadable file was re-fetched from
 *     object storage forever and a readable one could never be re-probed by a
 *     better decoder.
 *  2. **Decision** (`stage.run`) — proves every id gets exactly one answer and
 *     that no non-`done` answer is anonymous. The listener's `resolved/skipped/
 *     failed` counters were local variables that died with the job; nothing
 *     recorded WHICH file was skipped or WHY.
 *
 * The tests are written against the CONTRACT, not the implementation. There is
 * no Postgres: the fake `DataSource` recognises the sweep by its `LEFT JOIN
 * ci.pipeline_state` and evaluates THE ONE RULE in TypeScript from the six bound
 * parameters, so the assertions cover which rows come back for which ledger
 * states rather than a SQL string.
 */

/* ===================================================================== *
 * Fixtures
 * ===================================================================== */

const USER = '00000000-0000-4000-8000-0000000000aa';
const OTHER_USER = '00000000-0000-4000-8000-0000000000bb';
const ENTITY_TYPE = 'file';

/**
 * Ordered uuids. Canonical lowercase hex uuids compare byte-wise in Postgres and
 * lexically in JS in the SAME order, so the fake's keyset comparison is a
 * faithful stand-in for `s."id" > $5::uuid`.
 */
function fileId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

interface SourceRow {
  id: string;
  user_id: string;
  content_type: string;
  variant: string;
  key: string | null;
  deleted_at: Date | null;
  /** The stage's OUTPUT column. Nothing in selection may ever read it. */
  width: number | null;
}

function imageRow(n: number, overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: fileId(n),
    user_id: USER,
    content_type: 'image/jpeg',
    variant: 'ORIGINAL',
    key: `key-${n}`,
    deleted_at: null,
    width: null,
    ...overrides,
  };
}

type LedgerStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'quarantined';

interface LedgerRow {
  stageVersion: number;
  status: LedgerStatus;
  reason: string | null;
  nextAttemptAt: Date | null;
}

/* ===================================================================== *
 * Stage construction
 * ===================================================================== */

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

interface StageHarness {
  stage: MediaDimensionsStage;
  find: jest.Mock;
  setDimensions: jest.Mock;
  getFileContent: jest.Mock;
  getFileStream: jest.Mock;
  fromImageBuffer: jest.Mock;
  fromVideoStream: jest.Mock;
}

/** The stage with every collaborator stubbed. Probes default to "unreadable". */
function makeStage(rows: Array<{ id: string; key: string | null; contentType: string }> = []): StageHarness {
  const find = jest.fn(async () => rows);
  const fileRepository = { find };

  const setDimensions = jest.fn(async () => undefined);
  const getFileContent = jest.fn(async () => new Uint8Array([1, 2, 3]));
  const getFileStream = jest.fn(async () => ({ pipe: jest.fn() }));
  const fileService = { setDimensions, getFileContent, getFileStream };

  const fromImageBuffer = jest.fn(async () => null as { width: number; height: number } | null);
  const fromVideoStream = jest.fn(async () => null as { width: number; height: number } | null);
  const mediaDimensionsService = { fromImageBuffer, fromVideoStream };

  const stage = new MediaDimensionsStage(
    fileRepository as never,
    fileService as never,
    mediaDimensionsService as never,
    makeLogger() as never,
  );

  return { stage, find, setDimensions, getFileContent, getFileStream, fromImageBuffer, fromVideoStream };
}

/* ===================================================================== *
 * The fake DataSource: THE ONE RULE, evaluated
 * ===================================================================== */

function ledgerKey(entityType: string, entityId: string, stage: string): string {
  return `${entityType}|${entityId}|${stage}`;
}

/**
 * The stage's applicability predicate, mirrored in TypeScript.
 *
 * Kept deliberately faithful to `MEDIA_DIMENSIONS_SOURCE.predicate`: original
 * variant, not soft-deleted, locally stored, image or video. Note what it does
 * NOT consult — `width`. That absence is the fix, and the assertions below make
 * it observable rather than taking the fake's word for it.
 */
function isApplicable(row: SourceRow): boolean {
  return (
    row.variant === 'ORIGINAL' &&
    row.deleted_at == null &&
    row.key != null &&
    (row.content_type.startsWith('image/') || row.content_type.startsWith('video/'))
  );
}

function evaluateOneRule(
  rows: SourceRow[],
  ledger: Map<string, LedgerRow>,
  params: unknown[],
): Array<{ id: string }> {
  if (params.length !== 6) {
    throw new Error(
      `THE ONE RULE binds exactly six parameters ` +
        `($1 entity_type, $2 stage, $3 user_id, $4 stage_version, $5 cursor, $6 limit); got ${params.length}`,
    );
  }

  const [entityType, stageId, userId, version, cursor, limit] = params as [
    string,
    string,
    string,
    number,
    string | null,
    number,
  ];

  const now = Date.now();

  return rows
    .filter((row) => row.user_id === userId)
    .filter(isApplicable)
    .filter((row) => {
      const entry = ledger.get(ledgerKey(entityType, row.id, stageId));

      // p.entity_id IS NULL — never processed.
      if (entry === undefined) {
        return true;
      }

      // p.stage_version < $4 — the enricher improved since this row was done.
      if (entry.stageVersion < version) {
        return true;
      }

      // (p.status = 'failed' AND p.next_attempt_at <= now()) — retry is due. A
      // NULL gate makes the comparison NULL, i.e. NOT selected.
      return entry.status === 'failed' && entry.nextAttemptAt != null && entry.nextAttemptAt.getTime() <= now;
    })
    .filter((row) => cursor == null || row.id > cursor)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, limit)
    .map((row) => ({ id: row.id }));
}

function makeLedgerHarness(rows: SourceRow[]) {
  const ledger = new Map<string, LedgerRow>();
  const sweeps: Array<{ sql: string; params: unknown[] }> = [];
  const writes: Array<{ sql: string; params: unknown[] }> = [];

  const query = jest.fn(async (raw: string, params?: unknown[]) => {
    const sql = raw.replace(/\s+/g, ' ').trim();

    // The sweep is the only statement that LEFT JOINs the ledger onto a source.
    if (/left\s+join\s+ci\.pipeline_state/i.test(sql)) {
      sweeps.push({ sql, params: params ?? [] });

      return evaluateOneRule(rows, ledger, params ?? []);
    }

    if (/ci\.pipeline_state/i.test(sql) && !/^select/i.test(sql)) {
      writes.push({ sql, params: params ?? [] });

      return [];
    }

    return [];
  });

  const service = new PipelineStateService({ query } as never, makeLogger() as never);

  return {
    service,
    sweeps,
    writes,
    seed: (entityId: string, row: LedgerRow, stageId: string) =>
      ledger.set(ledgerKey(ENTITY_TYPE, entityId, stageId), row),
  };
}

/**
 * The real stage, at a different version.
 *
 * `STAGE_VERSIONS` is the production declaration and a test must not mutate it,
 * so the bump is modelled by handing the sweep the same id, entity types and
 * SOURCE with a higher version — which is exactly what incrementing the constant
 * does to the value the sweep binds as `$4`.
 */
function atVersion(stage: MediaDimensionsStage, version: number) {
  return {
    id: stage.id,
    version,
    queue: stage.queue,
    entityTypes: stage.entityTypes,
    source: stage.source,
    run: stage.run.bind(stage),
  };
}

/* ===================================================================== *
 * Tests
 * ===================================================================== */

describe('MediaDimensionsStage — candidate selection asks the LEDGER, not ci.files.width', () => {
  it('selects a file whose width is ALREADY SET when the ledger has never seen it', async () => {
    // The repair `width IS NULL` made impossible. Under the old listener this
    // row was invisible forever, so a fixed EXIF-orientation reading (or a
    // better decoder) could never revisit the files it got wrong.
    const { stage } = makeStage();
    const h = makeLedgerHarness([imageRow(1, { width: 4032 })]);

    const ids = await h.service.selectStale(stage as never, USER, null, 10);

    expect(ids).toEqual([fileId(1)]);
  });

  it('never names the output columns in the sweep', async () => {
    const { stage } = makeStage();
    const h = makeLedgerHarness([imageRow(1)]);

    await h.service.selectStale(stage as never, USER, null, 10);

    const sql = h.sweeps[0].sql.toLowerCase();
    expect(sql).not.toMatch(/\bwidth\b/);
    expect(sql).not.toMatch(/\bheight\b/);
  });

  it('splices the stage applicability predicate verbatim, and it says what a row IS', async () => {
    const { stage } = makeStage();
    const h = makeLedgerHarness([imageRow(1)]);

    await h.service.selectStale(stage as never, USER, null, 10);

    expect(h.sweeps[0].sql).toContain(stage.source.predicate);
    // Applicability, never completion: the predicate must not mention the
    // ledger (StageRegistry rejects that) nor the column the stage writes.
    expect(stage.source.predicate).not.toMatch(/width|height|pipeline_state/i);
  });

  it('excludes previews, tombstones, non-media and remote files by applicability alone', async () => {
    const { stage } = makeStage();
    const h = makeLedgerHarness([
      imageRow(1),
      imageRow(2, { variant: 'THUMBNAIL' }),
      imageRow(3, { deleted_at: new Date() }),
      imageRow(4, { content_type: 'application/pdf' }),
      imageRow(5, { key: null }),
      imageRow(6, { user_id: OTHER_USER }),
      imageRow(7, { content_type: 'video/mp4' }),
    ]);

    const ids = await h.service.selectStale(stage as never, USER, null, 10);

    expect(ids).toEqual([fileId(1), fileId(7)]);
  });

  it('stops re-selecting a row the stage skipped — the forever-retried unreadable file', async () => {
    // The bug this deletes: a corrupt/undecodable original stayed `width IS
    // NULL`, so every run re-fetched it from object storage and re-decoded it,
    // for as long as the appliance existed.
    const { stage } = makeStage();
    const h = makeLedgerHarness([imageRow(1), imageRow(2)]);
    h.seed(
      fileId(1),
      { stageVersion: stage.version, status: 'skipped', reason: 'probe_failed', nextAttemptAt: null },
      stage.id,
    );

    const ids = await h.service.selectStale(stage as never, USER, null, 10);

    expect(ids).toEqual([fileId(2)]);
  });

  it('re-selects done AND skipped rows once the stage version is bumped', async () => {
    // A better probe repairs history. The skipped row matters most: a wrong skip
    // is as repairable as a wrong answer, and `width IS NULL` could express
    // neither.
    const { stage } = makeStage();
    const h = makeLedgerHarness([imageRow(1), imageRow(2)]);
    h.seed(
      fileId(1),
      { stageVersion: stage.version, status: 'done', reason: null, nextAttemptAt: null },
      stage.id,
    );
    h.seed(
      fileId(2),
      { stageVersion: stage.version, status: 'skipped', reason: 'probe_failed', nextAttemptAt: null },
      stage.id,
    );

    await expect(h.service.selectStale(stage as never, USER, null, 10)).resolves.toEqual([]);
    await expect(
      h.service.selectStale(atVersion(stage, stage.version + 1) as never, USER, null, 10),
    ).resolves.toEqual([fileId(1), fileId(2)]);
  });

  it('binds the version off the stage, so bumping STAGE_VERSIONS is the whole mechanism', async () => {
    const { stage } = makeStage();
    const h = makeLedgerHarness([imageRow(1)]);

    await h.service.selectStale(stage as never, USER, null, 10);

    expect(h.sweeps[0].params[3]).toBe(stage.version);
  });
});

describe('MediaDimensionsStage — a failure sets a retry time, a skip does not', () => {
  it('gates a failed row behind next_attempt_at and re-selects it only once due', async () => {
    const { stage } = makeStage();
    const h = makeLedgerHarness([imageRow(1)]);

    h.seed(
      fileId(1),
      {
        stageVersion: stage.version,
        status: 'failed',
        reason: 'object_storage_read_failed',
        nextAttemptAt: new Date(Date.now() + 60_000),
      },
      stage.id,
    );
    await expect(h.service.selectStale(stage as never, USER, null, 10)).resolves.toEqual([]);

    h.seed(
      fileId(1),
      {
        stageVersion: stage.version,
        status: 'failed',
        reason: 'object_storage_read_failed',
        nextAttemptAt: new Date(Date.now() - 1_000),
      },
      stage.id,
    );
    await expect(h.service.selectStale(stage as never, USER, null, 10)).resolves.toEqual([fileId(1)]);
  });

  it('computes the retry gate in SQL when the stage reports failed, and not when it reports skipped', async () => {
    const { stage } = makeStage();
    const h = makeLedgerHarness([imageRow(1), imageRow(2)]);

    await h.service.complete(
      stage as never,
      ENTITY_TYPE,
      new Map<string, StageResult>([
        [fileId(1), { outcome: 'failed', reason: 'object_storage_read_failed' }],
        [fileId(2), { outcome: 'skipped', reason: 'probe_failed' }],
      ]),
    );

    expect(h.writes).toHaveLength(1);
    const sql = h.writes[0].sql.toLowerCase();

    // The gate is a column computed from the row's own attempt count, not an
    // in-process timer — which is why backoff survives a restart.
    expect(sql).toMatch(/next_attempt_at\s*=\s*case/);
    expect(sql).toContain("when excluded.status = 'failed'");
    expect(sql).toContain('make_interval');
    expect(h.writes[0].params.flat()).toEqual(
      expect.arrayContaining(['failed', 'skipped', 'object_storage_read_failed', 'probe_failed']),
    );
  });

  it('refuses to write a skip or a failure with no reason', async () => {
    // Enforced before a single row is written. A nameless skip is
    // indistinguishable, three months later, from data that never arrived.
    const { stage } = makeStage();
    const h = makeLedgerHarness([imageRow(1)]);

    await expect(
      h.service.complete(
        stage as never,
        ENTITY_TYPE,
        new Map<string, StageResult>([[fileId(1), { outcome: 'skipped' }]]),
      ),
    ).rejects.toThrow(/no reason/i);

    expect(h.writes).toHaveLength(0);
  });
});

describe('MediaDimensionsStage.run — every id gets exactly one answer', () => {
  const ctx = { userId: USER };

  it('records dimensions for a readable image and reports done', async () => {
    const h = makeStage([{ id: fileId(1), key: 'key-1', contentType: 'image/jpeg' }]);
    h.fromImageBuffer.mockResolvedValue({ width: 1024, height: 768 });

    const results = await h.stage.run(ctx, [fileId(1)]);

    expect(h.setDimensions).toHaveBeenCalledWith(ctx, fileId(1), { width: 1024, height: 768 });
    expect(results.get(fileId(1))).toEqual({
      outcome: 'done',
      detail: { width: 1024, height: 768 },
    });
  });

  it('probes a video through the stream path', async () => {
    const h = makeStage([{ id: fileId(1), key: 'key-1', contentType: 'video/mp4' }]);
    h.fromVideoStream.mockResolvedValue({ width: 1920, height: 1080 });

    const results = await h.stage.run(ctx, [fileId(1)]);

    expect(h.getFileStream).toHaveBeenCalledTimes(1);
    expect(h.getFileContent).not.toHaveBeenCalled();
    expect(results.get(fileId(1))?.outcome).toBe('done');
  });

  it('SKIPS an un-probeable file WITH a reason instead of leaving it NULL forever', async () => {
    // The headline behaviour change. `fromImageBuffer` returning null is a HEIC
    // whose HEIF boxes the bundled libheif cannot parse, or a truncated JPEG.
    // The old listener wrote nothing and incremented a local counter; the row
    // stayed a candidate on every future run, permanently.
    const h = makeStage([{ id: fileId(1), key: 'key-1', contentType: 'image/jpeg' }]);
    h.fromImageBuffer.mockResolvedValue(null);

    const results = await h.stage.run(ctx, [fileId(1)]);

    expect(h.setDimensions).not.toHaveBeenCalled();
    expect(results.get(fileId(1))).toEqual({ outcome: 'skipped', reason: 'probe_failed' });
  });

  it('FAILS (not skips) when object storage throws, so a dead Minio is a rising failure count', async () => {
    const h = makeStage([{ id: fileId(1), key: 'key-1', contentType: 'image/jpeg' }]);
    h.getFileContent.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:9000'));

    const results = await h.stage.run(ctx, [fileId(1)]);

    const result = results.get(fileId(1));
    expect(result?.outcome).toBe('failed');
    expect(result?.reason).toBe('object_storage_read_failed');
    // Failed, not skipped: the retry gate and the attempt budget only apply to
    // failures, and a transient outage must come back on its own.
    expect(result?.detail).toMatchObject({ message: expect.stringContaining('ECONNREFUSED') });
  });

  it('fails only the row whose write failed, and separately from a read failure', async () => {
    const h = makeStage([
      { id: fileId(1), key: 'key-1', contentType: 'image/jpeg' },
      { id: fileId(2), key: 'key-2', contentType: 'image/jpeg' },
    ]);
    h.fromImageBuffer.mockResolvedValue({ width: 10, height: 10 });
    h.setDimensions.mockRejectedValueOnce(new Error('deadlock detected')).mockResolvedValueOnce(undefined);

    const results = await h.stage.run(ctx, [fileId(1), fileId(2)]);

    expect(results.get(fileId(1))?.reason).toBe('dimension_write_failed');
    expect(results.get(fileId(2))?.outcome).toBe('done');
  });

  it('one corrupt file does not take the slice down with it', async () => {
    // A throw out of `run` fails every claimed id with one shared reason, which
    // would charge 199 healthy rows an attempt for one bad file.
    const h = makeStage([
      { id: fileId(1), key: 'key-1', contentType: 'image/jpeg' },
      { id: fileId(2), key: 'key-2', contentType: 'image/jpeg' },
      { id: fileId(3), key: 'key-3', contentType: 'image/jpeg' },
    ]);
    h.getFileContent.mockRejectedValueOnce(new Error('s3 down')).mockResolvedValue(new Uint8Array([1, 2, 3]));
    h.fromImageBuffer.mockResolvedValue({ width: 8, height: 8 });

    const results = await h.stage.run(ctx, [fileId(1), fileId(2), fileId(3)]);

    expect(results.size).toBe(3);
    expect([...results.values()].filter((r) => r.outcome === 'done')).toHaveLength(2);
  });

  it('answers for an id whose row is gone rather than staying silent', async () => {
    // Silence is recorded by PipelineSliceListener as `stage_returned_no_result`,
    // which is correct but tells nobody what happened.
    const h = makeStage([]);

    const results = await h.stage.run(ctx, [fileId(1)]);

    expect(results.get(fileId(1))).toEqual({
      outcome: 'skipped',
      reason: 'source_row_missing',
      detail: { stage: 'enrich.media_dimensions' },
    });
  });

  it('scopes the row load to the slice user', async () => {
    // A slice can arrive from a dead letter replayed weeks later; re-scoping is
    // the difference between "not yours" and probing someone else's file.
    const h = makeStage([]);

    await h.stage.run(ctx, [fileId(1)]);

    expect(h.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: USER }) }),
    );
  });

  it('gives every non-done outcome a reason — the ledger refuses one without', async () => {
    const h = makeStage([
      { id: fileId(1), key: null, contentType: 'image/jpeg' },
      { id: fileId(2), key: 'key-2', contentType: 'application/pdf' },
      { id: fileId(3), key: 'key-3', contentType: 'image/jpeg' },
    ]);
    h.fromImageBuffer.mockResolvedValue(null);

    const results = await h.stage.run(ctx, [fileId(1), fileId(2), fileId(3), fileId(4)]);

    for (const [id, result] of results) {
      if (result.outcome !== 'done') {
        expect(`${id}:${result.reason ?? ''}`).not.toMatch(/:$/);
      }
    }

    expect(results.get(fileId(1))?.reason).toBe('no_object_key');
    expect(results.get(fileId(2))?.reason).toBe('unsupported_content_type');
    expect(results.get(fileId(3))?.reason).toBe('probe_failed');
    expect(results.get(fileId(4))?.reason).toBe('source_row_missing');
  });

  it('returns an empty map for an empty slice without touching the database', async () => {
    const h = makeStage([]);

    const results = await h.stage.run(ctx, []);

    expect(results.size).toBe(0);
    expect(h.find).not.toHaveBeenCalled();
  });
});

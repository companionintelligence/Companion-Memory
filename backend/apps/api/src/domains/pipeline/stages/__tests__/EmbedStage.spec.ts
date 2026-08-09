import { PipelineStateService } from '../../services/PipelineStateService';
import type { StageResult } from '../../types';
import {
  assertEmbedModelGenerations,
  EMBED_MODEL_GENERATIONS,
  EMBEDDING_DIMENSION,
  EmbedStage,
  embedStageVersion,
  INDEX_EMBED_STAGE_ID,
} from '../index/EmbedStage';

/**
 * `index.embed` — the conversion that justifies the whole rebuild.
 *
 * The other legs get a re-run lever they never had. This one gets something
 * stronger: its version is a FUNCTION OF THE EMBEDDING MODEL, so changing
 * `CI_EMBED_MODEL` re-embeds the corpus by itself. The tests below are ordered
 * to make that argument in sequence:
 *
 *  1. the version really is derived from `(model, dimension)`;
 *  2. an undeclared model is refused rather than given an invented version
 *     (an invented one can go DOWN, and a version that goes down hides the
 *     whole corpus from every future sweep);
 *  3. a model change therefore re-selects rows that are already embedded —
 *     which `LEFT JOIN ci_search.embeddings ... WHERE e.entity_id IS NULL`
 *     could never do, because an embedding's EXISTENCE was its definition of
 *     done, whatever produced it;
 *  4. deliberate low-value skips are recorded with their reason instead of
 *     being invisible no-ops;
 *  5. an unreachable Ollama is a rising `failed` count with a retry gate, not a
 *     counter that quietly stops climbing.
 */

/* ===================================================================== *
 * Fixtures
 * ===================================================================== */

const USER = '00000000-0000-4000-8000-0000000000aa';
const OTHER_USER = '00000000-0000-4000-8000-0000000000bb';
const ENTITY_TYPE = 'content';

function contentId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

interface ContentRow {
  id: string;
  type: string | null;
  title: string | null;
  text: string | null;
  url: string | null;
  mimetype: string | null;
}

function contentRow(n: number, overrides: Partial<ContentRow> = {}): ContentRow {
  return {
    id: contentId(n),
    type: null,
    title: null,
    text: 'a genuinely substantive paragraph a user might plausibly search for',
    url: null,
    mimetype: null,
    ...overrides,
  };
}

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

/** A 768-float vector, the shape `ci_search.embeddings.embedding` accepts. */
function vector(seed: number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSION }, (_, i) => (seed + i) / 1000);
}

/* ===================================================================== *
 * Stage construction
 * ===================================================================== */

interface RecordedQuery {
  sql: string;
  params: unknown[] | undefined;
}

function makeStage(rows: ContentRow[] = []) {
  // Recorded rather than read off `mock.calls`, so a test can assert what each
  // statement actually BOUND — the row load's user scoping, and the vectors the
  // upsert wrote.
  const loads: RecordedQuery[] = [];
  const upserts: RecordedQuery[] = [];
  let upsertError: Error | null = null;

  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    if (/insert\s+into\s+ci_search\.embeddings/i.test(sql)) {
      upserts.push({ sql, params });

      if (upsertError != null) {
        throw upsertError;
      }

      return [];
    }

    loads.push({ sql, params });

    return rows;
  });
  const dataSource = { query };

  const generateEmbeddings = jest.fn(async (inputs: string[]) => inputs.map((_, i) => vector(i)));
  const embeddingGenerationService = { generateEmbeddings };

  const stage = new EmbedStage(
    dataSource as never,
    embeddingGenerationService as never,
    makeLogger() as never,
  );

  return {
    stage,
    query,
    loads,
    upserts,
    generateEmbeddings,
    failUpsertWith: (error: Error) => {
      upsertError = error;
    },
  };
}

/* ===================================================================== *
 * The fake DataSource: THE ONE RULE, evaluated
 * ===================================================================== */

type LedgerStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'quarantined';

interface LedgerRow {
  stageVersion: number;
  status: LedgerStatus;
  reason: string | null;
  nextAttemptAt: Date | null;
}

interface SourceRow {
  id: string;
  user_id: string;
  /** The stage's OUTPUT. Selection must never consult it. */
  hasEmbedding: boolean;
}

function sourceRow(n: number, overrides: Partial<SourceRow> = {}): SourceRow {
  return { id: contentId(n), user_id: USER, hasEmbedding: false, ...overrides };
}

function ledgerKey(entityId: string, stageId: string): string {
  return `${ENTITY_TYPE}|${entityId}|${stageId}`;
}

function evaluateOneRule(
  rows: SourceRow[],
  ledger: Map<string, LedgerRow>,
  params: unknown[],
): Array<{ id: string }> {
  if (params.length !== 6) {
    throw new Error(`THE ONE RULE binds exactly six parameters; got ${params.length}`);
  }

  const [, stageId, userId, version, cursor, limit] = params as [
    string,
    string,
    string,
    number,
    string | null,
    number,
  ];

  const now = Date.now();

  return (
    rows
      .filter((row) => row.user_id === userId)
      // `INDEX_EMBED_SOURCE` declares no applicability predicate: every content
      // row belonging to the user is a candidate. Note what is NOT mirrored
      // here — `hasEmbedding`. The fixture carries it purely so a test can prove
      // an already-embedded row is still selected when the ledger says so.
      .filter((row) => {
        const entry = ledger.get(ledgerKey(row.id, stageId));

        if (entry === undefined) {
          return true;
        }

        if (entry.stageVersion < version) {
          return true;
        }

        return (
          entry.status === 'failed' && entry.nextAttemptAt != null && entry.nextAttemptAt.getTime() <= now
        );
      })
      .filter((row) => cursor == null || row.id > cursor)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, limit)
      .map((row) => ({ id: row.id }))
  );
}

function makeLedgerHarness(rows: SourceRow[]) {
  const ledger = new Map<string, LedgerRow>();
  const sweeps: Array<{ sql: string; params: unknown[] }> = [];
  const writes: Array<{ sql: string; params: unknown[] }> = [];

  const query = jest.fn(async (raw: string, params?: unknown[]) => {
    const sql = raw.replace(/\s+/g, ' ').trim();

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

  return {
    service: new PipelineStateService({ query } as never, makeLogger() as never),
    sweeps,
    writes,
    seed: (entityId: string, row: LedgerRow, stageId: string) =>
      ledger.set(ledgerKey(entityId, stageId), row),
  };
}

/**
 * The stage as it would be constructed under a different embedding model:
 * everything the sweep reads, with the version that model derives.
 */
function atVersion(stage: EmbedStage, version: number) {
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

describe('EmbedStage — the version is derived from (model, dimension)', () => {
  it('resolves the declared generation for the shipped default model', () => {
    expect(embedStageVersion('nomic-embed-text', 768)).toBe(1);
  });

  it('reports the same version the live configuration derives', () => {
    const { stage } = makeStage();

    expect(stage.version).toBe(embedStageVersion());
    expect(stage.id).toBe(INDEX_EMBED_STAGE_ID);
  });

  it('gives a different model a different version — the whole mechanism, in one line', () => {
    const generations = { ...EMBED_MODEL_GENERATIONS, 'mxbai-embed-large@1024': 2 };

    expect(embedStageVersion('nomic-embed-text', 768, generations)).toBe(1);
    expect(embedStageVersion('mxbai-embed-large', 1024, generations)).toBe(2);
  });

  it('treats the DIMENSION as part of the identity, so a re-dimension re-embeds', () => {
    // The same model name at a different pgvector width is a different vector
    // space. Keying on the model alone would let a `vector(768)` → `vector(1024)`
    // migration leave every existing row looking current.
    const generations = { ...EMBED_MODEL_GENERATIONS, 'nomic-embed-text@1024': 2 };

    expect(embedStageVersion('nomic-embed-text', 768, generations)).toBe(1);
    expect(embedStageVersion('nomic-embed-text', 1024, generations)).toBe(2);
  });

  it('REFUSES an undeclared model rather than inventing a version', () => {
    // An invented version (a hash, say) is uniformly distributed, so it lands
    // BELOW the current one about half the time — and a version that goes down
    // makes `stage_version < $current` false for every already-embedded row,
    // hiding the entire corpus from every future sweep while the index quietly
    // holds two models' vectors in one column.
    expect(() => embedStageVersion('some-new-model', 768)).toThrow(/no embedding generation declared/i);
  });

  it('names the exact line to add, with the next free generation', () => {
    expect(() => embedStageVersion('some-new-model', 768)).toThrow(/'some-new-model@768': 2/);
  });

  it('rejects a generation map that reuses a number for two models', () => {
    // Two models at the same generation means switching between them re-embeds
    // nothing — the original defect, reintroduced inside the fix.
    expect(() => assertEmbedModelGenerations({ 'a@768': 1, 'b@768': 1 })).toThrow(/append-only and unique/i);
  });

  it('rejects a fractional or zero generation', () => {
    // `stage_version` is INTEGER in Postgres: 1.5 truncates to 1, so the "bump"
    // would be a silent no-op. 0 makes rows stranded in `running` unreclaimable.
    expect(() => assertEmbedModelGenerations({ 'a@768': 1.5 })).toThrow(/integer >= 1/);
    expect(() => assertEmbedModelGenerations({ 'a@768': 0 })).toThrow(/integer >= 1/);
  });

  it('keeps the shipped map valid', () => {
    expect(() => assertEmbedModelGenerations()).not.toThrow();
  });
});

describe('EmbedStage — candidate selection asks the LEDGER, not ci_search.embeddings', () => {
  it('selects a row that ALREADY HAS an embedding when the ledger has never seen it', async () => {
    // `SearchIndexBackfillService.missingIds` anti-joins `ci_search.embeddings`,
    // so this row is finished forever regardless of which model produced the
    // vector. That is the same one-way ratchet as `width IS NULL`, in a
    // different table.
    const { stage } = makeStage();
    const h = makeLedgerHarness([sourceRow(1, { hasEmbedding: true })]);

    const ids = await h.service.selectStale(stage as never, USER, null, 10);

    expect(ids).toEqual([contentId(1)]);
  });

  it('reads exactly two tables: ci.content and the ledger', async () => {
    const { stage } = makeStage();
    const h = makeLedgerHarness([sourceRow(1)]);

    await h.service.selectStale(stage as never, USER, null, 10);

    const sql = h.sweeps[0].sql.toLowerCase();
    expect(sql).toContain('"ci"."content"');
    expect(sql).toContain('ci.pipeline_state');
    // No anti-join against the output table, and none against the convergence
    // hack that exists only to make such an anti-join terminate.
    expect(sql).not.toContain('ci_search.embeddings');
    expect(sql).not.toContain('ci_search.index_skips');
  });

  it('CHANGING THE MODEL RE-SELECTS EVERY EMBEDDED ROW (the headline capability)', async () => {
    const { stage } = makeStage();
    const h = makeLedgerHarness([sourceRow(1), sourceRow(2), sourceRow(3)]);

    // The whole corpus, embedded and recorded by the current model.
    for (const n of [1, 2, 3]) {
      h.seed(
        contentId(n),
        { stageVersion: stage.version, status: 'done', reason: null, nextAttemptAt: null },
        stage.id,
      );
    }

    await expect(h.service.selectStale(stage as never, USER, null, 10)).resolves.toEqual([]);

    // An operator sets CI_EMBED_MODEL to a newly declared model and restarts.
    // No backfill script, no TRUNCATE, no `forced` flag: the derived version
    // moves and every row is stale.
    const newModelVersion = embedStageVersion('mxbai-embed-large', 1024, {
      ...EMBED_MODEL_GENERATIONS,
      'mxbai-embed-large@1024': stage.version + 1,
    });

    await expect(
      h.service.selectStale(atVersion(stage, newModelVersion) as never, USER, null, 10),
    ).resolves.toEqual([contentId(1), contentId(2), contentId(3)]);
  });

  it('re-selects deliberately SKIPPED rows on a model change too', async () => {
    // A row skipped as `too-short` under one model is a judgement about the
    // text, but the minimum length is configuration and the model is not — both
    // are re-openable. `ci_search.index_skips` could only ever be cleared by
    // deleting rows from it.
    const { stage } = makeStage();
    const h = makeLedgerHarness([sourceRow(1)]);
    h.seed(
      contentId(1),
      { stageVersion: stage.version, status: 'skipped', reason: 'too-short', nextAttemptAt: null },
      stage.id,
    );

    await expect(h.service.selectStale(stage as never, USER, null, 10)).resolves.toEqual([]);
    await expect(
      h.service.selectStale(atVersion(stage, stage.version + 1) as never, USER, null, 10),
    ).resolves.toEqual([contentId(1)]);
  });

  it('does not cross the user boundary', async () => {
    const { stage } = makeStage();
    const h = makeLedgerHarness([sourceRow(1), sourceRow(2, { user_id: OTHER_USER })]);

    await expect(h.service.selectStale(stage as never, USER, null, 10)).resolves.toEqual([contentId(1)]);
  });
});

describe('EmbedStage.run — deliberate skips are recorded, with the reason', () => {
  const ctx = { userId: USER };

  it('embeds a substantive row and upserts the vector under the owning user', async () => {
    const h = makeStage([contentRow(1)]);

    const results = await h.stage.run(ctx, [contentId(1)]);

    expect(h.generateEmbeddings).toHaveBeenCalledTimes(1);
    expect(h.upserts).toHaveLength(1);

    const [entityType, userId, , entityIds, vectors] = h.upserts[0].params as [
      string,
      string,
      string[],
      string[],
      string[],
    ];
    expect(entityType).toBe(ENTITY_TYPE);
    expect(userId).toBe(USER);
    expect(entityIds).toEqual([contentId(1)]);
    // The pgvector text literal, mirroring the entity's column transformer.
    expect(vectors[0]).toMatch(/^\[.+\]$/);

    expect(results.get(contentId(1))).toEqual({ outcome: 'done' });
  });

  it('writes the whole slice in ONE upsert, not one per row', async () => {
    // The per-row version of this pattern is why the search-index queue sat
    // >95 % undrained: 200 rows meant 200 round trips.
    const h = makeStage([contentRow(1), contentRow(2), contentRow(3)]);

    await h.stage.run(ctx, [contentId(1), contentId(2), contentId(3)]);

    expect(h.upserts).toHaveLength(1);
    expect(h.upserts[0].sql).toMatch(/on conflict \(entity_type, entity_id\) do update/i);
  });

  it.each([
    ['empty', { text: null }],
    ['too-short', { text: 'ab' }],
    ['trivial', { text: 'Loved an image' }],
    ['url-only', { text: 'https://example.com/some/path' }],
  ])('records a %s row as skipped with that exact reason', async (reason, overrides) => {
    // These four are already known to `embedSkipReason` and already honoured by
    // the live listeners. What was missing is the RECORD: a skipped row simply
    // had no `ci_search.embeddings` entry, which is indistinguishable from a row
    // that failed, or one Ollama never reached. The reason is reproduced
    // verbatim rather than re-spelled, so there is one vocabulary for one
    // decision.
    const h = makeStage([contentRow(1, overrides as Partial<ContentRow>)]);

    const results = await h.stage.run(ctx, [contentId(1)]);

    expect(results.get(contentId(1))).toEqual({ outcome: 'skipped', reason });
    // A skip must cost nothing. Calling a contended GPU to discover the text is
    // two characters long is the cost the ledger removes.
    expect(h.generateEmbeddings).not.toHaveBeenCalled();
    expect(h.upserts).toHaveLength(0);
  });

  it('answers for an id whose row is gone rather than staying silent', async () => {
    const h = makeStage([]);

    const results = await h.stage.run(ctx, [contentId(1)]);

    expect(results.get(contentId(1))).toEqual({ outcome: 'skipped', reason: 'source_row_missing' });
  });

  it('batches one Ollama call for the whole slice, skips excluded', async () => {
    const h = makeStage([contentRow(1), contentRow(2, { text: 'ok' }), contentRow(3)]);

    const results = await h.stage.run(ctx, [contentId(1), contentId(2), contentId(3)]);

    expect(h.generateEmbeddings).toHaveBeenCalledTimes(1);
    expect(h.generateEmbeddings.mock.calls[0][0]).toHaveLength(2);
    expect(results.get(contentId(2))?.outcome).toBe('skipped');
    expect(results.get(contentId(1))?.outcome).toBe('done');
    expect(results.get(contentId(3))?.outcome).toBe('done');
  });

  it('scopes the row load to the slice user', async () => {
    const h = makeStage([]);

    await h.stage.run(ctx, [contentId(1)]);

    expect(h.loads[0].sql).toContain('ci.content');
    expect(h.loads[0].params).toEqual([[contentId(1)], USER]);
  });

  it('returns an empty map for an empty slice without touching the database', async () => {
    const h = makeStage([]);

    const results = await h.stage.run(ctx, []);

    expect(results.size).toBe(0);
    expect(h.query).not.toHaveBeenCalled();
  });
});

describe('EmbedStage.run — a dead Ollama is a rising failure count, not a flat counter', () => {
  const ctx = { userId: USER };

  it('fails every id in the batch with ollama_unreachable when the host refuses connections', async () => {
    const h = makeStage([contentRow(1), contentRow(2)]);
    h.generateEmbeddings.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:11434'));

    const results = await h.stage.run(ctx, [contentId(1), contentId(2)]);

    for (const id of [contentId(1), contentId(2)]) {
      const result = results.get(id);
      expect(result?.outcome).toBe('failed');
      expect(result?.reason).toBe('ollama_unreachable');
    }
  });

  it.each(['fetch failed', 'UND_ERR_CONNECT_TIMEOUT', 'getaddrinfo ENOTFOUND ollama'])(
    'classifies %s as unreachable',
    async (message) => {
      const h = makeStage([contentRow(1)]);
      h.generateEmbeddings.mockRejectedValue(new Error(message));

      const results = await h.stage.run(ctx, [contentId(1)]);

      expect(results.get(contentId(1))?.reason).toBe('ollama_unreachable');
    },
  );

  it('separates "Ollama answered and refused" from "Ollama is not there"', async () => {
    // Both are failures with a retry gate; only the reason differs, and the
    // reason is what an operator groups by. A model that is not pulled is a
    // one-command fix; a dead host is an incident.
    const h = makeStage([contentRow(1)]);
    h.generateEmbeddings.mockRejectedValue(new Error('model "nomic-embed-text" not found, try pulling it'));

    const results = await h.stage.run(ctx, [contentId(1)]);

    expect(results.get(contentId(1))?.reason).toBe('embed_call_failed');
  });

  it('does not swallow the failure as a skip — the outage must be visible as a FAILURE', async () => {
    // The distinction that makes the count useful. A skip is terminal at this
    // version and would make an outage look like a corpus that legitimately had
    // nothing to embed.
    const h = makeStage([contentRow(1)]);
    h.generateEmbeddings.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const results = await h.stage.run(ctx, [contentId(1)]);

    expect(results.get(contentId(1))?.outcome).not.toBe('skipped');
    expect(results.get(contentId(1))?.outcome).not.toBe('done');
  });

  it('a failed row gets a retry gate and comes back only once it is due', async () => {
    const { stage } = makeStage();
    const h = makeLedgerHarness([sourceRow(1)]);

    h.seed(
      contentId(1),
      {
        stageVersion: stage.version,
        status: 'failed',
        reason: 'ollama_unreachable',
        nextAttemptAt: new Date(Date.now() + 300_000),
      },
      stage.id,
    );
    await expect(h.service.selectStale(stage as never, USER, null, 10)).resolves.toEqual([]);

    h.seed(
      contentId(1),
      {
        stageVersion: stage.version,
        status: 'failed',
        reason: 'ollama_unreachable',
        nextAttemptAt: new Date(Date.now() - 1_000),
      },
      stage.id,
    );
    await expect(h.service.selectStale(stage as never, USER, null, 10)).resolves.toEqual([contentId(1)]);
  });

  it('writes the retry gate in SQL from the row own attempt count, so backoff survives a restart', async () => {
    const { stage } = makeStage();
    const h = makeLedgerHarness([sourceRow(1)]);

    await h.service.complete(
      stage as never,
      ENTITY_TYPE,
      new Map<string, StageResult>([[contentId(1), { outcome: 'failed', reason: 'ollama_unreachable' }]]),
    );

    const sql = h.writes[0].sql.toLowerCase();
    expect(sql).toMatch(/next_attempt_at\s*=\s*case/);
    expect(sql).toContain('make_interval');
    expect(h.writes[0].params.flat()).toEqual(expect.arrayContaining(['failed', 'ollama_unreachable']));
  });

  it('fails every row the upsert covered, because one statement has one outcome', async () => {
    // A single bulk upsert commits or it does not. Attributing the failure to
    // one id would be a guess, and a guess is what the reason column replaces.
    const h = makeStage([contentRow(1), contentRow(2)]);
    h.failUpsertWith(new Error('deadlock detected'));

    const results = await h.stage.run(ctx, [contentId(1), contentId(2)]);

    for (const id of [contentId(1), contentId(2)]) {
      expect(results.get(id)?.outcome).toBe('failed');
      expect(results.get(id)?.reason).toBe('embedding_write_failed');
    }
  });

  it('does not let a skipped row inherit the write failure', async () => {
    // The skip was decided before Ollama was called and is terminal on its own
    // terms; folding it into the outage would overstate the damage.
    const h = makeStage([contentRow(1), contentRow(2, { text: 'ok' })]);
    h.failUpsertWith(new Error('deadlock detected'));

    const results = await h.stage.run(ctx, [contentId(1), contentId(2)]);

    expect(results.get(contentId(1))?.outcome).toBe('failed');
    expect(results.get(contentId(2))).toEqual({ outcome: 'skipped', reason: 'too-short' });
  });

  it('fails a row whose vector came back empty rather than writing a zero vector', async () => {
    const h = makeStage([contentRow(1)]);
    h.generateEmbeddings.mockResolvedValue([[]]);

    const results = await h.stage.run(ctx, [contentId(1)]);

    expect(results.get(contentId(1))).toEqual({ outcome: 'failed', reason: 'empty_embedding_vector' });
    expect(h.upserts).toHaveLength(0);
  });

  it('screens a mis-dimensioned vector out BEFORE the write, so it cannot poison the slice', async () => {
    // pgvector rejects the cast, which would abort the whole bulk upsert and
    // charge every other row in the slice an attempt for one row's problem. The
    // reason is its own token because the cause is a whole-appliance
    // misconfiguration — the model does not produce the column's width — not a
    // property of the row.
    const h = makeStage([contentRow(1), contentRow(2)]);
    h.generateEmbeddings.mockResolvedValue([[0.1, 0.2, 0.3], vector(0)]);

    const results = await h.stage.run(ctx, [contentId(1), contentId(2)]);

    expect(results.get(contentId(1))?.reason).toBe('embedding_dimension_mismatch');
    expect(results.get(contentId(1))?.detail).toMatchObject({
      expected: EMBEDDING_DIMENSION,
      received: 3,
    });
    // The healthy row still lands.
    expect(results.get(contentId(2))?.outcome).toBe('done');
    expect((h.upserts[0].params as [string, string, string[], string[], string[]])[3]).toEqual([
      contentId(2),
    ]);
  });
});

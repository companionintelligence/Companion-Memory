import { PIPELINE_QUEUE_NAMES } from '../../constants';
import { STAGE_VERSIONS, stageVersion, type StageVersion } from '../../versions';
import { STAGE_REGISTRY, StageRegistry } from '../StageRegistry';

/**
 * The stage registry is an EXPLICIT STATIC MAP, and that is the whole point.
 *
 * The bus it replaces builds its routing table from `@OnEvent` decorator side
 * effects at module-import time (`EventListenerRegistry`): nothing about which
 * work exists is visible in a diff, so a missing listener looks exactly like a
 * working one until a job silently no-ops in production. A pipeline cannot
 * afford that — "which stages exist" decides what a version bump re-processes
 * and what the status endpoint claims coverage over.
 *
 * Two things are pinned here:
 *
 *  1. **The declaration.** `STAGE_REGISTRY` and `STAGE_VERSIONS` must cover
 *     exactly the same stage ids, in both directions, checked at module load.
 *     Each gap fails differently and both fail quietly: a stage with no version
 *     cannot be swept, and a version with no stage fills the ledger with
 *     `running` rows that never terminate.
 *  2. **The resolution guard.** Every property THE ONE RULE interpolates —
 *     `schema`, `table`, `idColumn`, `userColumn` — plus the id, the version
 *     and the queue, is verified when a stage is resolved. A stage missing one
 *     of those produces a query that is syntactically valid over the wrong
 *     rows, which is the worst kind of failure because it succeeds.
 *
 * The registry maps a stage id to its Nest injection TOKEN rather than to an
 * instance: a stage is an ordinary injectable that may depend on object
 * storage, an LLM client or a geocode provider, and none of that belongs in a
 * flat declaration file. Resolution therefore goes through `ModuleRef`, stubbed
 * below.
 */

/** The five namespaces of the pipeline. A stage id lives in exactly one. */
const STAGE_NAMESPACES = ['get', 'index', 'enrich', 'clean', 'promote'];

/** `enrich.media_dimensions` — namespace, dot, snake_case leaf. */
const STAGE_ID_PATTERN = new RegExp(`^(${STAGE_NAMESPACES.join('|')})\\.[a-z][a-z0-9_]*$`);

const REGISTRY = STAGE_REGISTRY as unknown as Record<string, string>;

/**
 * The DECLARED versions — each either a literal integer or a thunk.
 *
 * Read through `stageVersion()` wherever an integer is wanted. Indexing this
 * map and comparing the result to a number is the mistake the union invites,
 * and it is the same one `StageRegistry.assertConsistent` had to stop making:
 * a derived-version stage would fail every check against an unresolved
 * function.
 */
const VERSIONS = STAGE_VERSIONS as unknown as Record<string, StageVersion>;

/** A stage id that is actually declared, to resolve in the guard tests. */
const SAMPLE_STAGE_ID = Object.keys(REGISTRY)[0];

interface StageLike {
  id: string;
  version: number;
  queue: string;
  entityTypes: readonly string[];
  source: {
    schema?: string;
    table?: string;
    idColumn?: string;
    userColumn?: string;
    predicate?: string;
  };
  run: unknown;
}

/** A stage that satisfies every declared invariant; tests break one at a time. */
function validStage(overrides: Partial<StageLike> = {}): StageLike {
  return {
    id: SAMPLE_STAGE_ID,
    version: stageVersion(SAMPLE_STAGE_ID),
    queue: PIPELINE_QUEUE_NAMES[0],
    entityTypes: ['file'],
    source: {
      schema: 'ci',
      table: 'files',
      idColumn: 'id',
      userColumn: 'user_id',
      predicate: "s.content_type LIKE 'image/%'",
    },
    run: async () => new Map(),
    ...overrides,
  };
}

function makeRegistry(stage: StageLike | Error = validStage()) {
  const moduleRef = {
    get: jest.fn(() => {
      if (stage instanceof Error) {
        throw stage;
      }

      return stage;
    }),
  };
  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const registry = new StageRegistry(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    moduleRef as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
  );

  return { registry, moduleRef, logger };
}

/**
 * Re-imports the registry against a doctored STAGE_VERSIONS, so the boot-time
 * completeness guard can be tested for the case it exists to catch.
 *
 * The guard may throw at module load (the pattern
 * `domains/search-ingress/entitySourceMap.ts` already uses) or be an exported
 * function called from `onModuleInit`. Both are legitimate, so this returns
 * enough for the caller to accept either.
 */
async function importRegistryWith(
  versions: Record<string, StageVersion>,
): Promise<{ threwOnImport: boolean; module?: Record<string, unknown> }> {
  let outcome: { threwOnImport: boolean; module?: Record<string, unknown> } = { threwOnImport: false };

  await jest.isolateModulesAsync(async () => {
    // `stageVersion` is mocked alongside the map because `StageRegistry` reads
    // versions through it, never by indexing — a declared version may be a
    // thunk. The stand-in resolves the union the same way the real one does,
    // minus the integer guard, which `versions.ts` owns and tests.
    jest.doMock('../../versions', () => ({
      STAGE_VERSIONS: versions,
      stageVersion: (stageId: string) => {
        const declared = versions[stageId];

        return typeof declared === 'function' ? declared() : declared;
      },
    }));
    try {
      outcome = { threwOnImport: false, module: (await import('../StageRegistry')) as never };
    } catch {
      outcome = { threwOnImport: true };
    }
  });

  return outcome;
}

/** Whichever exported function looks like a completeness guard, if any. */
function guardOf(module: Record<string, unknown>): (() => void) | undefined {
  const found = Object.entries(module).find(
    ([name, value]) => typeof value === 'function' && /^(assert|validate|check)/i.test(name),
  );

  return found?.[1] as (() => void) | undefined;
}

afterEach(() => {
  jest.dontMock('../../versions');
  jest.resetModules();
});

describe('STAGE_REGISTRY declaration', () => {
  it('registers at least one stage', () => {
    expect(Object.keys(REGISTRY).length).toBeGreaterThan(0);
  });

  it('has a STAGE_VERSIONS entry for every registered stage', () => {
    for (const stageId of Object.keys(REGISTRY)) {
      expect(Object.keys(VERSIONS)).toContain(stageId);
    }
  });

  it('has a registered stage for every STAGE_VERSIONS entry', () => {
    // The other half of completeness. A version declared for a stage nobody
    // implements is a lie the status endpoint reports coverage for.
    for (const stageId of Object.keys(VERSIONS)) {
      expect(Object.keys(REGISTRY)).toContain(stageId);
    }
  });

  it('namespaces every stage id under one of the five phases', () => {
    for (const stageId of Object.keys(REGISTRY)) {
      expect(stageId).toMatch(STAGE_ID_PATTERN);
    }
  });

  it('declares a distinct, non-empty binding for every stage', () => {
    const bindings = Object.values(REGISTRY);

    for (const binding of bindings) {
      expect(typeof binding === 'string' || typeof binding === 'function').toBe(true);
      expect(String(binding).length).toBeGreaterThan(0);
    }

    // Two stages sharing one binding means one of them silently runs the other.
    expect(new Set(bindings).size).toBe(bindings.length);
  });

  it('resolves a positive integer version for every stage, literal or derived', () => {
    // Versions are monotonic and never rolled back: a rollback would leave
    // already-processed rows looking stale-forward and re-run the corpus.
    //
    // Through `stageVersion()`, so a DERIVED version is held to the identical
    // standard as a typed one. `index.embed`'s version is a function of the
    // configured embedding model, and arithmetic is exactly as capable of
    // producing 0 or a fraction as a typo is — more so, because nobody reads it.
    for (const stageId of Object.keys(REGISTRY)) {
      const resolved = stageVersion(stageId);

      expect(Number.isInteger(resolved)).toBe(true);
      expect(resolved).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('STAGE_REGISTRY boot-time completeness guard', () => {
  it('accepts the real registry', async () => {
    const outcome = await importRegistryWith(VERSIONS);

    expect(outcome.threwOnImport).toBe(false);
    const guard = guardOf(outcome.module as Record<string, unknown>);
    if (guard !== undefined) {
      expect(guard).not.toThrow();
    }
  });

  it('is indifferent to whether a version is declared as a literal or a thunk', async () => {
    // Completeness is about KEYS. A value may be an integer a human bumps or a
    // thunk deriving one (`index.embed`, from the embedding model), and the
    // guard must not acquire an opinion about which — or the union would buy a
    // complete declaration at the price of an unenforced one.
    const asThunks: Record<string, StageVersion> = Object.fromEntries(
      Object.keys(VERSIONS).map((stageId) => [stageId, () => stageVersion(stageId)]),
    );

    const outcome = await importRegistryWith(asThunks);

    expect(outcome.threwOnImport).toBe(false);

    const guard = guardOf(outcome.module as Record<string, unknown>);
    if (guard !== undefined) {
      expect(guard).not.toThrow();
    }
  });

  it('rejects a registered stage that has no version', async () => {
    const versions = { ...VERSIONS };
    delete versions[SAMPLE_STAGE_ID];

    const outcome = await importRegistryWith(versions);

    if (outcome.threwOnImport) {
      return;
    }

    const guard = guardOf(outcome.module as Record<string, unknown>);
    expect(guard).toBeDefined();
    expect(guard as () => void).toThrow();
  });

  it('rejects a declared version that no stage implements', async () => {
    const versions = { ...VERSIONS, 'enrich.not_implemented_yet': 1 };

    const outcome = await importRegistryWith(versions);

    if (outcome.threwOnImport) {
      return;
    }

    const guard = guardOf(outcome.module as Record<string, unknown>);
    expect(guard).toBeDefined();
    expect(guard as () => void).toThrow();
  });
});

describe('StageRegistry.get', () => {
  it('resolves a declared stage', () => {
    const stage = validStage();
    const { registry } = makeRegistry(stage);

    expect(registry.get(SAMPLE_STAGE_ID)).toBe(stage);
  });

  it.each(Object.keys(REGISTRY))(
    'resolves %s against the version STAGE_VERSIONS actually declares',
    (stageId) => {
      // Every real stage id, not just the sample, because the version check is
      // the one that has to cope with both halves of the union. A registry that
      // compared `stage.version` to the RAW map entry would pass for every
      // literal-versioned stage and fail for every derived one — which is
      // exactly the shape of bug that hides until the first sweep of the one
      // stage nobody tested this way.
      const stage = validStage({ id: stageId, version: stageVersion(stageId) });
      const { registry } = makeRegistry(stage);

      expect(registry.get(stageId)).toBe(stage);
    },
  );

  it('resolves each stage once and caches it', () => {
    const { registry, moduleRef } = makeRegistry();

    registry.get(SAMPLE_STAGE_ID);
    registry.get(SAMPLE_STAGE_ID);

    expect(moduleRef.get).toHaveBeenCalledTimes(1);
  });

  it('throws for an unknown stage id instead of returning null', () => {
    // A slice that cannot resolve its stage must fail loudly enough to reach
    // the dead-letter table. Returning null lets the worker "successfully"
    // process nothing — the failure mode this rebuild is named after.
    const { registry } = makeRegistry();

    expect(() => registry.get('enrich.no_such_stage')).toThrow(/enrich\.no_such_stage/);
  });

  it('throws when a stage is declared but nothing is bound to its token', () => {
    const { registry } = makeRegistry(new Error('Nest could not find provider'));

    expect(() => registry.get(SAMPLE_STAGE_ID)).toThrow();
  });

  it('rejects a stage whose id disagrees with its registry key', () => {
    // The stage's own id is what lands in ci.pipeline_state's primary key, so a
    // mismatch writes ledger rows under a key nothing sweeps.
    const { registry } = makeRegistry(validStage({ id: 'enrich.something_else' }));

    expect(() => registry.get(SAMPLE_STAGE_ID)).toThrow();
  });

  it('rejects a stage whose version disagrees with STAGE_VERSIONS', () => {
    // If the stage can hardcode its own version, bumping the constant stops
    // re-processing anything — the one operation this subsystem exists for.
    const { registry } = makeRegistry(validStage({ version: stageVersion(SAMPLE_STAGE_ID) + 41 }));

    expect(() => registry.get(SAMPLE_STAGE_ID)).toThrow();
  });

  it('rejects a stage declaring a queue no worker is bound to', () => {
    const { registry } = makeRegistry(validStage({ queue: 'not-a-pipeline-queue' }));

    expect(() => registry.get(SAMPLE_STAGE_ID)).toThrow();
  });

  it('rejects a stage declaring no entity types', () => {
    // The ledger is keyed per (entity_type, entity_id, stage); a stage with no
    // entity type has nowhere to record anything.
    const { registry } = makeRegistry(validStage({ entityTypes: [] }));

    expect(() => registry.get(SAMPLE_STAGE_ID)).toThrow();
  });

  it.each(['schema', 'table', 'idColumn', 'userColumn'] as const)(
    'rejects a stage missing source.%s',
    (field) => {
      const source = { ...validStage().source };
      delete source[field];
      const { registry } = makeRegistry(validStage({ source }));

      expect(() => registry.get(SAMPLE_STAGE_ID)).toThrow();
    },
  );

  it('rejects an applicability predicate that reaches into the ledger', () => {
    // The one-way ratchet rebuilding itself inside the mechanism designed to
    // remove it: the row would drop out of the candidate set the moment the
    // stage succeeded, and a version bump could never bring it back.
    const { registry } = makeRegistry(
      validStage({ source: { ...validStage().source, predicate: 'p.status IS NULL' } }),
    );

    expect(() => registry.get(SAMPLE_STAGE_ID)).toThrow();
  });

  it('rejects an applicability predicate that starts with AND', () => {
    // It is spliced in as `AND (<predicate>)`; a leading AND is a syntax error
    // at sweep time, i.e. in a worker, long after the commit.
    const { registry } = makeRegistry(
      validStage({ source: { ...validStage().source, predicate: "AND s.content_type LIKE 'image/%'" } }),
    );

    expect(() => registry.get(SAMPLE_STAGE_ID)).toThrow();
  });

  it('accepts a stage with no applicability predicate at all', () => {
    // "Every row in the table is a candidate" is a legitimate stage.
    const source = { ...validStage().source };
    delete source.predicate;
    const stage = validStage({ source });
    const { registry } = makeRegistry(stage);

    expect(registry.get(SAMPLE_STAGE_ID)).toBe(stage);
  });
});

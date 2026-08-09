import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { PIPELINE_QUEUE_NAMES, STAGE_ID_LIST, type StageId } from '../constants';
import { STAGE_REGISTRY } from '../services/StageRegistry';
import type { Stage } from '../types';
import { STAGE_VERSIONS, stageVersion } from '../versions';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE STAGES ARE ACTUALLY REACHABLE. THIS FILE REGRESSES ONE SPECIFIC OUTAGE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `EmbedStage` and `PositionReverseStage` shipped complete — written, reviewed,
 * unit-tested, ~300 assertions between them, all green — AND NEITHER COULD EVER
 * RUN. Both declared their stage id as a local string literal and their version
 * from a local derivation, so neither appeared in `STAGE_IDS`, `STAGE_VERSIONS`
 * or `STAGE_REGISTRY`, and `stageProviders` in `index.ts` was `[]`. Every
 * existing guard was satisfied:
 *
 *  - `StageRegistry`'s boot-time completeness guard compares `STAGE_REGISTRY`'s
 *    keys against `STAGE_VERSIONS`'s. Two maps that both omit a stage agree
 *    perfectly.
 *  - The stage specs construct the class directly and assert against its own
 *    constants, so they pass whether or not anything can resolve it.
 *  - `yarn typecheck` sees three well-formed classes implementing `Stage`.
 *  - Nothing dispatched a slice, so nothing ever called `StageRegistry.get`.
 *
 * The failure was therefore SILENT and complete: a stage nobody declared is a
 * stage the sweep never targets, so there is no error, no dead letter and no
 * coverage number that looks wrong — just work that does not happen. That is
 * precisely the class of defect this whole subsystem exists to delete, so it
 * gets the treatment every other one got: a test that discovers the truth
 * instead of trusting a declaration.
 *
 * ── How it discovers rather than declares ──────────────────────────────────
 *
 * The stage classes are found by READING `stages/` OFF DISK and loading every
 * module in it, not by importing a list. A list is the thing that was wrong: any
 * test that imports the three known stages by name passes on the day a fourth
 * lands unwired, which is the only day it matters. `PipelineModule`'s provider
 * array is read the same way, from its `@Module` metadata, so what is asserted
 * is what Nest will actually construct at boot.
 *
 * Loading the barrel by path rather than `import { PipelineModule } from '../index'`
 * is a consequence of the same choice — everything here comes from disk — and it
 * also keeps this file clear of `no-intra-domain-via-barrel` in
 * `.dependency-cruiser.mjs`, whose `pathNot` exempts `*.test.ts` but not
 * `*.spec.ts`.
 *
 * ── What a failure here means ──────────────────────────────────────────────
 *
 * Adding a stage is four lines in four files: `STAGE_IDS`, `STAGE_VERSIONS`,
 * `STAGE_REGISTRY`, `stageProviders`. Each test below names exactly which of the
 * four is missing, because "the wiring is incomplete" at 3am costs an hour and
 * "`index.embed` has no provider in PipelineModule" costs a minute.
 */

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const PIPELINE_DIR = join(__dirname, '..');
const STAGES_DIR = join(PIPELINE_DIR, 'stages');

/**
 * Every `.ts` file under `stages/`, tests excluded.
 *
 * Recursive because the tree is `stages/<phase>/<Stage>.ts` and a new phase is a
 * new directory. Nothing is filtered by filename convention: a stage class in a
 * file called something unexpected is still a stage class, and the point of this
 * file is to notice things nobody remembered to tell it about.
 */
function stageSourceFiles(dir: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') {
      continue;
    }

    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      found.push(...stageSourceFiles(full));
      continue;
    }

    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      found.push(full);
    }
  }

  return found;
}

/**
 * A dependency-shaped nothing.
 *
 * Stage constructors take repositories, data sources, object storage, an Ollama
 * client and a geocode service, and every one of them does exactly two things at
 * construction: store the reference, and call `logger.setContext(...)`. A proxy
 * that answers every property with another callable satisfies that without this
 * file knowing any stage's constructor signature — which it must not, or adding
 * a stage would mean editing the test that checks you added it properly.
 *
 * Nothing here exercises stage BEHAVIOUR. The per-stage specs do that against
 * real doubles; this file only needs an instance to read `id`, `version` and
 * `queue` off, because all three are class field initialisers and there is no
 * way to see them without constructing one.
 */
function stubDependency(): never {
  const stub = new Proxy(function stubbed(): void {}, {
    get: () => stubDependency(),
    apply: () => undefined,
  });

  return stub as never;
}

interface DiscoveredStage {
  /** Path relative to `stages/`, for a failure message that points at a file. */
  file: string;
  className: string;
  StageClass: new (...args: never[]) => Stage;
  instance: Stage;
}

/**
 * Load every module under `stages/` and instantiate whatever implements
 * {@link Stage}.
 *
 * The discriminator is `prototype.run` — the one member the `Stage` contract
 * requires and no helper in these files has. Interfaces are erased at runtime,
 * so `implements Stage` is invisible here; a duck-type check is the only thing
 * available, and it is the right one anyway: `PipelineSliceListener` calls
 * `stage.run(ctx, ids)` and nothing else.
 */
function discoverStages(): DiscoveredStage[] {
  const discovered: DiscoveredStage[] = [];

  for (const file of stageSourceFiles(STAGES_DIR)) {
    const loaded = jest.requireActual<Record<string, unknown>>(file);

    for (const [exportName, exported] of Object.entries(loaded)) {
      if (typeof exported !== 'function') {
        continue;
      }

      const prototype = (exported as { prototype?: Record<string, unknown> }).prototype;

      if (prototype == null || typeof prototype.run !== 'function') {
        continue;
      }

      const StageClass = exported as new (...args: never[]) => Stage;
      // `Class.length` is the constructor's declared arity, so the stub count
      // follows the stage rather than being a magic number this file maintains.
      const args = Array.from({ length: StageClass.length }, () => stubDependency());

      discovered.push({
        file: file.slice(STAGES_DIR.length + 1),
        className: exportName,
        StageClass,
        instance: new StageClass(...(args as never[])),
      });
    }
  }

  return discovered;
}

const DISCOVERED = discoverStages();

// ---------------------------------------------------------------------------
// What PipelineModule actually binds
// ---------------------------------------------------------------------------

/**
 * The provider array off `PipelineModule`'s `@Module` metadata — the same list
 * Nest reads at boot, not a re-declaration of it.
 */
const PipelineModule = jest.requireActual<{ PipelineModule: object }>(
  join(PIPELINE_DIR, 'index'),
).PipelineModule;

const MODULE_PROVIDERS = (Reflect.getMetadata('providers', PipelineModule) ?? []) as unknown[];

/** Every `{ provide: <string token>, useClass }` binding, keyed by token. */
const BOUND_BY_TOKEN = new Map<string, unknown>();

for (const provider of MODULE_PROVIDERS) {
  if (typeof provider !== 'object' || provider == null) {
    continue;
  }

  const { provide, useClass } = provider as { provide?: unknown; useClass?: unknown };

  if (typeof provide === 'string') {
    BOUND_BY_TOKEN.set(provide, useClass);
  }
}

/** Discovered stages keyed by the id they report. Duplicates are a test failure. */
const DISCOVERED_BY_ID = new Map<string, DiscoveredStage>(
  DISCOVERED.map((stage) => [stage.instance.id, stage]),
);

/* ===================================================================== *
 * Tests
 * ===================================================================== */

describe('stage declarations agree across all four places', () => {
  it('declares the same ids in STAGE_IDS and STAGE_VERSIONS', () => {
    expect(Object.keys(STAGE_VERSIONS).sort()).toEqual([...STAGE_ID_LIST].sort());
  });

  it('declares the same ids in STAGE_IDS and STAGE_REGISTRY', () => {
    // `StageRegistry`'s boot guard already compares STAGE_REGISTRY to
    // STAGE_VERSIONS. This is the third corner: two maps can agree with each
    // other while both drifting from the id list every other file imports.
    expect(Object.keys(STAGE_REGISTRY).sort()).toEqual([...STAGE_ID_LIST].sort());
  });

  it('binds a provider in PipelineModule for every declared stage', () => {
    // THE CHECK THAT WAS MISSING. `stageProviders` is the one of the four that
    // no boot guard can infer, because a stage absent from every map looks
    // consistent to a guard that only compares maps.
    const unbound = STAGE_ID_LIST.filter((stageId) => !BOUND_BY_TOKEN.has(STAGE_REGISTRY[stageId]));

    expect(unbound).toEqual([]);
  });

  it('binds each stage to a distinct token', () => {
    // Two ids sharing a token means one stage silently does the other's work,
    // recorded in the ledger under the wrong key and at the wrong version.
    const tokens = STAGE_ID_LIST.map((stageId) => STAGE_REGISTRY[stageId]);

    expect(new Set(tokens).size).toBe(tokens.length);
  });
});

describe('every stage class on disk is wired', () => {
  it('finds a stage class under stages/', () => {
    // A zero-length discovery would make every `it.each` below vacuous and this
    // whole file green for the wrong reason.
    expect(DISCOVERED.length).toBeGreaterThan(0);
  });

  it('has no two stage classes claiming the same id', () => {
    // The ledger is keyed on (entity_type, entity_id, stage), so two classes at
    // one id write over each other's outcomes at each other's versions.
    expect(DISCOVERED_BY_ID.size).toBe(DISCOVERED.length);
  });

  it('declares every stage class it finds — THE REGRESSION', () => {
    // `EmbedStage` and `PositionReverseStage` both failed exactly here: a class
    // on disk, complete and tested, whose id appears in no declaration and which
    // therefore no sweep can ever target.
    const undeclared = DISCOVERED.filter(
      (stage) => !STAGE_ID_LIST.includes(stage.instance.id as StageId),
    ).map((stage) => `${stage.className} (${stage.file}) reports id "${stage.instance.id}"`);

    expect(undeclared).toEqual([]);
  });

  it('implements every stage it declares', () => {
    // The other direction, and the more expensive failure: a declared id with no
    // class makes the sweep dispatch slices that die unresolvable, filling the
    // ledger with `running` rows that never terminate.
    const unimplemented = STAGE_ID_LIST.filter((stageId) => !DISCOVERED_BY_ID.has(stageId));

    expect(unimplemented).toEqual([]);
  });

  it.each(DISCOVERED.map((stage) => [stage.className, stage] as const))(
    '%s is bound in PipelineModule under its own id',
    (_name, stage) => {
      const token = STAGE_REGISTRY[stage.instance.id as StageId];

      expect(token).toBeDefined();
      // Identity, not just presence: binding `MediaDimensionsStage` to
      // `index.embed`'s token would satisfy every count above and quietly probe
      // image dimensions where embeddings were meant to be written.
      expect(BOUND_BY_TOKEN.get(token)).toBe(stage.StageClass);
    },
  );
});

describe('every stage agrees with the central declarations', () => {
  it.each(DISCOVERED.map((stage) => [stage.className, stage] as const))(
    '%s reports the version STAGE_VERSIONS declares',
    (_name, stage) => {
      // Read through `stageVersion()`, which resolves both halves of the union —
      // a literal integer or a thunk (`index.embed` derives its version from the
      // embedding model). A stage whose version disagrees makes bumping the
      // constant a no-op, which is the one operation this subsystem exists for.
      expect(stage.instance.version).toBe(stageVersion(stage.instance.id));
    },
  );

  it.each(DISCOVERED.map((stage) => [stage.className, stage] as const))(
    '%s rides a queue a worker is actually started for',
    (_name, stage) => {
      // `PipelineSliceListener` binds one handler per name in PIPELINE_QUEUES.
      // Slices sent anywhere else sit in pg-boss until retention deletes them.
      expect(PIPELINE_QUEUE_NAMES).toContain(stage.instance.queue);
    },
  );

  it.each(DISCOVERED.map((stage) => [stage.className, stage] as const))(
    '%s declares at least one entity type and a complete source',
    (_name, stage) => {
      // `StageRegistry.assertConsistent` enforces this at resolve time, i.e. at
      // the first slice. Asserting it here moves the failure to the commit.
      expect(stage.instance.entityTypes.length).toBeGreaterThan(0);

      for (const field of ['schema', 'table', 'idColumn', 'userColumn'] as const) {
        expect(typeof stage.instance.source[field]).toBe('string');
        expect(stage.instance.source[field].length).toBeGreaterThan(0);
      }
    },
  );
});

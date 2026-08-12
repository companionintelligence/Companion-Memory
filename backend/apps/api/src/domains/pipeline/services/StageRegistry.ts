import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import { LoggerService } from '@ci/common/logging';

import { PIPELINE_QUEUE_NAMES, STAGE_IDS, type StageId } from '../constants';
import type { Stage } from '../types';
import { STAGE_VERSIONS, stageVersion, type StageVersion } from '../versions';

/**
 * Stage id → the Nest injection token its implementation is bound to.
 *
 * **An explicit static map, reviewable in a diff.** This is the deliberate
 * opposite of `EventListenerRegistry`, which is populated by `@OnEvent`
 * decorator side effects at module-import time: there, the set of registered
 * handlers depends on which files an import graph happened to pull in, so a
 * missing listener looks identical to a working one until a job silently
 * no-ops in production. A pipeline cannot afford that — "which stages exist"
 * decides what a version bump re-processes and what `GET /api/pipeline/state`
 * claims coverage over.
 *
 * The values are TOKENS, not classes, so this file imports nothing from
 * `../stages/`. That keeps the registry a flat, dependency-free declaration and
 * keeps the module graph from acquiring a cycle the moment a stage needs a
 * service that (transitively) needs the registry. Binding happens once, in
 * `PipelineModule`:
 *
 * ```ts
 * { provide: STAGE_REGISTRY[STAGE_IDS.ENRICH_MEDIA_DIMENSIONS], useClass: MediaDimensionsStage }
 * ```
 */
export const STAGE_REGISTRY: Record<StageId, string> = {
  [STAGE_IDS.ENRICH_MEDIA_DIMENSIONS]: 'PipelineStage:enrich.media_dimensions',
  [STAGE_IDS.INDEX_EMBED]: 'PipelineStage:index.embed',
  [STAGE_IDS.ENRICH_POSITION_REVERSE]: 'PipelineStage:enrich.position_reverse',
  [STAGE_IDS.ENRICH_GEOCODE]: 'PipelineStage:enrich.geocode',
  [STAGE_IDS.ENRICH_ESTIMATE_LOCATION]: 'PipelineStage:enrich.estimate_location',
  [STAGE_IDS.ENRICH_PERSON_LINK]: 'PipelineStage:enrich.person_link',
  [STAGE_IDS.ENRICH_EVENT_PERSON_LINK]: 'PipelineStage:enrich.event_person_link',
  [STAGE_IDS.CLEAN_TEMPORAL_REPAIR]: 'PipelineStage:clean.temporal_repair',
  [STAGE_IDS.CLEAN_DUPLICATE_DETECT]: 'PipelineStage:clean.duplicate_detect',
  [STAGE_IDS.CLEAN_IDENTIFIER_NORMALIZE]: 'PipelineStage:clean.identifier_normalize',
  [STAGE_IDS.PROMOTE_PLACE]: 'PipelineStage:promote.place',
  [STAGE_IDS.PROMOTE_OBJECT]: 'PipelineStage:promote.object',
  [STAGE_IDS.PROMOTE_EDGE_COMMUNICATION]: 'PipelineStage:promote.edge_communication',
  [STAGE_IDS.PROMOTE_EDGE_EVENT]: 'PipelineStage:promote.edge_event',
  [STAGE_IDS.PROMOTE_EDGE_CONTENT]: 'PipelineStage:promote.edge_content',
  [STAGE_IDS.PROMOTE_EDGE_INVENTORY]: 'PipelineStage:promote.edge_inventory',
  [STAGE_IDS.PROMOTE_EDGE_RECEIPT]: 'PipelineStage:promote.edge_receipt',
  [STAGE_IDS.PROMOTE_EDGE_OBSERVATION]: 'PipelineStage:promote.edge_observation',
  [STAGE_IDS.PROMOTE_EDGE_POSITION]: 'PipelineStage:promote.edge_position',
  [STAGE_IDS.PROMOTE_EDGE_DEVICE]: 'PipelineStage:promote.edge_device',
  [STAGE_IDS.PROMOTE_EDGE_FILE]: 'PipelineStage:promote.edge_file',
  [STAGE_IDS.PROMOTE_EDGE_PLACE]: 'PipelineStage:promote.edge_place',
};

/**
 * Boot-time completeness guard: the registry and `STAGE_VERSIONS` must cover
 * EXACTLY the same stage ids.
 *
 * Mirrors the guard in `domains/search-ingress/entitySourceMap.ts`, and for the
 * same reason: a gap between two hand-maintained maps is invisible until the
 * one thing that needed both silently does nothing. Here each direction fails
 * differently and both fail quietly, which is why this throws at module load
 * rather than warning:
 *
 *  - **In the registry, not in `STAGE_VERSIONS`** → `stageVersion()` throws the
 *    first time that stage is swept, i.e. in a worker, on whichever appliance
 *    happens to reach it first, long after the commit that caused it.
 *  - **In `STAGE_VERSIONS`, not in the registry** → the sweep runs, finds
 *    candidates, dispatches slices, and every slice dies on an unresolvable
 *    stage id. The ledger fills with `running` rows that never terminate and
 *    coverage sits at zero with no error anyone reads.
 *
 * The message names the symmetric difference in both directions, because
 * "registry and versions disagree" is useless at 3am and "`clean.orphan_reap`
 * is declared in STAGE_VERSIONS but has no registry entry" is a one-line fix.
 */
export function assertStageRegistryComplete(versions: Record<string, StageVersion> = STAGE_VERSIONS): void {
  const registryIds = new Set<string>(Object.keys(STAGE_REGISTRY));
  const versionIds = new Set<string>(Object.keys(versions));

  const missingFromVersions = [...registryIds].filter((id) => !versionIds.has(id)).sort();
  const missingFromRegistry = [...versionIds].filter((id) => !registryIds.has(id)).sort();

  if (missingFromVersions.length === 0 && missingFromRegistry.length === 0) {
    return;
  }

  const problems: string[] = [];

  if (missingFromRegistry.length > 0) {
    problems.push(
      `declared in STAGE_VERSIONS but absent from STAGE_REGISTRY (their slices would never resolve a stage): ` +
        missingFromRegistry.join(', '),
    );
  }

  if (missingFromVersions.length > 0) {
    problems.push(
      `present in STAGE_REGISTRY but absent from STAGE_VERSIONS (they have no re-run watermark): ` +
        missingFromVersions.join(', '),
    );
  }

  throw new Error(`Pipeline stage registry is incomplete — ${problems.join('; ')}.`);
}

// Run at module load, not at `onModuleInit`. An incomplete registry is a
// programming error, and the earliest possible failure is the cheapest one:
// this throws while the import graph is still being built, before a queue
// exists to enqueue work onto.
assertStageRegistryComplete();

/**
 * Resolves stage ids to their live implementations.
 *
 * Resolution is deferred to the container rather than done by importing stage
 * classes here, so a stage is an ordinary injectable that can depend on
 * whatever domain services it needs (object storage, an LLM client, a geocode
 * provider) without any of that leaking into the registry declaration.
 */
@Injectable()
export class StageRegistry {
  /** Resolved instances, keyed by stage id. Stages are singletons; resolve once. */
  private readonly resolved = new Map<string, Stage>();

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(StageRegistry.name);
  }

  /** Every declared stage id, sorted. */
  stageIds(): string[] {
    return Object.keys(STAGE_REGISTRY).sort();
  }

  /** Whether a stage id is declared. Does NOT imply an implementation is bound. */
  has(stageId: string): boolean {
    return Object.prototype.hasOwnProperty.call(STAGE_REGISTRY, stageId);
  }

  /**
   * The live implementation for a stage id.
   *
   * Throws — never returns null — for both an unknown id and a declared-but-
   * unbound one, with different messages, because they are different mistakes
   * with different fixes. A slice that cannot resolve its stage must fail
   * loudly enough to reach the dead-letter table; returning null would let the
   * worker "successfully" process nothing.
   */
  get(stageId: string): Stage {
    const cached = this.resolved.get(stageId);

    if (cached != null) {
      return cached;
    }

    const token = STAGE_REGISTRY[stageId as StageId];

    if (token == null) {
      throw new Error(
        `Unknown pipeline stage "${stageId}". Declared stages: ${this.stageIds().join(', ') || '(none)'}.`,
      );
    }

    // `strict: false` searches the whole application, not just the module this
    // registry was resolved in. Stages are registered in PipelineModule today,
    // but a converted maintenance leg may well end up providing its stage from
    // its own domain module, and the registry should not care which.
    let instance: Stage;

    try {
      instance = this.moduleRef.get<Stage>(token, { strict: false });
    } catch (err: unknown) {
      throw new Error(
        `Pipeline stage "${stageId}" is declared in STAGE_REGISTRY but no provider is bound to token ` +
          `"${token}". Add { provide: STAGE_REGISTRY['${stageId}'], useClass: <YourStage> } to a module's ` +
          `providers. Cause: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.assertConsistent(stageId, instance);
    this.resolved.set(stageId, instance);

    return instance;
  }

  /**
   * Cross-check a resolved stage against the declarations it must agree with.
   *
   * Every one of these is a mismatch the type system cannot see, because the
   * stage's own fields are plain `string`/`number` literals:
   *
   *  - a stage whose `id` differs from its registry key writes ledger rows
   *    under a key nothing sweeps;
   *  - a stage whose `version` differs from `STAGE_VERSIONS` makes bumping the
   *    constant a no-op — the one operation this whole subsystem exists for;
   *  - a stage on an unknown queue enqueues slices onto a pg-boss queue no
   *    worker was started for, where they sit until retention deletes them.
   */
  private assertConsistent(stageId: string, stage: Stage): void {
    // Through `stageVersion()`, never by indexing STAGE_VERSIONS directly: an
    // entry there may be a THUNK (see `versions.ts`), and comparing a stage's
    // integer against an unresolved function would make every derived-version
    // stage fail this check with a message about hardcoding that is not what
    // happened. `stageVersion()` also re-applies the integer >= 1 guard, so a
    // derivation that started returning 0 is caught here as well as at boot.
    const expectedVersion = stageVersion(stageId);

    if (stage.id !== stageId) {
      throw new Error(
        `Pipeline stage bound at "${stageId}" reports id "${stage.id}". The registry key and the ` +
          `stage's own id must match — the id is part of ci.pipeline_state's primary key.`,
      );
    }

    if (stage.version !== expectedVersion) {
      throw new Error(
        `Pipeline stage "${stageId}" reports version ${stage.version} but STAGE_VERSIONS declares ` +
          `${expectedVersion}. Read the version from STAGE_VERSIONS instead of hardcoding it, or bumping ` +
          `the constant will not re-process anything.`,
      );
    }

    if (!PIPELINE_QUEUE_NAMES.includes(stage.queue as (typeof PIPELINE_QUEUE_NAMES)[number])) {
      throw new Error(
        `Pipeline stage "${stageId}" declares queue "${stage.queue}", which is not one of ` +
          `${PIPELINE_QUEUE_NAMES.join(', ')}. Slices sent to an unworked queue are never processed.`,
      );
    }

    if (stage.entityTypes.length === 0) {
      throw new Error(
        `Pipeline stage "${stageId}" declares no entityTypes. The ledger is keyed per ` +
          `(entity_type, entity_id, stage); a stage with no entity type has nowhere to record anything.`,
      );
    }

    // schema/table/idColumn/userColumn are the four holes THE ONE RULE
    // interpolates. A stage missing one produces a query that is syntactically
    // valid over the wrong rows — the worst possible failure, because it
    // succeeds.
    for (const field of ['schema', 'table', 'idColumn', 'userColumn'] as const) {
      const value = stage.source?.[field];

      if (typeof value !== 'string' || value.length === 0) {
        throw new Error(
          `Pipeline stage "${stageId}" declares no source.${field}. The staleness sweep interpolates ` +
            `schema, table, idColumn and userColumn; all four are required.`,
        );
      }
    }

    this.assertApplicabilityPredicate(stageId, stage.source.predicate);
  }

  /**
   * The applicability predicate says what a row IS, never what has been done to
   * it.
   *
   * A predicate that reaches into `ci.pipeline_state` is the one-way ratchet
   * rebuilding itself inside the mechanism designed to remove it: the row would
   * drop out of the candidate set the moment the stage succeeded, and a version
   * bump could never bring it back. Rejected explicitly, because it is a
   * natural thing to reach for and it silently works — until the day someone
   * needs to re-run the stage.
   */
  private assertApplicabilityPredicate(stageId: string, predicate: string | undefined): void {
    if (predicate == null) {
      return;
    }

    const trimmed = predicate.trim();

    if (/^and\b/i.test(trimmed)) {
      throw new Error(
        `Pipeline stage "${stageId}" source.predicate starts with AND. It is spliced into the sweep as ` +
          `AND (<predicate>) — supply the clause alone.`,
      );
    }

    if (/;/.test(trimmed)) {
      throw new Error(
        `Pipeline stage "${stageId}" source.predicate contains a semicolon. It is a clause, not a statement.`,
      );
    }

    if (/pipeline_state/i.test(trimmed) || /\bp\./i.test(trimmed)) {
      throw new Error(
        `Pipeline stage "${stageId}" source.predicate references the ledger. The predicate declares which ` +
          `rows the stage APPLIES to; whether the stage has run is the sweep's business, and encoding it ` +
          `here re-creates the one-way ratchet the ledger exists to remove.`,
      );
    }
  }
}

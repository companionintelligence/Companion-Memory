import { Injectable } from '@nestjs/common';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
// The maintenance domain's PUBLIC barrel. The stage delegates the whole
// projection to DeterministicEdgeBackfillService — matrix, canonical
// (merge-tombstone) resolution, ON CONFLICT idempotency and graph deltas all
// live there, shared with the operator backfill endpoint. Two implementations
// of the projection would drift the moment the matrix gains a rule.
import { DeterministicEdgeBackfillService, type DeterministicEdgeSource } from '@ci/domains/maintenance';

import { PIPELINE_QUEUES } from '../../constants';
import type { Stage, StageResult, StageSource } from '../../types';
import { STAGE_VERSIONS, type StageVersion } from '../../versions';
// Intra-domain relative imports, exactly as this stage's producers are wired
// elsewhere: the versions below DERIVE from the producers' versions, because
// this stage's output is a pure projection of their output.
import { PERSON_LINK_VERSION } from '../enrich/PersonLinkStage';

import { PROMOTE_OBJECT_VERSION } from './ObjectPromoteStage';
import { PROMOTE_PLACE_VERSION } from './PlacePromoteStage';

/**
 * The ids. IDS ARE PERMANENT — each is the third component of
 * `ci.pipeline_state`'s primary key; renaming one abandons its ledger.
 *
 * One id per SOURCE TABLE, for the reason `enrich.person_link` /
 * `enrich.event_person_link` are two: a `Stage` declares exactly one `source`,
 * and the deterministic-edge matrix reads four tables. One implementation,
 * swept independently, never disagreeing.
 */
export const PROMOTE_EDGE_COMMUNICATION_STAGE_ID = 'promote.edge_communication';
export const PROMOTE_EDGE_EVENT_STAGE_ID = 'promote.edge_event';
export const PROMOTE_EDGE_CONTENT_STAGE_ID = 'promote.edge_content';
export const PROMOTE_EDGE_INVENTORY_STAGE_ID = 'promote.edge_inventory';
export const PROMOTE_EDGE_RECEIPT_STAGE_ID = 'promote.edge_receipt';
export const PROMOTE_EDGE_OBSERVATION_STAGE_ID = 'promote.edge_observation';
export const PROMOTE_EDGE_POSITION_STAGE_ID = 'promote.edge_position';
export const PROMOTE_EDGE_DEVICE_STAGE_ID = 'promote.edge_device';
export const PROMOTE_EDGE_FILE_STAGE_ID = 'promote.edge_file';
export const PROMOTE_EDGE_PLACE_STAGE_ID = 'promote.edge_place';

// ---------------------------------------------------------------------------
// The versions, DERIVED rather than chosen
// ---------------------------------------------------------------------------

/**
 * Generation of the projection rule itself — the deterministic-edge MATRIX
 * (which columns become which edge types, their strengths and properties) and
 * the projection SQL around it (canonical resolution, the self-reference
 * guard). Bump in the same commit that changes either — including adding a
 * rule to the matrix, or nothing re-projects rows already marked done.
 *
 * Generation 2: the matrix gained `event.child_of` (Event −PART_OF→ parent
 * Event), `content.part_of_event` (Content −PART_OF→ Event) and
 * `inventory.located_at` (Item −LOCATED_AT→ Place).
 *
 * Generation 3: receipts, observations, positions, devices.
 *
 * Generation 4: life-graph matrix alignment — Event→Place and receipt place
 * edges store LOCATED_AT (HAPPENED_AT is a write alias); Content→Event stores
 * DOCUMENTS; Place→Place PART_OF and File→File DERIVED_FROM rules added.
 */
export const EDGE_PROJECTION_RULE_GENERATION = 4;

/**
 * Communication-leg version: this stage's edges are a COPY of what
 * `enrich.person_link` wrote into `from_entity_id` / `to_entity_ids`, so a
 * person-link bump (better matching, the five-recipient repair) makes every
 * projected edge set provisional in exactly the way a better geocoder makes
 * every location estimate provisional. Same derivation shape as
 * `EstimateLocationStage`: a SUM offset so all-at-1 gives 1, monotone in each
 * term.
 */
export const PROMOTE_EDGE_COMMUNICATION_VERSION = EDGE_PROJECTION_RULE_GENERATION + PERSON_LINK_VERSION - 1;

/**
 * Event-leg version: tracks BOTH of its producers — `enrich.event_person_link`
 * fills `organizer_entity_id` / `participant_entity_ids` (same shared
 * `PERSON_LINK_VERSION`) and `promote.place` fills `location_entity_id`. A
 * bump of either re-opens this projection.
 */
export const PROMOTE_EDGE_EVENT_VERSION =
  EDGE_PROJECTION_RULE_GENERATION + PERSON_LINK_VERSION + PROMOTE_PLACE_VERSION - 2;

/**
 * Content-leg version: `ci.content.event_id` is written by importers at
 * ingest, not by a versioned producer stage — so the projection generation is
 * the only moving part.
 */
export const PROMOTE_EDGE_CONTENT_VERSION = EDGE_PROJECTION_RULE_GENERATION;

/**
 * Inventory-leg version: `ci.inventory.last_seen_place_entity_id` is written
 * by `promote.object` (and importers), so its version rides along — same SUM
 * offset shape as the other legs.
 */
export const PROMOTE_EDGE_INVENTORY_VERSION = EDGE_PROJECTION_RULE_GENERATION + PROMOTE_OBJECT_VERSION - 1;

/**
 * Receipt-leg version: `merchant_entity_id` / `place_entity_id` /
 * `document_content_id` / `event_id` are written by the receipt-extraction
 * services at ingest, not by a versioned producer stage — projection
 * generation only, like the content leg.
 */
export const PROMOTE_EDGE_RECEIPT_VERSION = EDGE_PROJECTION_RULE_GENERATION;

/**
 * Observation-leg version: `resolved_object_id` is written by
 * `promote.object`, so its version rides along — same derivation shape as the
 * inventory leg. (`place_entity_id` / `content_id` / `event_id` are set at
 * capture time.)
 */
export const PROMOTE_EDGE_OBSERVATION_VERSION = EDGE_PROJECTION_RULE_GENERATION + PROMOTE_OBJECT_VERSION - 1;

/**
 * Position-leg version: `location_entity_id` is snapped to a known place by
 * the position domain at capture time (PositionService / KnownPlacesService),
 * not by a versioned stage — projection generation only.
 */
export const PROMOTE_EDGE_POSITION_VERSION = EDGE_PROJECTION_RULE_GENERATION;

/**
 * Device-leg version: `device_entity_id` is written at device registration —
 * projection generation only.
 */
export const PROMOTE_EDGE_DEVICE_VERSION = EDGE_PROJECTION_RULE_GENERATION;

/** File-leg: `ci.files.parent_id` + File entity mirrors — projection generation only. */
export const PROMOTE_EDGE_FILE_VERSION = EDGE_PROJECTION_RULE_GENERATION;

/** Place-leg: `entities.parent_place_id` — projection generation only. */
export const PROMOTE_EDGE_PLACE_VERSION = EDGE_PROJECTION_RULE_GENERATION;

/**
 * Cross-check a derived version against its `STAGE_VERSIONS` mirror — the same
 * contract every derived-version stage keeps (`promotePlaceStageVersion`,
 * `personLinkStageVersion`): the derivation is the authority, the entry is its
 * reviewable mirror, and a disagreement throws HERE at module load. A missing
 * entry is not an error — this file is imported by its own spec before the
 * central declarations land.
 */
export function promoteEdgeStageVersion(
  stageId: string,
  derived: number,
  versions: Record<string, StageVersion> = STAGE_VERSIONS,
): number {
  const declared = versions[stageId];

  if (typeof declared === 'number' && declared !== derived) {
    throw new Error(
      `STAGE_VERSIONS["${stageId}"] declares ${declared} but the stage derives ${derived} from ` +
        `EDGE_PROJECTION_RULE_GENERATION (${EDGE_PROJECTION_RULE_GENERATION}) + its producers' ` +
        `versions (PERSON_LINK_VERSION ${PERSON_LINK_VERSION}, PROMOTE_PLACE_VERSION ` +
        `${PROMOTE_PLACE_VERSION}, PROMOTE_OBJECT_VERSION ${PROMOTE_OBJECT_VERSION}). ` +
        `Bumping a generation is only half the change: update ` +
        `versions.ts in the same commit, or the two disagree about what has been projected.`,
    );
  }

  return derived;
}

// Run at module load — the earliest possible failure is the cheapest one.
promoteEdgeStageVersion(PROMOTE_EDGE_COMMUNICATION_STAGE_ID, PROMOTE_EDGE_COMMUNICATION_VERSION);
promoteEdgeStageVersion(PROMOTE_EDGE_EVENT_STAGE_ID, PROMOTE_EDGE_EVENT_VERSION);
promoteEdgeStageVersion(PROMOTE_EDGE_CONTENT_STAGE_ID, PROMOTE_EDGE_CONTENT_VERSION);
promoteEdgeStageVersion(PROMOTE_EDGE_INVENTORY_STAGE_ID, PROMOTE_EDGE_INVENTORY_VERSION);
promoteEdgeStageVersion(PROMOTE_EDGE_RECEIPT_STAGE_ID, PROMOTE_EDGE_RECEIPT_VERSION);
promoteEdgeStageVersion(PROMOTE_EDGE_OBSERVATION_STAGE_ID, PROMOTE_EDGE_OBSERVATION_VERSION);
promoteEdgeStageVersion(PROMOTE_EDGE_POSITION_STAGE_ID, PROMOTE_EDGE_POSITION_VERSION);
promoteEdgeStageVersion(PROMOTE_EDGE_DEVICE_STAGE_ID, PROMOTE_EDGE_DEVICE_VERSION);
promoteEdgeStageVersion(PROMOTE_EDGE_FILE_STAGE_ID, PROMOTE_EDGE_FILE_VERSION);
promoteEdgeStageVersion(PROMOTE_EDGE_PLACE_STAGE_ID, PROMOTE_EDGE_PLACE_VERSION);

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

/**
 * Applicability: a communication SOME linker has already resolved at least one
 * participant of. The linkage columns are INPUTS here (written by
 * `enrich.person_link` and the arrival listener, never by this stage — this
 * stage writes `ci.relationships`), so the predicate is what a row IS, not
 * what has been done to it: an unlinked communication is simply not yet a
 * candidate, and it BECOMES one — never-run, immediately due — the night the
 * linker fills its columns. That is what makes this stage continuous without a
 * ratchet.
 */
export const PROMOTE_EDGE_COMMUNICATION_SOURCE: StageSource = {
  schema: 'ci',
  table: 'communications',
  idColumn: 'id',
  userColumn: 'user_id',
  predicate:
    `(s.from_entity_id IS NOT NULL ` +
    `OR (s.to_entity_ids IS NOT NULL AND cardinality(s.to_entity_ids) > 0))`,
};

/** Same shape over `ci.events`: any of the four linkage columns populated
 * (parent_event_id feeds the `event.child_of` PART_OF rule). */
export const PROMOTE_EDGE_EVENT_SOURCE: StageSource = {
  schema: 'ci',
  table: 'events',
  idColumn: 'event_id',
  userColumn: 'user_id',
  predicate:
    `(s.organizer_entity_id IS NOT NULL ` +
    `OR (s.participant_entity_ids IS NOT NULL AND cardinality(s.participant_entity_ids) > 0) ` +
    `OR s.location_entity_id IS NOT NULL ` +
    `OR s.parent_event_id IS NOT NULL)`,
};

/** `ci.content` rows attached to an event — the `content.part_of_event` rule's
 * candidates. `event_id` is set at ingest by importers. */
export const PROMOTE_EDGE_CONTENT_SOURCE: StageSource = {
  schema: 'ci',
  table: 'content',
  idColumn: 'id',
  userColumn: 'user_id',
  predicate: 's.event_id IS NOT NULL',
};

/** `ci.inventory` rows with a last-seen place — the `inventory.located_at`
 * rule's candidates. */
export const PROMOTE_EDGE_INVENTORY_SOURCE: StageSource = {
  schema: 'ci',
  table: 'inventory',
  idColumn: 'object_id',
  userColumn: 'user_id',
  predicate: 's.last_seen_place_entity_id IS NOT NULL',
};

/** `ci.receipts` rows where extraction resolved at least one linkage PAIR —
 * every receipt rule needs both of its endpoints, so a row with only one
 * column filled is not yet a candidate for any of them. */
export const PROMOTE_EDGE_RECEIPT_SOURCE: StageSource = {
  schema: 'ci',
  table: 'receipts',
  idColumn: 'receipt_id',
  userColumn: 'user_id',
  predicate:
    `((s.merchant_entity_id IS NOT NULL AND s.place_entity_id IS NOT NULL) ` +
    `OR (s.document_content_id IS NOT NULL AND s.event_id IS NOT NULL) ` +
    `OR (s.event_id IS NOT NULL AND s.place_entity_id IS NOT NULL))`,
};

/** `ci.object_observations` rows with at least one complete linkage pair —
 * capture fills content/event/place, `promote.object` fills the resolved
 * object; a row becomes a candidate as soon as any pair completes. */
export const PROMOTE_EDGE_OBSERVATION_SOURCE: StageSource = {
  schema: 'ci',
  table: 'object_observations',
  idColumn: 'observation_id',
  userColumn: 'user_id',
  predicate:
    `((s.content_id IS NOT NULL AND s.event_id IS NOT NULL) ` +
    `OR (s.resolved_object_id IS NOT NULL AND s.place_entity_id IS NOT NULL) ` +
    `OR (s.resolved_object_id IS NOT NULL AND s.content_id IS NOT NULL))`,
};

/** `ci.position` fixes snapped to a known place — the `position.visited`
 * rule's candidates. Same per-id ledger `enrich.position_reverse` already
 * runs over this table; the projection itself collapses a whole slice to at
 * most a few distinct (owner, place) edges. */
export const PROMOTE_EDGE_POSITION_SOURCE: StageSource = {
  schema: 'ci',
  table: 'position',
  idColumn: 'id',
  userColumn: 'user_id',
  predicate: 's.location_entity_id IS NOT NULL',
};

/** `ci.devices` rows mirrored as a device entity — the `device.owned_by`
 * rule's candidates. */
export const PROMOTE_EDGE_DEVICE_SOURCE: StageSource = {
  schema: 'ci',
  table: 'devices',
  idColumn: 'device_id',
  userColumn: 'user_id',
  predicate: 's.device_entity_id IS NOT NULL',
};

/** `ci.files` with a parent — File −DERIVED_FROM→ File. */
export const PROMOTE_EDGE_FILE_SOURCE: StageSource = {
  schema: 'ci',
  table: 'files',
  idColumn: 'id',
  userColumn: 'user_id',
  predicate: 's.parent_id IS NOT NULL',
};

/** Place/Location entities with a parent_place_id — Place −PART_OF→ Place. */
export const PROMOTE_EDGE_PLACE_SOURCE: StageSource = {
  schema: 'ci',
  table: 'entities',
  idColumn: 'entity_id',
  userColumn: 'owner_user_id',
  predicate: `s.parent_place_id IS NOT NULL AND s.entity_type IN ('Location', 'Place') AND s.is_active = TRUE`,
};

// ---------------------------------------------------------------------------
// The stages
// ---------------------------------------------------------------------------

/**
 * Materialize the deterministic-edge matrix continuously: the pipeline face of
 * `DeterministicEdgeBackfillService` (the operator endpoint sweeps history in
 * time windows; this sweeps the ledger's stale ids in slices — same
 * projection, same idempotency, same graph deltas).
 *
 * ── What it writes, and where each is read ─────────────────────────────────
 *
 *  - `ci.relationships` — Person→Communication SENT/RECEIVED,
 *    Person→Event PARTICIPATED_IN, Event→Place HAPPENED_AT. READ by the graph
 *    traversal (`GraphQueryService.traverseGraph` → the graph view / focus
 *    mode), which walks ONLY this table — these edges are what make a person's
 *    emails reachable there at all.
 *  - `ci.graph_deltas` — one `relationship/created` row per edge, via
 *    `GraphDeltaWriter`, same transaction.
 *
 * ── Idempotency, and why every id is `done` ────────────────────────────────
 *
 * The projection is set-based per slice and ON-CONFLICT-idempotent per edge; a
 * re-run costs zero writes. An id whose row produced no edges (recipients
 * resolved to entities since deleted, say) is still `done`: "projected,
 * nothing to write" is a completed decision at this version, and a version
 * bump — which the producers' versions feed, see above — is what re-opens it.
 *
 * ── What it costs ──────────────────────────────────────────────────────────
 *
 * Postgres only: one INSERT…SELECT per matrix rule per slice, no provider, no
 * bill. Nightly for the same batch-affinity reason as its producers: a day's
 * links projected in one pass, ordered after them by `STAGE_DEPENDENCIES`.
 */
abstract class EdgePromoteStageBase implements Stage {
  abstract readonly id: string;

  abstract readonly version: number;

  abstract readonly source: StageSource;

  abstract readonly entityTypes: readonly string[];

  /** Postgres-bound, like `promote.place` — same resource class, same queue. */
  readonly queue = PIPELINE_QUEUES.INDEX;

  protected abstract readonly sourceKind: DeterministicEdgeSource;

  constructor(
    protected readonly edgeService: DeterministicEdgeBackfillService,
    protected readonly logger: LoggerService,
  ) {
    this.logger.setContext(new.target.name);
  }

  async run(ctx: UserServiceContext, ids: string[]): Promise<Map<string, StageResult>> {
    const results = new Map<string, StageResult>();

    if (ids.length === 0) {
      return results;
    }

    try {
      const edgesCreated = await this.edgeService.materializeForSourceIds(ctx.userId, this.sourceKind, ids);

      for (const id of ids) {
        results.set(id, { outcome: 'done' });
      }

      this.logger.debug('Edge projection slice complete', {
        stage: this.id,
        ids: ids.length,
        edgesCreated,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      // One projection per rule means one verdict per slice: it committed or it
      // did not, and attributing the failure to one id would be a guess. FAILED,
      // not skipped — a transport error is worth the ledger's retry schedule.
      for (const id of ids) {
        results.set(id, { outcome: 'failed', reason: 'edge_projection_failed', detail: { message } });
      }

      this.logger.error(
        `Edge projection failed for ${ids.length} ${this.sourceKind}`,
        err instanceof Error ? err : new Error(message),
      );
    }

    return results;
  }
}

@Injectable()
export class CommunicationEdgePromoteStage extends EdgePromoteStageBase {
  readonly id = PROMOTE_EDGE_COMMUNICATION_STAGE_ID;

  readonly version = promoteEdgeStageVersion(
    PROMOTE_EDGE_COMMUNICATION_STAGE_ID,
    PROMOTE_EDGE_COMMUNICATION_VERSION,
  );

  readonly source = PROMOTE_EDGE_COMMUNICATION_SOURCE;

  readonly entityTypes = ['communication'] as const;

  protected readonly sourceKind: DeterministicEdgeSource = 'communications';

  // Explicit rather than inherited: a derived class with only the default
  // constructor reports `Function.length` 0, and stageWiring.spec uses that
  // arity to know how many stub dependencies to construct with.
  constructor(edgeService: DeterministicEdgeBackfillService, logger: LoggerService) {
    super(edgeService, logger);
  }
}

@Injectable()
export class EventEdgePromoteStage extends EdgePromoteStageBase {
  readonly id = PROMOTE_EDGE_EVENT_STAGE_ID;

  readonly version = promoteEdgeStageVersion(PROMOTE_EDGE_EVENT_STAGE_ID, PROMOTE_EDGE_EVENT_VERSION);

  readonly source = PROMOTE_EDGE_EVENT_SOURCE;

  readonly entityTypes = ['event'] as const;

  protected readonly sourceKind: DeterministicEdgeSource = 'events';

  // See CommunicationEdgePromoteStage: arity must be visible to the wiring spec.
  constructor(edgeService: DeterministicEdgeBackfillService, logger: LoggerService) {
    super(edgeService, logger);
  }
}

@Injectable()
export class ContentEdgePromoteStage extends EdgePromoteStageBase {
  readonly id = PROMOTE_EDGE_CONTENT_STAGE_ID;

  readonly version = promoteEdgeStageVersion(PROMOTE_EDGE_CONTENT_STAGE_ID, PROMOTE_EDGE_CONTENT_VERSION);

  readonly source = PROMOTE_EDGE_CONTENT_SOURCE;

  readonly entityTypes = ['content'] as const;

  protected readonly sourceKind: DeterministicEdgeSource = 'content';

  // See CommunicationEdgePromoteStage: arity must be visible to the wiring spec.
  constructor(edgeService: DeterministicEdgeBackfillService, logger: LoggerService) {
    super(edgeService, logger);
  }
}

@Injectable()
export class InventoryEdgePromoteStage extends EdgePromoteStageBase {
  readonly id = PROMOTE_EDGE_INVENTORY_STAGE_ID;

  readonly version = promoteEdgeStageVersion(PROMOTE_EDGE_INVENTORY_STAGE_ID, PROMOTE_EDGE_INVENTORY_VERSION);

  readonly source = PROMOTE_EDGE_INVENTORY_SOURCE;

  readonly entityTypes = ['item'] as const;

  protected readonly sourceKind: DeterministicEdgeSource = 'inventory';

  // See CommunicationEdgePromoteStage: arity must be visible to the wiring spec.
  constructor(edgeService: DeterministicEdgeBackfillService, logger: LoggerService) {
    super(edgeService, logger);
  }
}

@Injectable()
export class ReceiptEdgePromoteStage extends EdgePromoteStageBase {
  readonly id = PROMOTE_EDGE_RECEIPT_STAGE_ID;

  readonly version = promoteEdgeStageVersion(PROMOTE_EDGE_RECEIPT_STAGE_ID, PROMOTE_EDGE_RECEIPT_VERSION);

  readonly source = PROMOTE_EDGE_RECEIPT_SOURCE;

  readonly entityTypes = ['receipt'] as const;

  protected readonly sourceKind: DeterministicEdgeSource = 'receipts';

  // See CommunicationEdgePromoteStage: arity must be visible to the wiring spec.
  constructor(edgeService: DeterministicEdgeBackfillService, logger: LoggerService) {
    super(edgeService, logger);
  }
}

@Injectable()
export class ObservationEdgePromoteStage extends EdgePromoteStageBase {
  readonly id = PROMOTE_EDGE_OBSERVATION_STAGE_ID;

  readonly version = promoteEdgeStageVersion(
    PROMOTE_EDGE_OBSERVATION_STAGE_ID,
    PROMOTE_EDGE_OBSERVATION_VERSION,
  );

  readonly source = PROMOTE_EDGE_OBSERVATION_SOURCE;

  readonly entityTypes = ['observation'] as const;

  protected readonly sourceKind: DeterministicEdgeSource = 'observations';

  // See CommunicationEdgePromoteStage: arity must be visible to the wiring spec.
  constructor(edgeService: DeterministicEdgeBackfillService, logger: LoggerService) {
    super(edgeService, logger);
  }
}

@Injectable()
export class PositionEdgePromoteStage extends EdgePromoteStageBase {
  readonly id = PROMOTE_EDGE_POSITION_STAGE_ID;

  readonly version = promoteEdgeStageVersion(PROMOTE_EDGE_POSITION_STAGE_ID, PROMOTE_EDGE_POSITION_VERSION);

  readonly source = PROMOTE_EDGE_POSITION_SOURCE;

  readonly entityTypes = ['position'] as const;

  protected readonly sourceKind: DeterministicEdgeSource = 'positions';

  // See CommunicationEdgePromoteStage: arity must be visible to the wiring spec.
  constructor(edgeService: DeterministicEdgeBackfillService, logger: LoggerService) {
    super(edgeService, logger);
  }
}

@Injectable()
export class DeviceEdgePromoteStage extends EdgePromoteStageBase {
  readonly id = PROMOTE_EDGE_DEVICE_STAGE_ID;

  readonly version = promoteEdgeStageVersion(PROMOTE_EDGE_DEVICE_STAGE_ID, PROMOTE_EDGE_DEVICE_VERSION);

  readonly source = PROMOTE_EDGE_DEVICE_SOURCE;

  readonly entityTypes = ['device'] as const;

  protected readonly sourceKind: DeterministicEdgeSource = 'devices';

  // See CommunicationEdgePromoteStage: arity must be visible to the wiring spec.
  constructor(edgeService: DeterministicEdgeBackfillService, logger: LoggerService) {
    super(edgeService, logger);
  }
}

@Injectable()
export class FileEdgePromoteStage extends EdgePromoteStageBase {
  readonly id = PROMOTE_EDGE_FILE_STAGE_ID;

  readonly version = promoteEdgeStageVersion(PROMOTE_EDGE_FILE_STAGE_ID, PROMOTE_EDGE_FILE_VERSION);

  readonly source = PROMOTE_EDGE_FILE_SOURCE;

  readonly entityTypes = ['file'] as const;

  protected readonly sourceKind: DeterministicEdgeSource = 'files';

  constructor(edgeService: DeterministicEdgeBackfillService, logger: LoggerService) {
    super(edgeService, logger);
  }
}

@Injectable()
export class PlaceEdgePromoteStage extends EdgePromoteStageBase {
  readonly id = PROMOTE_EDGE_PLACE_STAGE_ID;

  readonly version = promoteEdgeStageVersion(PROMOTE_EDGE_PLACE_STAGE_ID, PROMOTE_EDGE_PLACE_VERSION);

  readonly source = PROMOTE_EDGE_PLACE_SOURCE;

  readonly entityTypes = ['place'] as const;

  protected readonly sourceKind: DeterministicEdgeSource = 'places';

  constructor(edgeService: DeterministicEdgeBackfillService, logger: LoggerService) {
    super(edgeService, logger);
  }
}

import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
// The memory domain's PUBLIC barrel — `no-cross-domain-internals` allows
// `index.ts` and nothing else. `ObjectObservationService` is the sole writer of
// `ci.object_observations` and owns both idempotency arbiters; `PlaceService`
// owns the PostGIS nearest-place read. Re-implementing either here would give
// the sighting table a second writer with its own opinion about identity, which
// is the thing that made `ci.objects` hard.
import { ObjectObservationService, PlaceService, type CreateObjectObservationDto } from '@ci/domains/memory';

import { PIPELINE_QUEUES } from '../../constants';
import type { Stage, StageResult, StageSource } from '../../types';
import { STAGE_VERSIONS, type StageVersion } from '../../versions';

/**
 * This stage's id. Becomes `STAGE_IDS.PROMOTE_OBSERVATION`, and this const its
 * alias, in the same change that lands the wiring.
 *
 * IDS ARE PERMANENT — the id is the third component of `ci.pipeline_state`'s
 * primary key.
 */
export const PROMOTE_OBSERVATION_STAGE_ID = 'promote.observation';

/** The ledger `entity_type` this stage records under. */
const ENTITY_TYPE = 'event';

/**
 * v1 — initial scan-sighting promotion.
 *
 * A literal, for the same reason `promote.object`'s is: this stage reads
 * nothing another stage produces. It reads `capture.scan` metadata, which
 * arrives whole from `/v1/events` and is never rewritten.
 *
 * Bump when {@link extractScanObjects} changes what it extracts — most likely
 * when CI-Spatial widens its wire (see the class docblock), because the day a
 * scan starts carrying 3-D extents is the day every already-promoted scan is
 * carrying less than it could.
 */
export const PROMOTE_OBSERVATION_VERSION = 1;

/**
 * `ci.events.event_type` for a Companion Scan room capture.
 *
 * `/v1/events` writes `event_type` straight from the record's `kind`
 * (`BulkIngestController`), so the value CI-Spatial sends in `kind:
 * 'capture.scan'` IS this string. Not a mapping, an identity — which is why
 * there is no translation table anywhere in this file.
 */
const SCAN_EVENT_TYPE = 'capture.scan';

/**
 * `source_kind` recorded for a scan sighting.
 *
 * `object_observations_source_kind_check` admits exactly
 * `photo | video_frame | live_camera | screenshot | manual`, and a room scan is
 * none of them precisely. `live_camera` is the closest TRUE statement — the
 * labels come from a live camera sweep of a room, not from a still, a video
 * file, a screen grab or a person typing. Adding a `scan` value is a migration,
 * and this change deliberately does not touch the schema.
 */
const SCAN_SOURCE_KIND = 'live_camera';

/**
 * How near an existing place must be for a scan to be said to have happened
 * there, in metres.
 *
 * Consumer GPS on a phone indoors is routinely 20-50 m out, and the geo on a
 * scan is the device's fix at capture time. 150 m is wide enough to survive
 * that and narrow enough that "home" and the café at the end of the street do
 * not both match — which matters, because `place_entity_id` is the prior the
 * whole resolution ladder leans on: the migration's argument is that a "mug" at
 * home resolves against a small candidate set while the same label in a café
 * correctly resolves to nothing.
 *
 * Nothing is CREATED at this radius. A scan somewhere with no known place stays
 * a sighting with coordinates and no place, which is the honest answer.
 */
const SCAN_PLACE_RADIUS_METERS = 150;

/** Decimals a scan-local coordinate is rounded to before it enters an id. */
const SCAN_POSITION_PRECISION = 2;

/**
 * `source_system` when the event carries none.
 *
 * NOT defensive padding — it closes an unbounded-duplication hole. The triple
 * index is `UNIQUE (owner_user_id, source_type, source_system, source_id)`, and
 * in Postgres two NULLs in a multi-column unique index DO NOT CONFLICT. A row
 * written with a NULL `source_system` therefore matches nothing on the next
 * pass, so every re-promotion — every version bump, every dead-letter replay —
 * would INSERT a fresh set of sightings instead of updating them.
 *
 * `/v1/events` requires `source_system` (`captureEventSchema` has
 * `z.string().min(1)`), so a scan pushed by CI-Spatial always has one. But
 * `ci.events.source_system` is NULLABLE and this stage selects on `event_type`
 * alone, so an event written by any other path is one NULL away from that
 * failure. Making the arbiter total costs a constant.
 */
const UNKNOWN_SOURCE_SYSTEM = 'unknown';

/**
 * `source_type` on every observation this stage writes.
 *
 * With the event's `source_system` and a per-object id it forms the provenance
 * triple `object_observations_source_triple_uniq` is keyed on, so re-promoting
 * a scan updates its sightings rather than minting a second set. Naming it
 * after the stage also isolates these rows from any other writer's, exactly as
 * `promote.object` does for `ci.objects`.
 */
const PROMOTED_SOURCE_TYPE = PROMOTE_OBSERVATION_STAGE_ID;

/**
 * The slice's candidate rows: undeleted scan events.
 *
 * The predicate is APPLICABILITY, never completion — no clause here references
 * `ci.object_observations`. A `NOT EXISTS` against the sightings would make the
 * candidate set shrink as the stage succeeded, which is the one-way ratchet the
 * ledger exists to remove: a version bump could never bring a promoted scan
 * back for re-extraction.
 */
export const PROMOTE_OBSERVATION_SOURCE: StageSource = {
  schema: 'ci',
  table: 'events',
  idColumn: 'event_id',
  userColumn: 'user_id',
  predicate: `s.event_type = '${SCAN_EVENT_TYPE}' AND COALESCE(s.is_deleted, false) = false`,
};

/** A `capture.scan` event, as far as this stage cares. */
export interface ScanRow {
  id: string;
  start_time: Date | null;
  metadata: Record<string, unknown> | null;
  source_system: string | null;
  location_entity_id: string | null;
  lat: number | null;
  lng: number | null;
}

/** One detected object, after extraction and validation. */
export interface ScanObject {
  label: string;
  /** Scan-LOCAL metres, not degrees. See {@link extractScanObjects}. */
  position: { x: number; y: number; z: number } | null;
  /** Stable within the scan; the third component of the provenance triple. */
  objectKey: string;
}

/** The geo block a scan carries, once validated. */
export interface ScanLocation {
  lat: number;
  lng: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The scan's geographic fix, from the payload rather than from a column.
 *
 * `/v1/events` folds `payload` into `metadata` and writes NO geo columns, so a
 * `capture.scan` row reaches Postgres with `location_coordinates` NULL — which
 * in turn means `promote.place` never selects it (that stage's predicate
 * requires both `location_coordinates` and `location_name`) and
 * `location_entity_id` stays NULL too. The event's own columns are still read
 * first, because an importer or a later stage may legitimately have filled
 * them; `metadata.location` is the fallback that actually fires today.
 *
 * CI-Spatial writes `lon`, not `lng` (`memory_push.ts`). Both spellings are
 * accepted because this is a cross-repo wire and one of them being wrong here
 * is a silent NULL, not an error.
 */
export function extractScanLocation(row: ScanRow): ScanLocation | null {
  if (row.lat != null && row.lng != null) {
    return { lat: row.lat, lng: row.lng };
  }

  const location = isRecord(row.metadata) ? row.metadata.location : null;

  if (!isRecord(location)) {
    return null;
  }

  const lat = finiteNumber(location.lat);
  const lng = finiteNumber(location.lon) ?? finiteNumber(location.lng);

  return lat != null && lng != null ? { lat, lng } : null;
}

/**
 * Pull the detected objects out of a scan's metadata.
 *
 * ── BUILT FOR WHAT ARRIVES ─────────────────────────────────────────────────
 *
 * CI-Spatial's `memory_push.ts` narrows every detection to `{label, position}`
 * before it sends — the sidecar's 3-D extents and rotations are dropped at the
 * push, not lost in transit:
 *
 *     objects: detections
 *       .filter((d) => d.label && d.position)
 *       .map((d) => ({ label: d.label, position: d.position }))
 *
 * So a scan sighting has a label and a point, and this function reads exactly
 * that. There is no speculative parsing of `extent`, `rotation`, `bbox3d` or
 * `dimensions` here: those fields do not arrive, code that reads them cannot be
 * tested against real data, and a reader written for a wire that does not exist
 * is how a fabricated `dimensions` field ends up being believed downstream.
 * When the push widens, this function and
 * {@link PROMOTE_OBSERVATION_VERSION} change together and every scan re-promotes.
 *
 * `position` is SCAN-LOCAL metres in the capture's own frame — not latitude and
 * longitude, and not comparable between two scans of the same room. That is why
 * it goes to `attributes.scan_position` under an explicit
 * `scan_frame: 'scan_local'` tag and never near `location_coordinates`.
 */
export function extractScanObjects(row: ScanRow): ScanObject[] {
  const raw = isRecord(row.metadata) ? row.metadata.objects : null;

  if (!Array.isArray(raw)) {
    return [];
  }

  const objects: ScanObject[] = [];

  raw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      return;
    }

    const label = typeof entry.label === 'string' ? entry.label.trim() : '';

    if (label === '') {
      return;
    }

    const rawPosition = isRecord(entry.position) ? entry.position : null;
    const x = rawPosition != null ? finiteNumber(rawPosition.x) : null;
    const y = rawPosition != null ? finiteNumber(rawPosition.y) : null;
    const z = rawPosition != null ? finiteNumber(rawPosition.z) : null;
    const position = x != null && y != null && z != null ? { x, y, z } : null;

    // ── The per-object id, and why it is not the array index ───────────────
    //
    // A positional key is stable only while the array order is, and nothing
    // about the sidecar promises that: a re-run of splat-detect that emits the
    // same objects in a different order would UPDATE row 3 from "chair" to
    // "lamp" — a silent relabel of an existing sighting, which is worse than a
    // duplicate because nothing looks wrong afterwards.
    //
    // Label + rounded position is a real natural key inside one scan: two
    // detections at the same point with the same label ARE the same detection.
    // It is order-independent, and it survives the float jitter of a re-run at
    // centimetre rounding. This is `identity/naturalKey.ts`'s rule — a key
    // needs at least two non-temporal dimensions — applied to a scan.
    //
    // With no position there is only one dimension, so the ordinal comes back
    // as the second. `memory_push` filters those out before sending, so this
    // branch covers a malformed or hand-written payload rather than the wire.
    const objectKey =
      position != null
        ? sha256Hex(
            [
              label.toLowerCase(),
              position.x.toFixed(SCAN_POSITION_PRECISION),
              position.y.toFixed(SCAN_POSITION_PRECISION),
              position.z.toFixed(SCAN_POSITION_PRECISION),
            ].join('\0'),
          ).slice(0, 32)
        : `ordinal:${index}`;

    objects.push({ label, position, objectKey });
  });

  return objects;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Turns Companion Scan room captures into SIGHTINGS.
 *
 * ── The gap this closes ────────────────────────────────────────────────────
 *
 * CI-Spatial has been pushing one `capture.scan` event per room scan to
 * `POST /v1/events` — with `payload.objects`, `payload.detected_labels`, a
 * point count and a geo block — and NOTHING IN THIS REPO READ IT. `promote.object`
 * promotes `purchase` and `order` and stops there; the string `capture.scan`
 * appeared nowhere in the backend. The scans landed as events with a title and
 * some JSON, and the objects inside them were, for every query anyone could
 * write, invisible.
 *
 * Meanwhile `ci.object_observations` shipped with a full column set, two
 * idempotency arbiters, a review index and a downstream edge projection
 * (`promote.edge_observation`, which already knows how to turn an observation
 * into `Item -LOCATED_AT→ Place` and `Content -PART_OF→ Event` edges) — and no
 * writer. Both halves were built; the wire between them was not.
 *
 * ── Why a stage and not a listener ─────────────────────────────────────────
 *
 * The scans are ALREADY IN THE DATABASE. A listener on event creation would
 * pick up tomorrow's scans and leave every scan pushed to date unread; the
 * ledger sweep reads history and new arrivals with the same query, and a
 * version bump re-reads everything when the extraction rule improves. The
 * migration's own follow-up shape (re-run the detector, update in place) only
 * works if something sweeps.
 *
 * ── What it writes, and what it refuses to ─────────────────────────────────
 *
 * One `ci.object_observations` row per detected object: a label, the scan's
 * place and coordinates, and the scan-local position in `attributes`. Nothing
 * else, because nothing else arrives (see {@link extractScanObjects}).
 *
 * It writes NO `ci.objects` row and sets NO resolution column. A scan says a
 * chair-shaped thing was at a point in a room; it does not say whose chair, or
 * that it is the same chair as last week's. Minting from a sighting is
 * `ObjectResolutionService`'s job, above an auto-mint confidence that does not
 * exist yet. Until then these rows sit in the review queue
 * (`object_observations_review_idx`), which is exactly where an unconfirmed
 * guess belongs.
 */
@Injectable()
export class ObservationPromoteStage implements Stage {
  readonly id = PROMOTE_OBSERVATION_STAGE_ID;

  /**
   * Read from the central map, and cross-checked against the local derivation
   * at construction — the same belt-and-braces every other stage uses, so a
   * version edited in one place and not the other fails loudly at boot rather
   * than quietly re-promoting (or not) at 3am.
   */
  readonly version = promoteObservationStageVersion();

  /**
   * Postgres-bound: metadata in, rows out, plus one bounded PostGIS lookup per
   * distinct scan location. No provider, no Ollama, no object storage — so it
   * belongs on the cheap high-throughput queue with the other ledger writers.
   */
  readonly queue = PIPELINE_QUEUES.INDEX;

  readonly entityTypes = [ENTITY_TYPE] as const;

  readonly source = PROMOTE_OBSERVATION_SOURCE;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly observationService: ObjectObservationService,
    private readonly placeService: PlaceService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ObservationPromoteStage.name);
  }

  async run(ctx: UserServiceContext, ids: string[]): Promise<Map<string, StageResult>> {
    const results = new Map<string, StageResult>();

    if (ids.length === 0) {
      return results;
    }

    const rows = await this.loadRows(ctx.userId, ids);
    const byId = new Map(rows.map((row) => [row.id, row]));

    // Answer for ids that came back with no row FIRST, so the map is complete
    // even if the work below throws in a way this does not model.
    for (const id of ids) {
      if (!byId.has(id)) {
        results.set(id, { outcome: 'skipped', reason: 'source_row_missing' });
      }
    }

    for (const row of rows) {
      try {
        results.set(row.id, await this.promoteScan(ctx, row));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);

        // FAILED, not skipped: the retry gate and the attempt budget apply, so
        // a transient deadlock against a concurrent writer comes back rather
        // than being written off as a decision.
        results.set(row.id, {
          outcome: 'failed',
          reason: 'observation_write_failed',
          detail: { message },
        });

        this.logger.error(
          `Scan observation promote failed for event ${row.id}`,
          err instanceof Error ? err : new Error(message),
        );
      }
    }

    return results;
  }

  /** One scan → its sightings. */
  private async promoteScan(ctx: UserServiceContext, row: ScanRow): Promise<StageResult> {
    const objects = extractScanObjects(row);

    if (objects.length === 0) {
      // A scan with no detections is a real and common thing — the sidecar is
      // optional and `memory_push` sends the event without it. Recorded with a
      // reason so the backlog is a number in `GET /api/pipeline/state` rather
      // than a silence.
      return { outcome: 'skipped', reason: 'no_detected_objects' };
    }

    if (row.start_time == null) {
      // `observed_at` is NOT NULL, and inventing a time for a sighting would
      // put a fabricated point on the memory timeline.
      return { outcome: 'skipped', reason: 'no_start_time' };
    }

    const location = extractScanLocation(row);
    const placeEntityId = await this.resolvePlace(ctx, row, location);
    const observedAt = row.start_time;
    const sourceSystem = row.source_system?.trim() || UNKNOWN_SOURCE_SYSTEM;
    const glbFileId = this.scanFileId(row);

    const dtos: CreateObjectObservationDto[] = objects.map((object) => ({
      observedAt,
      sourceKind: SCAN_SOURCE_KIND,
      label: object.label,
      // The CHECK on `label_source` admits yolo | ollama_vision | clip | user |
      // import, and the scan sidecar's labeller is none of them. The truthful
      // record of who spoke is `detector`; putting a nearest-looking enum value
      // in a constrained column would be a wrong fact chosen to avoid a NULL in
      // a nullable one.
      labelSource: null,
      detector: sourceSystem,
      eventId: row.id,
      // The GLB the sighting lives inside. `file_id` has no FK by design —
      // files are purgeable — so a stale id here degrades to a dead pointer,
      // never to a blocked purge.
      fileId: glbFileId,
      placeEntityId,
      coordinates: location != null ? { lat: location.lat, lon: location.lng } : null,
      attributes: {
        ...(object.position != null && {
          // NAMED, not `position`, and tagged with its frame. This is metres in
          // the capture's own coordinate system — it is not geographic, it is
          // not comparable across two scans of the same room, and the one bug
          // worth designing against here is someone downstream reading it as
          // lat/lon.
          scan_position: object.position,
          scan_frame: 'scan_local',
        }),
      },
      metadata: {
        ...(isRecord(row.metadata) && {
          ...(row.metadata.scan_id != null && { scan_id: row.metadata.scan_id }),
          ...(row.metadata.session_id != null && { session_id: row.metadata.session_id }),
          ...(row.metadata.point_count != null && { point_count: row.metadata.point_count }),
        }),
        promoted_by: PROMOTE_OBSERVATION_STAGE_ID,
      },
      sourceType: PROMOTED_SOURCE_TYPE,
      sourceSystem,
      sourceId: `${row.id}:${object.objectKey}`,
    }));

    const result = await this.observationService.createMany(ctx, dtos);

    return {
      outcome: 'done',
      detail: {
        detected: objects.length,
        recorded: result.written.length,
        // Not noise: a scan whose sightings a user has confirmed is one this
        // stage must leave alone, and seeing that number climb after a version
        // bump is how an operator knows the guard is doing its job rather than
        // the write silently failing.
        protectedByConfirmation: result.protectedByConfirmation,
        duplicatesInBatch: result.duplicatesInBatch,
        rejected: result.rejectedUnarbitered,
        placeEntityId,
        located: location != null,
      },
    };
  }

  /**
   * The scan's place, by the strongest available evidence.
   *
   *  1. `ci.events.location_entity_id`, if some other writer resolved it. Trust
   *     an existing answer over re-deriving one.
   *  2. The nearest known place within {@link SCAN_PLACE_RADIUS_METERS} of the
   *     scan's fix.
   *  3. Nothing.
   *
   * It never CREATES a place. `PlaceService.findOrCreateForGeocode` exists and
   * is deliberately not called: a set of coordinates from a scan is not a
   * discovered location, and minting a Location entity per room scan would fill
   * the graph with unnamed points that the place-dedupe rules would then have
   * to argue with. A scan with no known place nearby is a sighting with
   * coordinates and no place — which is a true statement, and a resolvable one
   * later, once the user names that place by some other route.
   */
  private async resolvePlace(
    ctx: UserServiceContext,
    row: ScanRow,
    location: ScanLocation | null,
  ): Promise<string | null> {
    if (row.location_entity_id != null) {
      return row.location_entity_id;
    }

    if (location == null) {
      return null;
    }

    const [nearest] = await this.placeService.placesNear(ctx, {
      lat: location.lat,
      lng: location.lng,
      radiusMeters: SCAN_PLACE_RADIUS_METERS,
      limit: 1,
    });

    return nearest?.id ?? null;
  }

  /** The uploaded GLB's file id, when the push managed to upload one. */
  private scanFileId(row: ScanRow): string | null {
    if (!isRecord(row.metadata)) {
      return null;
    }

    const value = row.metadata.glb_file_id;

    // `memory_push` sets this to null when the upload was skipped (file missing,
    // too large, storage error) and still sends the event — a scan is a memory
    // without its geometry.
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  }

  /**
   * The slice's events, in one statement.
   *
   * Raw SQL rather than `CalendarEventService` for the reason `ObjectPromoteStage`
   * gives: the columns wanted are a strict subset of a ~40-column row, and
   * `metadata` is the exception because it IS the scan record.
   *
   * User-scoped even though the sweep already was: a slice can arrive from a
   * dead letter replayed weeks later, and re-scoping is the difference between
   * "this id is not yours" and writing someone else's room into this user's
   * memory.
   */
  private loadRows(userId: string, ids: string[]): Promise<ScanRow[]> {
    return this.dataSource.query<ScanRow[]>(
      `SELECT e.event_id AS id,
              e.start_time,
              e.metadata,
              e.source_system,
              e.location_entity_id,
              ST_Y(e.location_coordinates::geometry) AS lat,
              ST_X(e.location_coordinates::geometry) AS lng
         FROM ci.events e
        WHERE e.event_id = ANY($1::uuid[])
          AND e.user_id = $2::uuid`,
      [ids, userId],
    );
  }
}

/**
 * The local derivation, checked against the central declaration.
 *
 * Mirrors the guard every other stage carries: `STAGE_VERSIONS` is what the
 * ledger writes and this file is where the reason for the number lives, so they
 * are asserted equal at module load. A mismatch is a boot-time throw, not a
 * night of silently-wrong `stage_version` rows.
 */
export function promoteObservationStageVersion(): number {
  const declared: StageVersion | undefined = (STAGE_VERSIONS as Partial<Record<string, StageVersion>>)[
    PROMOTE_OBSERVATION_STAGE_ID
  ];

  const resolved = typeof declared === 'function' ? declared() : declared;

  if (resolved !== PROMOTE_OBSERVATION_VERSION) {
    throw new Error(
      `STAGE_VERSIONS["${PROMOTE_OBSERVATION_STAGE_ID}"] is ${String(resolved)} but ` +
        `PROMOTE_OBSERVATION_VERSION is ${PROMOTE_OBSERVATION_VERSION}. The ledger writes the ` +
        `former and this file explains the latter; they must be bumped together.`,
    );
  }

  return PROMOTE_OBSERVATION_VERSION;
}

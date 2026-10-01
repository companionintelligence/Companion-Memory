import { Injectable, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { isValidTimezone } from '@ci/common/time/zoned';
import { hourDowInTz } from '@ci/domains/daily-metrics/places/transitionMath';

import { PlaceService } from './PlaceService';
import { SELF_ENTITY_PROVISIONER, type SelfEntityProvisioner } from './selfEntityProvisioner';

/** Role a known place plays in the user's life. */
export type KnownPlaceKind = 'home' | 'work' | 'school' | 'social' | 'other';

/** How a known-place assertion was established. */
export type KnownPlaceSource = 'manual' | 'inferred' | 'geocoded';

/**
 * A known place, projected entirely from existing graph shapes — NOT a bespoke
 * table. The assertion "this Location plays role X in my life" already has a
 * natural home: a relationship from the user's self entity to a `ci.entities`
 * Location node. So:
 *   - `id`          = the relationship_id (the canonical id of the assertion)
 *   - `locationId`  = the Location entity (ci.entities.entity_id)
 *   - `kind`        = LIVES_IN → home, WORKS_AT → work, VISITED → properties.kind
 *   - `confidence`  = relationship.strength
 *   - active range  = relationship.start_date / end_date (homes move → an era)
 *   - extras        = relationship.properties (coordinates, aliases, source, label)
 */
export interface KnownPlace {
  id: string;
  locationId: string;
  label: string;
  kind: KnownPlaceKind;
  coordinates: { lat: number; lng: number } | null;
  confidence: number;
  /** ISO date — inclusive lower bound of the era, or null. */
  activeFrom: string | null;
  /** ISO date, or null when still current. */
  activeTo: string | null;
  aliases: string[];
  source: KnownPlaceSource;
}

/** One event that contributed to a known-place candidate, newest first. */
export interface KnownPlaceSampleEvent {
  /** ci.events.event_id */
  id: string;
  title: string;
  /** ISO-8601 start time. */
  startTime: string;
}

/** A candidate place discovered by the frequency / clustering pass. */
export interface KnownPlaceCandidate {
  /** ci.entities Location node id when the cluster is anchored to one. */
  locationId: string | null;
  /** Representative display name (location_name of the cluster's events). */
  label: string;
  /** Suggested kind from the clustering heuristic (home/work/other). */
  kind: KnownPlaceKind;
  /** Cluster centroid latitude. */
  lat: number;
  /** Cluster centroid longitude. */
  lng: number;
  /** Number of events supporting this cluster. */
  eventCount: number;
  /**
   * A few of the supporting events, newest first, so an "Unknown place" can
   * be recognized from what happened there.
   */
  sampleEvents: KnownPlaceSampleEvent[];
  /** Heuristic confidence in the candidate (0..1). */
  confidence: number;
  /**
   * Distinct local days on which `ci.position` puts the user in this
   * candidate's grid cell. Always 0 on a Location-anchored candidate: presence
   * is measured per cell and joins only the cell's grid candidate (see
   * {@link KnownPlacesService.readMeasuredPresence}).
   */
  presenceDays: number;
  /** Distinct local nights (21:00–06:00) with a fix in the cell; see {@link presenceDays}. */
  presenceNights: number;
}

/** Cluster the frequency pass accumulates before ranking. */
interface Cluster {
  locationId: string | null;
  labelCounts: Map<string, number>;
  latSum: number;
  lngSum: number;
  eventCount: number;
  samples: KnownPlaceSampleEvent[];
  /** Count of supporting events whose start hour is in 21:00–06:00 (home signal). */
  nightCount: number;
  /** Count of supporting events on weekdays in 09:00–17:00 (work signal). */
  workHoursCount: number;
  /** Measured presence in the cell; grid clusters only (see readMeasuredPresence). */
  presenceDays: number;
  presenceNights: number;
  /** Mean position of the cell's visits: the centroid of a cluster with no events. */
  presenceLat: number;
  presenceLng: number;
}

/**
 * How many of the user's most-common places to surface as candidates. We rank
 * places by event frequency (the "top common places" the user actually spends
 * time at) and classify Home/Work among them — no clustering model, no separate
 * store.
 */
const MAX_CANDIDATES = 50;

/** How many supporting events to show on a candidate so the place is recognizable. */
const SAMPLE_EVENT_LIMIT = 5;

function rememberSampleEvent(
  cluster: Cluster,
  row: { event_id: string | null; title: string | null; start_time: Date | string },
): void {
  const start = new Date(row.start_time);
  const startTime = Number.isNaN(start.getTime()) ? '' : start.toISOString();
  const title = row.title?.trim() || 'Untitled event';
  const id = row.event_id?.trim() || `${startTime}:${title}`;

  cluster.samples.push({ id, title, startTime });
  cluster.samples.sort((a, b) => b.startTime.localeCompare(a.startTime));

  if (cluster.samples.length > SAMPLE_EVENT_LIMIT) {
    cluster.samples.length = SAMPLE_EVENT_LIMIT;
  }
}

/** Coordinate grid size (degrees) for snapping nearby events into one cluster (~1.1km). */
const CLUSTER_PRECISION = 2;

/** The graph relationship types that express a known place. */
const KNOWN_PLACE_RELATIONSHIP_TYPES = ['LIVES_IN', 'WORKS_AT', 'VISITED'] as const;
type KnownPlaceRelationship = (typeof KNOWN_PLACE_RELATIONSHIP_TYPES)[number];

/** Map a role to the graph relationship type that carries it. */
function relationshipForKind(kind: KnownPlaceKind): KnownPlaceRelationship {
  switch (kind) {
    case 'home':
      return 'LIVES_IN';
    case 'work':
      return 'WORKS_AT';
    default:
      // school / social / other all ride on VISITED; the nuance lives in
      // relationship.properties.kind so we don't invent new edge types.
      return 'VISITED';
  }
}

/** Recover the role from a relationship type (+ properties.kind for VISITED). */
function kindForRelationship(relationshipType: string, propsKind: unknown): KnownPlaceKind {
  if (relationshipType === 'LIVES_IN') {
    return 'home';
  }

  if (relationshipType === 'WORKS_AT') {
    return 'work';
  }

  return propsKind === 'school' || propsKind === 'social' || propsKind === 'other'
    ? (propsKind as KnownPlaceKind)
    : 'other';
}

/** Relationship.strength has a CHECK (0..1); clamp inferred confidences into range. */
function clampStrength(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }

  return Math.max(0, Math.min(1, value));
}

/** Row shape returned by the known-place relationship⋈entity queries. */
interface KnownPlaceRow {
  id: string;
  relationship_type: string;
  strength: number | null;
  start_date: string | null;
  end_date: string | null;
  properties: Record<string, unknown> | null;
  location_id: string;
  name: string | null;
}

// ── Measured presence (ci.position) ──────────────────────────────────────────
// The rule is documented where it is applied: the signal and its cost bound on
// KnownPlacesService.readMeasuredPresence, the Home pick on pickPrimaryKinds.

/** Grid cells per degree: {@link CLUSTER_PRECISION} decimal places. */
const CELL_SCALE = 10 ** CLUSTER_PRECISION;

/**
 * The grid-cluster key for a coordinate. {@link KNOWN_PLACE_PRESENCE_SQL}
 * computes the same `floor(x * scale + 0.5)` in float8, so a fix and an event at
 * one coordinate always share a cell: both sides round the same IEEE doubles the
 * same way. `toFixed(2)`, which this replaces, does not agree with Postgres'
 * `round(x::numeric, 2)`: 139.765 is 139.76 in one and 139.77 in the other.
 */
function gridCellKey(lat: number, lng: number): string {
  return cellKey(Math.floor(lat * CELL_SCALE + 0.5), Math.floor(lng * CELL_SCALE + 0.5));
}

function cellKey(latCell: number, lngCell: number): string {
  return `${latCell},${lngCell}`;
}

/** Local hours that count as night, for events and fixes alike: [21:00, 06:00). */
const NIGHT_START_HOUR = 21;
const NIGHT_END_HOUR = 6;

/**
 * The cost bound on the presence read: it aggregates only the user's newest
 * this-many usable fixes. See {@link KnownPlacesService.readMeasuredPresence}.
 */
const PRESENCE_MAX_FIXES = 200_000;

/**
 * Cells the presence read returns, most days first. Only
 * {@link MAX_CANDIDATES} candidates survive ranking, and on the reference
 * corpus the 50th cell by days has 5 and the 200th has 1 (of 411 cells), so a
 * cell past this cap cannot move a candidate by more than a day.
 */
const PRESENCE_MAX_CELLS = 200;

/**
 * A fix reporting worse accuracy is dropped; one with no accuracy is kept. The
 * same rule `PlaceClusterService` (daily-metrics) applies before it detects
 * stays.
 */
const PRESENCE_MAX_ACCURACY_M = 100;

/**
 * The floors a cell must clear before its measured presence may name it Home,
 * in place of the event rule. See {@link KnownPlacesService.pickPrimaryKinds}.
 */
const PRESENCE_HOME_MIN_DAYS = 7;
const PRESENCE_HOME_MIN_NIGHTS = 2;

/**
 * The presence read: distinct local days and nights per grid cell over the
 * newest usable fixes, most days first. Exported so the integration spec can
 * run it against Postgres with a small cap.
 *
 * $1 user_id, $2 IANA timezone, $3 max accuracy (m), $4 max fixes,
 * $5 cells per degree, $6 night start hour, $7 night end hour, $8 max cells.
 *
 * `recent` is the bound: `ORDER BY time DESC` under a LIMIT, which TimescaleDB
 * serves by visiting chunks newest first and stopping. `visits` collapses a
 * track to one row per cell, day and night before anything is counted. A night
 * belongs to the date it began on: 02:00 on the 5th is the night of the 4th.
 */
export const KNOWN_PLACE_PRESENCE_SQL = `
WITH recent AS (
  SELECT pos.time AT TIME ZONE $2::text AS local_time,
         ST_Y(pos.location::geometry)  AS lat,
         ST_X(pos.location::geometry)  AS lng
    FROM ci.position pos
   WHERE pos.user_id = $1::uuid
     AND pos.location IS NOT NULL
     AND (pos.accuracy_meters IS NULL OR pos.accuracy_meters <= $3::float8)
   ORDER BY pos.time DESC
   LIMIT $4::int
), visits AS (
  SELECT floor(recent.lat * $5::float8 + 0.5) AS lat_cell,
         floor(recent.lng * $5::float8 + 0.5) AS lng_cell,
         recent.local_time::date AS day,
         CASE WHEN extract(hour FROM recent.local_time) >= $6::int
                OR extract(hour FROM recent.local_time) < $7::int
              THEN (recent.local_time - make_interval(hours => $7::int))::date
         END AS night,
         avg(recent.lat) AS lat,
         avg(recent.lng) AS lng
    FROM recent
   GROUP BY 1, 2, 3, 4
)
SELECT visits.lat_cell,
       visits.lng_cell,
       count(DISTINCT visits.day)   AS days,
       count(DISTINCT visits.night) AS nights,
       avg(visits.lat)              AS lat,
       avg(visits.lng)              AS lng,
       (SELECT count(DISTINCT every_visit.day) FROM visits every_visit) AS total_days
  FROM visits
 GROUP BY visits.lat_cell, visits.lng_cell
 ORDER BY days DESC, nights DESC, visits.lat_cell, visits.lng_cell
 LIMIT $8::int
`;

/** One grid cell of measured presence. */
interface PresenceCell {
  /** {@link gridCellKey} of the cell. */
  key: string;
  days: number;
  nights: number;
  lat: number;
  lng: number;
}

interface MeasuredPresence {
  cells: PresenceCell[];
  /** Distinct local days with any usable fix in the window, whatever the cell. */
  totalDays: number;
}

/** A candidate together with the cluster it came from, so kinds are read off the right one. */
interface RankedCandidate {
  cluster: Cluster;
  candidate: KnownPlaceCandidate;
}

/** What a candidate is ranked by: supporting events plus measured presence days. */
function candidateSupport(candidate: KnownPlaceCandidate): number {
  return candidate.eventCount + candidate.presenceDays;
}

function newCluster(locationId: string | null): Cluster {
  return {
    locationId,
    labelCounts: new Map(),
    latSum: 0,
    lngSum: 0,
    eventCount: 0,
    samples: [],
    nightCount: 0,
    workHoursCount: 0,
    presenceDays: 0,
    presenceNights: 0,
    presenceLat: Number.NaN,
    presenceLng: Number.NaN,
  };
}

/**
 * Known places: derives Home / Work and per-person common locations from the
 * event stream and from measured presence in `ci.position` (see
 * {@link KnownPlacesService.readMeasuredPresence}), and persists user-confirmed
 * roles as graph relationships on the
 * EXISTING place shapes — there is no `known_place_labels` table. A confirmed
 * known place is just a `LIVES_IN` / `WORKS_AT` / `VISITED` relationship from the
 * user's self node to a `ci.entities` Location node, with `strength` as the
 * confidence, `start_date`/`end_date` as the era, and `properties` for the rest.
 *
 * Building is read-only and idempotent (pure aggregation over events with
 * coordinates). Confirmation (updateKnownPlace) upserts the relationship in
 * place on the existing partial-unique index, so re-confirming never duplicates.
 */
@Injectable()
export class KnownPlacesService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
    private readonly placeService: PlaceService,
    /**
     * For {@link SELF_ENTITY_PROVISIONER}, resolved lazily — see its doc for
     * why it cannot be injected. Optional so a hand-built service (the unit
     * specs) still constructs; without it a user who has no self entity gets
     * the old error rather than a new one.
     */
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {
    this.logger.setContext(KnownPlacesService.name);
  }

  /**
   * Frequency + coarse coordinate-cluster pass over the user's geolocated
   * events and measured GPS presence ({@link readMeasuredPresence}). Returns
   * the user's most-common places as Home/Work/other candidates,
   * ranked by support. Pure read — surfaces confirmable insights; persistence
   * happens in {@link updateKnownPlace}.
   */
  async buildKnownPlaces(context: UserServiceContext): Promise<KnownPlaceCandidate[]> {
    const rows: Array<{
      event_id: string | null;
      title: string | null;
      location_entity_id: string | null;
      location_name: string | null;
      lat: number;
      lng: number;
      start_time: Date;
      timezone: string | null;
    }> = await this.dataSource.query(
      `SELECT
         event.event_id            AS event_id,
         -- The title lives on the CTI base row (ci.entities.name), not ci.events.
         entity.name               AS title,
         event.location_entity_id  AS location_entity_id,
         event.location_name       AS location_name,
         ST_Y(event.location_coordinates::geometry) AS lat,
         ST_X(event.location_coordinates::geometry) AS lng,
         event.start_time          AS start_time,
         (SELECT u.timezone FROM ci.users u WHERE u.id = $1) AS timezone
       FROM ci.events event
       LEFT JOIN ci.entities entity
         ON entity.entity_id = event.event_id
        AND entity.entity_type = 'Event'
       WHERE event.user_id = $1
         AND event.location_coordinates IS NOT NULL`,
      [context.userId],
    );

    // Night/work-hours buckets are judged on the user's wall clock, not UTC:
    // a Los Angeles user's 22:00 is 05:00/06:00 UTC, which would otherwise
    // land half their evenings outside the "night" window and shift weekday
    // office hours by a full working day's worth of offset. Presence days and
    // nights are cut on the same clock.
    const timezone = await this.userTimezone(context, rows[0]);
    const presence = await this.readMeasuredPresence(context, timezone);

    if (rows.length === 0 && presence.cells.length === 0) {
      return [];
    }

    const clusters = new Map<string, Cluster>();

    for (const row of rows) {
      const lat = Number(row.lat);
      const lng = Number(row.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        continue;
      }

      // Cluster key: the Location node when present, else a snapped coord grid
      // cell so nearby unlinked events still aggregate.
      const key = row.location_entity_id ?? gridCellKey(lat, lng);

      let cluster = clusters.get(key);
      if (!cluster) {
        cluster = newCluster(row.location_entity_id);
        clusters.set(key, cluster);
      }

      cluster.latSum += lat;
      cluster.lngSum += lng;
      cluster.eventCount += 1;
      rememberSampleEvent(cluster, row);

      const name = row.location_name?.trim();
      if (name) {
        cluster.labelCounts.set(name, (cluster.labelCounts.get(name) ?? 0) + 1);
      }

      const { hour, dow: day } = hourDowInTz(new Date(row.start_time), timezone); // day: 0 = Sunday
      if (hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR) {
        cluster.nightCount += 1;
      }

      if (day >= 1 && day <= 5 && hour >= 9 && hour < 17) {
        cluster.workHoursCount += 1;
      }
    }

    // Measured presence joins the grid cluster of its cell: the one the cell's
    // unlinked events built above, or a new one when none fell there. It never
    // joins a Location-anchored cluster. Presence says the user was somewhere in
    // a ~1 km cell, not which of the places in it they were at. On the reference
    // corpus the biggest cluster in the home cell was a Location named for a
    // foreign airport: 12 calendar events the location estimator had pinned
    // there. Joining the biggest cluster would have made that Home.
    for (const cell of presence.cells) {
      let cluster = clusters.get(cell.key);
      if (!cluster) {
        cluster = newCluster(null);
        clusters.set(cell.key, cluster);
      }

      cluster.presenceDays = cell.days;
      cluster.presenceNights = cell.nights;
      cluster.presenceLat = cell.lat;
      cluster.presenceLng = cell.lng;
    }

    const entries: RankedCandidate[] = [...clusters.values()].map((cluster) => ({
      cluster,
      candidate: this.clusterToCandidate(cluster, { events: rows.length, presenceDays: presence.totalDays }),
    }));

    // Ranked by support, events plus presence days. With no ci.position rows
    // this is the event-count ranking it always was.
    const ranked = [...entries].sort((a, b) => candidateSupport(b.candidate) - candidateSupport(a.candidate));

    // The pool the event night/work shares are read over: the top clusters by
    // event count, which is what the candidate list itself was before
    // presence. Presence reorders the list; it must not change what these
    // rules see.
    const eventPool = entries
      .filter((entry) => entry.cluster.eventCount > 0)
      .sort((a, b) => b.cluster.eventCount - a.cluster.eventCount)
      .slice(0, MAX_CANDIDATES);

    // Mark the Home and Work candidates, so the two surface as the confirmable
    // Home/Work insights, and keep them in the list whatever their rank.
    const { home, work } = this.pickPrimaryKinds(eventPool, ranked);
    if (home) {
      home.candidate.kind = 'home';
    }

    if (work) {
      work.candidate.kind = 'work';
    }

    return topWithPinned(ranked, MAX_CANDIDATES, [home, work]).map((entry) => entry.candidate);
  }

  /**
   * The user's confirmed known places: active `LIVES_IN`/`WORKS_AT`/`VISITED`
   * relationships from their self node to Location entities. Optionally filtered
   * by role. Reads only existing shapes (ci.relationships ⋈ ci.entities).
   */
  async getKnownPlaces(context: UserServiceContext, kind?: KnownPlaceKind): Promise<KnownPlace[]> {
    const rows: KnownPlaceRow[] = await this.dataSource.query(
      `SELECT
         r.relationship_id   AS id,
         r.relationship_type AS relationship_type,
         r.strength          AS strength,
         r.start_date        AS start_date,
         r.end_date          AS end_date,
         r.properties        AS properties,
         e.entity_id         AS location_id,
         e.name              AS name
       FROM ci.relationships r
       JOIN ci.users u    ON u.entity_id = r.from_entity_id AND u.id = $1
       JOIN ci.entities e ON e.entity_id = r.to_entity_id AND e.entity_type = 'Location'
       WHERE r.is_active = TRUE
         AND r.relationship_type = ANY($2)
       ORDER BY r.strength DESC NULLS LAST, r.start_date DESC NULLS LAST`,
      [context.userId, KNOWN_PLACE_RELATIONSHIP_TYPES as unknown as string[]],
    );

    const places = rows.map((row) => this.rowToKnownPlace(row));

    return kind ? places.filter((place) => place.kind === kind) : places;
  }

  /**
   * Confirm / update a known place: upsert the role as a graph relationship from
   * the user's self node to an existing Location entity. No bespoke row — the
   * relationship IS the record. Idempotent on the existing partial-unique index
   * `(from_entity_id, to_entity_id, relationship_type) WHERE is_active = TRUE`.
   */
  async updateKnownPlace(
    context: UserServiceContext,
    input: {
      label: string;
      kind: KnownPlaceKind;
      locationId?: string | null;
      coordinates?: { lat: number; lng: number } | null;
      confidence?: number;
      activeFrom?: string;
      activeTo?: string | null;
      aliases?: string[];
      source?: KnownPlaceSource;
    },
  ): Promise<KnownPlace> {
    // A known place is a Location entity. Grid-cluster candidates from
    // knownPlaceCandidates carry no locationId — create the Location from the
    // confirmed label + centroid so every candidate is confirmable (previously
    // they were dead ends).
    let locationId = input.locationId ?? null;
    if (!locationId) {
      const centroid =
        input.coordinates && Number.isFinite(input.coordinates.lat) && Number.isFinite(input.coordinates.lng)
          ? input.coordinates
          : null;

      if (!centroid || !input.label.trim()) {
        throw new Error(
          'updateKnownPlace requires a locationId, or a label plus coordinates to create the Location from.',
        );
      }

      // Reuse an existing known place of the same kind before minting a new
      // Location: re-confirming after an edited label or a drifted cluster
      // centroid must not create a second "Home".
      locationId = await this.findExistingKnownPlaceLocation(context, input.kind);

      if (!locationId) {
        const created = await this.placeService.createKnownPlaceLocation(context, {
          name: input.label.trim(),
          lat: centroid.lat,
          lng: centroid.lng,
        });
        locationId = created.id;
      }
    }

    const relationshipType = relationshipForKind(input.kind);
    const strength = clampStrength(input.confidence ?? 0.5);
    const coordinates =
      input.coordinates && Number.isFinite(input.coordinates.lat) && Number.isFinite(input.coordinates.lng)
        ? input.coordinates
        : null;

    // Everything the old table carried that isn't a first-class relationship
    // column rides in properties: the user's label, the role nuance (for
    // VISITED), provenance, aliases, and the confirmed coordinates ([lng,lat]).
    const properties: Record<string, unknown> = {
      kind: input.kind,
      label: input.label,
      source: input.source ?? 'manual',
      ...(input.aliases && input.aliases.length > 0 ? { aliases: input.aliases } : {}),
      ...(coordinates ? { coordinates: [coordinates.lng, coordinates.lat] } : {}),
    };

    const relationshipId = await this.upsertSelfRelationship(context, locationId, relationshipType, {
      strength,
      startDate: input.activeFrom ?? null,
      endDate: input.activeTo ?? null,
      properties,
    });

    const place = await this.getKnownPlaceById(context, relationshipId);
    if (!place) {
      throw new Error(`Known-place relationship ${relationshipId} vanished after upsert`);
    }

    return place;
  }

  /**
   * The Location already confirmed for this kind, when the kind is
   * single-valued (home / work). Re-confirming such a kind must re-point the
   * SAME known place rather than creating a sibling Location + a second active
   * relationship, which is what an edited label or a drifted cluster centroid
   * would otherwise produce.
   */
  private async findExistingKnownPlaceLocation(
    context: UserServiceContext,
    kind: KnownPlaceKind,
  ): Promise<string | null> {
    if (kind !== 'home' && kind !== 'work') {
      return null;
    }

    const relationshipType = relationshipForKind(kind);

    const rows: Array<{ to_entity_id: string }> = await this.dataSource.query(
      `SELECT r.to_entity_id
         FROM ci.relationships r
         JOIN ci.users u ON u.entity_id = r.from_entity_id
        WHERE u.id = $1
          AND r.owner_user_id = $1
          AND r.relationship_type = $2
          AND r.is_active = TRUE
        ORDER BY r.updated_at DESC
        LIMIT 1`,
      [context.userId, relationshipType],
    );

    return rows[0]?.to_entity_id ?? null;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * The user's IANA timezone, UTC when unset or unknown. The event read carries
   * it on every row; a user with no located events costs one lookup.
   */
  private async userTimezone(
    context: UserServiceContext,
    eventRow: { timezone: string | null } | undefined,
  ): Promise<string> {
    let stored = eventRow?.timezone ?? null;
    if (!eventRow) {
      const rows: Array<{ timezone: string | null }> = await this.dataSource.query(
        `SELECT timezone FROM ci.users WHERE id = $1`,
        [context.userId],
      );
      stored = rows[0]?.timezone ?? null;
    }

    const timezone = stored?.trim();

    return timezone && isValidTimezone(timezone) ? timezone : 'UTC';
  }

  /**
   * Measured presence: where `ci.position` puts the user, as distinct local
   * days and nights per grid cell, never as raw fixes. A GPS track samples
   * every few seconds, so one walk leaves hundreds of fixes in every cell it
   * crosses. Counted in days, that walk is one day in each cell, and a place
   * the user is at on 172 separate days is 172. The cells are the ones the
   * unlinked events cluster on ({@link gridCellKey}). A night is 21:00–06:00 on
   * the user's clock, the window the event pass uses.
   *
   * Measured on the reference corpus: 63,043 fixes, 62,832 of them Google Fit
   * tracks, on 555 local days between 2013 and 2026. The cell holding the
   * user's Google Maps "Home" has 172 days and 12 nights; the next cell by days
   * has 37. Before this read, that evidence reached Known places only as
   * temporal estimates copied onto other events, and without them the cell had
   * 2 events.
   *
   * Cost: `ci.position` is a compressed hypertable, and nothing indexes a
   * cell, so this is a scan of the user's fixes. It is bounded by the
   * {@link PRESENCE_MAX_FIXES} newest usable ones: `ORDER BY time DESC` under a
   * LIMIT lets TimescaleDB visit chunks newest first and stop (a 5,000 cap
   * visits 19 of the reference's 46 chunks). Time is linear in the fixes read:
   * on a synthetic one-fix-per-5-seconds user, 100k took 0.5 s, 200k 1.0–1.2 s
   * and all 691k 4.2 s, on a machine at load ~115. The aggregation runs in SQL,
   * so at most {@link PRESENCE_MAX_CELLS} rows come back.
   *
   * The cap counts fixes, not days, so a dense logger gets less history: at one
   * fix per 5 seconds it is about 12 days. That is still 12 nights at home for
   * a continuous logger. The whole reference history is under a third of it.
   */
  private async readMeasuredPresence(
    context: UserServiceContext,
    timezone: string,
  ): Promise<MeasuredPresence> {
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(KNOWN_PLACE_PRESENCE_SQL, [
      context.userId,
      timezone,
      PRESENCE_MAX_ACCURACY_M,
      PRESENCE_MAX_FIXES,
      CELL_SCALE,
      NIGHT_START_HOUR,
      NIGHT_END_HOUR,
      PRESENCE_MAX_CELLS,
    ]);

    // Number(null) is 0, a real cell; a missing value must not become one.
    const numberOrNaN = (value: unknown): number =>
      value === null || value === undefined ? NaN : Number(value);

    const cells: PresenceCell[] = [];
    for (const row of rows) {
      const latCell = numberOrNaN(row.lat_cell);
      const lngCell = numberOrNaN(row.lng_cell);
      const days = numberOrNaN(row.days);
      const nights = numberOrNaN(row.nights);
      const lat = numberOrNaN(row.lat);
      const lng = numberOrNaN(row.lng);
      if (![latCell, lngCell, days, nights, lat, lng].every(Number.isFinite) || days <= 0) {
        continue;
      }

      cells.push({ key: cellKey(latCell, lngCell), days, nights, lat, lng });
    }

    const totalDays = numberOrNaN(rows[0]?.total_days);

    return { cells, totalDays: cells.length > 0 && Number.isFinite(totalDays) ? totalDays : 0 };
  }

  private selfEntityProvisioner(): SelfEntityProvisioner | null {
    try {
      return this.moduleRef?.get<SelfEntityProvisioner>(SELF_ENTITY_PROVISIONER, { strict: false }) ?? null;
    } catch {
      // No binding (a container without GraphModule): fall through to the
      // "no self entity" error, which names the actual problem.
      return null;
    }
  }

  private rowToKnownPlace(row: KnownPlaceRow): KnownPlace {
    const props = row.properties ?? {};
    const coordsRaw = props.coordinates;
    const coordinates =
      Array.isArray(coordsRaw) && coordsRaw.length === 2
        ? { lng: Number(coordsRaw[0]), lat: Number(coordsRaw[1]) }
        : null;
    const source =
      props.source === 'inferred' || props.source === 'geocoded'
        ? (props.source as KnownPlaceSource)
        : 'manual';

    return {
      id: row.id,
      locationId: row.location_id,
      label: row.name ?? (typeof props.label === 'string' ? props.label : 'Unknown place'),
      kind: kindForRelationship(row.relationship_type, props.kind),
      coordinates,
      confidence: Number(row.strength ?? 0),
      activeFrom: row.start_date === null ? null : String(row.start_date),
      activeTo: row.end_date === null ? null : String(row.end_date),
      aliases: Array.isArray(props.aliases) ? (props.aliases as string[]) : [],
      source,
    };
  }

  private async getKnownPlaceById(
    context: UserServiceContext,
    relationshipId: string,
  ): Promise<KnownPlace | null> {
    const rows: KnownPlaceRow[] = await this.dataSource.query(
      `SELECT
         r.relationship_id AS id, r.relationship_type AS relationship_type, r.strength AS strength,
         r.start_date AS start_date, r.end_date AS end_date, r.properties AS properties,
         e.entity_id AS location_id, e.name AS name
       FROM ci.relationships r
       JOIN ci.users u    ON u.entity_id = r.from_entity_id AND u.id = $1
       JOIN ci.entities e ON e.entity_id = r.to_entity_id AND e.entity_type = 'Location'
       WHERE r.relationship_id = $2`,
      [context.userId, relationshipId],
    );

    return rows[0] ? this.rowToKnownPlace(rows[0]) : null;
  }

  /**
   * Upsert a relationship from the user's self node to the Location node, keyed
   * on the existing partial-unique index. Returns the relationship_id.
   */
  private async upsertSelfRelationship(
    context: UserServiceContext,
    locationId: string,
    relationshipType: KnownPlaceRelationship,
    opts: {
      strength: number;
      startDate: string | null;
      endDate: string | null;
      properties: Record<string, unknown>;
    },
  ): Promise<string> {
    const userId = context.userId;
    const selfRows: Array<{ entity_id: string | null }> = await this.dataSource.query(
      `SELECT entity_id FROM ci.users WHERE id = $1`,
      [userId],
    );
    // `ci.users.entity_id` stays NULL until something self-anchored is
    // ingested, and nothing guarantees that ever happens: after a full
    // 13-source import of the reference corpus it was still NULL, so every
    // Confirm on the Places page — and the daily "is this home?" answer, which
    // lands here too — failed. Provision the self entity the way graph ingest
    // does rather than refusing.
    const selfEntityId =
      selfRows[0]?.entity_id ?? (await this.selfEntityProvisioner()?.ensureSelfEntityForOwner(context))?.id;
    if (!selfEntityId) {
      throw new Error('Cannot write known-place relationship: user has no self entity');
    }

    // The dedup guard is the partial unique index
    //   relationships_unique_directed_idx (from_entity_id, to_entity_id,
    //   relationship_type) WHERE is_active = TRUE
    // so the ON CONFLICT target names those columns AND repeats the partial
    // predicate to bind to that index.
    const rows: Array<{ relationship_id: string }> = await this.dataSource.query(
      `INSERT INTO ci.relationships
         (relationship_id, from_entity_id, to_entity_id, relationship_type, strength,
          properties, is_active, start_date, end_date, owner_user_id,
          from_entity_type, to_entity_type)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, true, $7, $8, $9, 'User', 'Location')
       ON CONFLICT (from_entity_id, to_entity_id, relationship_type) WHERE is_active = TRUE
       DO UPDATE SET
         strength      = EXCLUDED.strength,
         properties    = EXCLUDED.properties,
         start_date    = EXCLUDED.start_date,
         end_date      = EXCLUDED.end_date,
         owner_user_id = EXCLUDED.owner_user_id,
         updated_at    = now()
       RETURNING relationship_id`,
      [
        uuidv7(),
        selfEntityId,
        locationId,
        relationshipType,
        opts.strength,
        JSON.stringify(opts.properties),
        opts.startDate,
        opts.endDate,
        userId,
      ],
    );

    return rows[0].relationship_id;
  }

  private clusterToCandidate(
    cluster: Cluster,
    totals: { events: number; presenceDays: number },
  ): KnownPlaceCandidate {
    const label = [...cluster.labelCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Unknown place';

    // Support fraction drives the base confidence; capped so an inferred
    // candidate never reaches the 1.0 ground-truth weight. Events and presence
    // days pool into one fraction, which without presence is the events-only
    // fraction it always was.
    const support =
      (cluster.eventCount + cluster.presenceDays) / Math.max(totals.events + totals.presenceDays, 1);
    const confidence = Math.min(0.4 + support, 0.9);
    // A cluster with presence but no events sits where the user's fixes do.
    const hasEvents = cluster.eventCount > 0;

    return {
      locationId: cluster.locationId,
      label,
      kind: 'other',
      lat: hasEvents ? cluster.latSum / cluster.eventCount : cluster.presenceLat,
      lng: hasEvents ? cluster.lngSum / cluster.eventCount : cluster.presenceLng,
      eventCount: cluster.eventCount,
      sampleEvents: cluster.samples,
      confidence: Number(confidence.toFixed(3)),
      presenceDays: cluster.presenceDays,
      presenceNights: cluster.presenceNights,
    };
  }

  /**
   * Pick the Home and Work candidates.
   *
   * Measured presence picks Home whenever some cluster has at least
   * {@link PRESENCE_HOME_MIN_DAYS} days and {@link PRESENCE_HOME_MIN_NIGHTS}
   * nights of it: the one with the most presence days, then nights.
   *
   * Days rank, and nights only gate, because of what GPS nights turn out to be.
   * On the reference corpus the home cell has 172 days to the runner-up's 37,
   * but only 12 nights to downtown's 10. Google Fit records walks, not sleep:
   * of the 165 nights with any fix, 153 have none at home. The gate still
   * keeps a place the user is only ever at by day from outranking home.
   * The floors keep a short trip from overriding the events: a user whose only
   * GPS is a long weekend away does not get the hotel as Home.
   *
   * Presence does not pick Work. On the same corpus the cell with the most
   * weekday 09:00–17:00 days is home itself (100), and the next is the
   * residential cell beside it (21). Tracks that start and end at home say
   * nothing about an office.
   *
   * The rest is the event rule, unchanged, read over `eventPool`: Home is the
   * highest share of night-time events when presence names none, and Work is
   * the highest share of weekday 9–5 events unless that is Home. Without
   * presence the picks are exactly what they were, and with it Work still is.
   * The pool is why. Ranked by support, the reference corpus pushed its
   * 2-event Work cluster out of the top 50, and the shares over what was left
   * gave Work to a 1-event cell that ranked second on its GPS days.
   */
  private pickPrimaryKinds(
    eventPool: RankedCandidate[],
    ranked: RankedCandidate[],
  ): { home: RankedCandidate | null; work: RankedCandidate | null } {
    let nightPick: RankedCandidate | null = null;
    let workPick: RankedCandidate | null = null;
    let bestNight = 0;
    let bestWork = 0;

    for (const entry of eventPool) {
      const nightShare = entry.cluster.nightCount / entry.cluster.eventCount;
      const workShare = entry.cluster.workHoursCount / entry.cluster.eventCount;

      if (nightShare > bestNight) {
        bestNight = nightShare;
        nightPick = entry;
      }

      if (workShare > bestWork) {
        bestWork = workShare;
        workPick = entry;
      }
    }

    const home = pickPresenceHome(ranked) ?? nightPick;

    return { home, work: workPick === home ? null : workPick };
  }
}

/**
 * The cluster measured presence names Home: over both floors, most presence
 * days, then most nights, then the higher-ranked. Null when none clears the
 * floors. See {@link KnownPlacesService.pickPrimaryKinds}.
 */
function pickPresenceHome(ranked: RankedCandidate[]): RankedCandidate | null {
  let best: RankedCandidate | null = null;

  for (const entry of ranked) {
    const { presenceDays, presenceNights } = entry.candidate;
    if (presenceDays < PRESENCE_HOME_MIN_DAYS || presenceNights < PRESENCE_HOME_MIN_NIGHTS) {
      continue;
    }

    const bestDays = best?.candidate.presenceDays ?? -1;
    const bestNights = best?.candidate.presenceNights ?? -1;
    if (presenceDays > bestDays || (presenceDays === bestDays && presenceNights > bestNights)) {
      best = entry;
    }
  }

  return best;
}

/**
 * The first `limit` of `ranked`, but keeping every pinned entry: one ranked
 * below the cut displaces the lowest-ranked unpinned entry, and the list stays
 * in rank order. Clusters with many events can outrank a Home whose evidence
 * is all GPS, and the event rule's Work need not rank at all once presence
 * days count.
 */
function topWithPinned(
  ranked: RankedCandidate[],
  limit: number,
  pinned: Array<RankedCandidate | null>,
): RankedCandidate[] {
  const keep = new Set(pinned.filter((entry): entry is RankedCandidate => entry !== null));
  const top = ranked.filter((entry, index) => index < limit || keep.has(entry));

  for (let index = top.length - 1; top.length > limit && index >= 0; index--) {
    if (!keep.has(top[index])) {
      top.splice(index, 1);
    }
  }

  return top;
}

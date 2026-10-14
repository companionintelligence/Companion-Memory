import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, Point, In } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { SYSTEM_USER, UserServiceContext, type ServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { DeviceService } from '@ci/domains/devices';
import { EventService } from '@ci/domains/events';
import {
  PositionCreatedEvent,
  PositionUpdatedEvent,
  PositionRemovedEvent,
} from '@ci/domains/position/events';

import { PositionEntity, LocationSource } from '../entities/PositionEntity';
import type {
  CreatePositionDto,
  Position,
  Geofence,
  GeofenceRadius,
  GeofencePolygon,
  UpdatePositionDto,
} from '../types';

import {
  clampMaxPoints,
  clampPageSize,
  decodeTrackCursor,
  encodeTrackCursor,
  normalizeBbox,
  resolveBucketSeconds,
  type TrackBbox,
} from './positionTrack';

/**
 * One point on the map's location trace.
 *
 * Deliberately NOT a {@link Position}: a trace draws tens of thousands of these
 * at once and needs a coordinate, an instant and a weight — not the fix's
 * device, dilution-of-precision pair, relative orientation or reverse-geocoded
 * address. When the read is downsampled a point stands for a whole time bucket,
 * which is what `fixCount` and the `startTime`/`endTime` pair say: the
 * coordinate is the bucket's FIRST real fix, never an average, so every point
 * the map draws is somewhere the user actually was.
 */
export interface TrackPoint {
  /** First fix in the bucket (the fix's own time when the read is raw). */
  startTime: Date;
  /** Last fix in the bucket (equal to `startTime` when the read is raw). */
  endTime: Date;
  latitude: number;
  longitude: number;
  /** Fixes this point stands for — 1 when raw, the bucket's weight when downsampled. */
  fixCount: number;
  activityType: string | null;
  /** Keyset cursor to resume strictly after this point. */
  cursor: string;
}

/** One page of {@link TrackPoint}s plus everything needed to ask for the next. */
/** First fix, last fix, and how many — the whole history at a glance. */
export interface TrackExtent {
  start: Date;
  end: Date;
  count: number;
}

export interface TrackPage {
  points: TrackPoint[];
  hasNextPage: boolean;
  endCursor: string | null;
  /** Bucket width the page was cut with, or null when the points are raw fixes. */
  bucketSeconds: number | null;
  /**
   * Raw fixes matching the filters, ignoring the downsample and the page cap —
   * answered on the FIRST page only (null on continuations, see
   * {@link PositionService.findTrack}).
   */
  totalCount: number | null;
}

/** Filters and paging for {@link PositionService.findTrack}. */
export interface TrackOptions {
  startTime?: Date;
  endTime?: Date;
  /** Viewport as [minLon, minLat, maxLon, maxLat] (EPSG:4326). */
  bbox?: number[];
  first?: number;
  after?: string;
  /** Downsample budget for the whole window; 0 asks for raw fixes. */
  maxPoints?: number;
}

/** Shape of one raw/bucketed row as Postgres hands it back. */
interface TrackRow {
  started_at: Date;
  ended_at: Date;
  latitude: string | number;
  longitude: string | number;
  fix_count: number;
  activity_type: string | null;
}

@Injectable()
export class PositionService {
  constructor(
    @InjectRepository(PositionEntity)
    private readonly positionRepository: Repository<PositionEntity>,
    private readonly deviceService: DeviceService,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PositionService.name);
  }

  /**
   * Aggregate position counts for the location settings UI: total fixes,
   * per-provider counts (the browser tracker writes provider='browser'), and
   * the most recent fix time.
   */
  async getStats(context: UserServiceContext): Promise<{
    total: number;
    byProvider: Record<string, number>;
    lastFixAt: Date | null;
  }> {
    const rows: Array<{ provider: string | null; n: string; last_at: Date | null }> =
      await this.positionRepository.manager.query(
        `SELECT provider, COUNT(*) AS n, MAX(time) AS last_at
           FROM ci.position
          WHERE user_id = $1
          GROUP BY provider`,
        [context.userId],
      );

    const byProvider: Record<string, number> = {};
    let total = 0;
    let lastFixAt: Date | null = null;

    for (const row of rows) {
      const count = Number(row.n);
      total += count;
      byProvider[row.provider ?? 'unknown'] = count;
      if (row.last_at && (lastFixAt == null || row.last_at > lastFixAt)) {
        lastFixAt = row.last_at;
      }
    }

    return { total, byProvider, lastFixAt };
  }

  async create(
    context: UserServiceContext,
    data: CreatePositionDto[],
    options: { emitCreated?: boolean } = {},
  ): Promise<Position[]> {
    this.logger.log('Creating position records', {
      userId: context.userId,
      count: data.length,
    });

    const uniquePositions = this.deduplicateByTime(data);

    if (uniquePositions.length < data.length) {
      this.logger.log('Deduplicated positions', {
        originalCount: data.length,
        uniqueCount: uniquePositions.length,
        duplicatesRemoved: data.length - uniquePositions.length,
      });
    }

    const times = uniquePositions.map((item) => new Date(item.time));
    const existingPositions = await this.findExistingByTimes(context, times);
    const existingTimesSet = new Set(existingPositions.map((p) => p.time.toISOString()));
    const newPositions: CreatePositionDto[] = [];

    for (const item of uniquePositions) {
      const itemTime = new Date(item.time).toISOString();

      if (!existingTimesSet.has(itemTime)) {
        if (item.device_id) {
          const device = await this.deviceService.findById(context, item.device_id);

          if (!device) {
            this.logger.warn('Device not found for position', {
              deviceId: item.device_id,
              userId: context.userId,
            });
          }
        }

        // createPositionEntity() reads item.heading_degrees (snake_case, the
        // DTO's own field), not a headingDegrees key -- normalizing onto the
        // wrong key here was a no-op that let out-of-range headings through
        // to storage unfiltered. Overwrite the field it actually reads.
        const normalizedItem = {
          ...item,
          heading_degrees: this.normalizeHeading(item.heading_degrees),
        };

        newPositions.push(normalizedItem);
      }
    }

    const createdEntities: PositionEntity[] = [];

    if (newPositions.length > 0) {
      const entitiesToSave = newPositions.map((item) => this.createPositionEntity(context, item));
      const saved = await this.positionRepository.save(entitiesToSave);
      // emitCreated:false is the bulk-ingest path (#1672): a GPS-track import is
      // tens of thousands of rows, and a PositionCreatedEvent per row hammers
      // the job queue for listeners that bulk clients drive via
      // POST /v1/ingest/finish anyway (mirrors the emitCreated:false services
      // behind the other /v1 routes).
      if (options.emitCreated !== false) {
        for (const position of saved) {
          await this.eventService.send(PositionCreatedEvent, {
            positionId: position.id,
          });
        }
      }

      createdEntities.push(...saved);
    }

    const allPositions = [...existingPositions, ...createdEntities]
      .sort((a, b) => b.time.getTime() - a.time.getTime())
      .map((entity) => PositionEntity.toEgressType(entity));

    this.logger.log('Successfully processed position records', {
      userId: context.userId,
      totalCount: allPositions.length,
      newCount: createdEntities.length,
      existingCount: existingPositions.length,
    });

    return allPositions;
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(Position | null)[]> {
    const entities = await this.positionRepository.find({
      where: {
        id: In(ids),
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
      },
    });

    const map = new Map(entities.map((entity) => [entity.id, PositionEntity.toEgressType(entity)]));

    return ids.map((id) => map.get(id) ?? null);
  }

  async findById(context: ServiceContext, id: string): Promise<Position | null> {
    const result = await this.positionRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
      },
    });

    if (result == null) {
      return null;
    }

    return PositionEntity.toEgressType(result);
  }

  async update(context: ServiceContext, id: string, data: UpdatePositionDto): Promise<Position | null> {
    const updateData: Partial<PositionEntity> = {};

    if (data.time !== undefined) {
      updateData.time = new Date(data.time);
    }

    if (data.location !== undefined) {
      updateData.location = data.location
        ? {
            type: 'Point' as const,
            coordinates: [data.location.x, data.location.y],
          }
        : null;
    }

    if (data.altitude_meters !== undefined) {
      updateData.altitudeMeters = data.altitude_meters;
    }

    if (data.accuracy_meters !== undefined) {
      updateData.accuracyMeters = data.accuracy_meters;
    }

    if (data.hdop !== undefined) {
      updateData.hdop = data.hdop;
    }

    if (data.vdop !== undefined) {
      updateData.vdop = data.vdop;
    }

    if (data.heading_degrees !== undefined) {
      updateData.headingDegrees = data.heading_degrees;
    }

    if (data.speed_meters_per_second !== undefined) {
      updateData.speedMetersPerSecond = data.speed_meters_per_second;
    }

    if (data.address !== undefined) {
      updateData.address = data.address;
    }

    if (data.city !== undefined) {
      updateData.city = data.city;
    }

    if (data.region !== undefined) {
      updateData.region = data.region;
    }

    if (data.country !== undefined) {
      updateData.country = data.country;
    }

    if (data.postal_code !== undefined) {
      updateData.postalCode = data.postal_code;
    }

    if (data.name !== undefined) {
      updateData.name = data.name;
    }

    if (data.description !== undefined) {
      updateData.description = data.description;
    }

    if (data.provider !== undefined) {
      updateData.provider = data.provider;
    }

    if (data.source !== undefined) {
      updateData.source = data.source;
    }

    if (data.activity_type !== undefined) {
      updateData.activityType = data.activity_type;
    }

    const position = await this.positionRepository.findOne({
      where: {
        id: id,
        ...(context.userId !== SYSTEM_USER && {
          user: { id: context.userId },
        }),
      },
    });

    if (position) {
      Object.assign(position, updateData);
      await this.positionRepository.save(position);
    } else {
      return null;
    }

    await this.eventService.send(PositionUpdatedEvent, {
      positionId: id,
    });

    return this.findById(context, id);
  }

  async remove(context: ServiceContext, id: string): Promise<boolean> {
    const position = await this.positionRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
      },
    });

    if (!position) {
      return false;
    }

    await this.positionRepository.delete({
      id,
      ...(context.userId !== SYSTEM_USER && {
        user: {
          id: context.userId,
        },
      }),
    });

    await this.eventService.send(PositionRemovedEvent, {
      positionId: id,
    });

    return true;
  }

  async findByDateRange(context: ServiceContext, start: Date, end: Date): Promise<Position[]> {
    this.logger.log('Fetching positions for date range', {
      userId: context.userId,
      start: start.toISOString(),
      end: end.toISOString(),
    });

    const results = await this.positionRepository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
        time: Between(start, end),
      },
      order: { time: 'DESC' },
    });

    return results.map((entity) => PositionEntity.toEgressType(entity));
  }

  async findByGeofence(
    context: ServiceContext,
    geofence: Geofence,
    startDate?: Date,
    endDate?: Date,
  ): Promise<Position[]> {
    this.logger.log('Fetching positions within geofence', {
      userId: context.userId,
      geofenceType: 'radius' in geofence ? 'radius' : 'polygon',
      startDate: startDate?.toISOString(),
      endDate: endDate?.toISOString(),
    });

    let whereClause = 'location IS NOT NULL';
    const params: (string | number)[] = [];
    let paramIndex = 1;

    // Only filter by user_id if not system user
    if (context.userId !== SYSTEM_USER) {
      whereClause += ` AND user_id = $${paramIndex}`;
      params.push(context.userId);
      paramIndex++;
    }

    if ('radius_meters' in geofence) {
      const radiusGeofence = geofence as GeofenceRadius;
      whereClause += ` AND ST_DWithin(
        location::geography,
        ST_SetSRID(ST_MakePoint($${paramIndex}, $${paramIndex + 1}), 4326)::geography,
        $${paramIndex + 2}
      )`;
      params.push(
        radiusGeofence.center.longitude,
        radiusGeofence.center.latitude,
        radiusGeofence.radius_meters,
      );
      paramIndex += 3;
    } else {
      const polygonGeofence = geofence as GeofencePolygon;
      if (polygonGeofence.coordinates.length < 3) {
        this.logger.warn('Polygon geofence must have at least 3 coordinates');

        return [];
      }

      const coordinatesStr = polygonGeofence.coordinates
        .map((coord) => `${coord.longitude} ${coord.latitude}`)
        .join(', ');
      const firstCoord = polygonGeofence.coordinates[0];
      const polygonWKT = `POLYGON((${coordinatesStr}, ${firstCoord.longitude} ${firstCoord.latitude}))`;

      // ST_Within has no geography overload, so it raised "function
      // st_within(geography, geography) does not exist". ST_Covers does.
      whereClause += ` AND ST_Covers(
        ST_GeogFromText($${paramIndex}),
        location::geography
      )`;
      params.push(`SRID=4326;${polygonWKT}`);
      paramIndex += 1;
    }

    if (startDate) {
      whereClause += ` AND time >= $${paramIndex}`;
      params.push(startDate.toISOString());
      paramIndex += 1;
    }

    if (endDate) {
      whereClause += ` AND time <= $${paramIndex}`;
      params.push(endDate.toISOString());
    }

    // A raw query hands geography back as hex EWKB, which parseLocation can't
    // read, so the location also comes back as GeoJSON.
    const rawResults = await this.positionRepository.query(
      `SELECT *, ST_AsGeoJSON(location)::json AS location_geojson
         FROM ci.position
        WHERE ${whereClause}
        ORDER BY time DESC`,
      params,
    );

    return this.mapRawResultsToPositions(rawResults);
  }

  /**
   * One page of the user's location history, for the map's trace layer.
   *
   * ── Why this exists ────────────────────────────────────────────────────────
   * The memory map plotted located EVENTS and nothing else. On the QA appliance
   * that is 121 pins — while `ci.position` holds 63,044 real GPS fixes spanning
   * 2013-05-28 → 2026-08-21 that no map query had ever touched. The map looked
   * empty because it was reading the wrong table.
   *
   * ── Why it is shaped like this ─────────────────────────────────────────────
   * Three constraints, and each one picks a piece of the query:
   *
   *   1. A world-zoom request must never ship 63k rows. So the read is
   *      DOWNSAMPLED server-side: the bucket width is the IN-VIEW window's span
   *      — bbox included, not just the caller's date filters — divided by the
   *      point budget, and each bucket collapses to its first real fix plus a
   *      count. That scoping is load-bearing: a bucket sized off the WHOLE
   *      table is the same width at every zoom level, so panning into a city
   *      that only touches three of those thirteen years used to buy nothing —
   *      the trace stayed exactly as coarse as the world view. At world zoom,
   *      thirteen years against a 2,000-point budget is a 2.4-day bucket and
   *      316 points — measured, because only 582 of those 4,833 days carry a
   *      fix — and a city-sized viewport gets its own, usually much finer,
   *      bucket from its own in-view span. Below the point budget the read
   *      skips bucketing altogether and returns raw fixes, one row per point —
   *      which is what makes a fully zoomed-in view show every fix it holds.
   *   2. The client must be able to page through EVERYTHING, so paging is
   *      keyset, not offset: `time > cursor`. `ci.position`'s primary key is
   *      (time, user_id), so for one user `time` is unique — a single-column
   *      cursor is exact, no tie-break column needed. In bucketed mode the
   *      cursor is the bucket's MAX(time), which is strictly past every row the
   *      page consumed and strictly before every row it did not.
   *   3. It has to be fast on a hypertable. Every predicate here is chosen to
   *      land on an existing index: user + time on `position_user_id_time_idx`
   *      (user_id, time DESC), the viewport on `position_location_idx` (GiST on
   *      the geography, partial `WHERE location IS NOT NULL` — which is why the
   *      IS NOT NULL clause is spelled out rather than implied). Measured on the
   *      live 63k-row table: 29ms for the whole thirteen-year bucketed read,
   *      107ms with a city-sized viewport box.
   *
   * Always user-scoped, structurally: the context type is
   * {@link UserServiceContext}, so unlike the other reads on this service there
   * is no SYSTEM_USER branch that could union every user's whereabouts. A trace
   * is the single most sensitive projection of this table and nothing on the
   * appliance has a legitimate reason to read one across users.
   */
  async findTrack(context: UserServiceContext, options: TrackOptions = {}): Promise<TrackPage> {
    const cursor = decodeTrackCursor(options.after);
    const pageSize = clampPageSize(options.first);
    const boxes = normalizeBbox(options.bbox);
    const maxPoints = clampMaxPoints(options.maxPoints);

    // A continuation INHERITS its bucket from the cursor instead of deriving it
    // again: the derivation depends on the window's span, and on an appliance
    // that is still ingesting, `max(time)` moves between pages. Re-deriving
    // would cut later pages on different boundaries and either duplicate or
    // skip a slice of the trace. It also saves the span round trip.
    //
    // A first page instead starts by finding out what is actually IN the
    // requested window — bbox included. That single count answers two
    // questions at once: it IS the "N of totalFixes" the page hands back
    // below, and it decides whether the read can stay raw (fewer fixes in
    // view than the point budget — the case a fully zoomed-in street-level
    // view must hit) or needs bucketing, in which case the bucket is sized off
    // the SAME in-view window rather than the whole table. Reusing the one
    // count for both means a raw first page (the common case once zoomed in)
    // costs exactly one query, not the two it used to.
    let inViewCount: number | null = null;
    let bucketSeconds: number | null;

    if (cursor != null) {
      bucketSeconds = cursor.bucketSeconds;
    } else {
      inViewCount = await this.countTrackPoints(context, options);
      bucketSeconds =
        maxPoints <= 0 || inViewCount <= maxPoints
          ? null
          : resolveBucketSeconds(await this.resolveTrackSpanMs(context, options, boxes), maxPoints);
    }

    const where = this.buildTrackWhere(context, options, boxes, cursor?.time);
    const params = [...where.params];
    // Appended, not reserved: Postgres rejects a bind that supplies more
    // parameters than the statement mentions, so the raw query and the count —
    // which have no bucket — must not carry a slot for one.
    const bucketPlaceholder = bucketSeconds == null ? '' : `$${params.push(bucketSeconds)}`;
    // Over-fetch by one so `hasNextPage` is a fact rather than a guess ("we
    // returned a full page, so there is probably more").
    const limitPlaceholder = `$${params.push(pageSize + 1)}`;

    const sql =
      bucketSeconds == null
        ? `SELECT p.time AS started_at,
                  p.time AS ended_at,
                  1 AS fix_count,
                  ST_Y(p.location::geometry) AS latitude,
                  ST_X(p.location::geometry) AS longitude,
                  p.activity_type
             FROM ci.position p
            WHERE ${where.sql}
            ORDER BY p.time
            LIMIT ${limitPlaceholder}`
        : // GROUP BY the alias (Postgres resolves output names in GROUP BY /
          // ORDER BY), and order by the bucket so the page is chronological —
          // which is what makes `time > cursor` a valid continuation.
          `SELECT time_bucket(make_interval(secs => ${bucketPlaceholder}), p.time) AS bucket_start,
                  min(p.time) AS started_at,
                  max(p.time) AS ended_at,
                  count(*)::int AS fix_count,
                  first(ST_Y(p.location::geometry), p.time) AS latitude,
                  first(ST_X(p.location::geometry), p.time) AS longitude,
                  first(p.activity_type, p.time) AS activity_type
             FROM ci.position p
            WHERE ${where.sql}
            GROUP BY bucket_start
            ORDER BY bucket_start
            LIMIT ${limitPlaceholder}`;

    const rows: TrackRow[] = await this.positionRepository.manager.query(sql, params);
    const hasNextPage = rows.length > pageSize;
    const points = (hasNextPage ? rows.slice(0, pageSize) : rows).map((row) => ({
      startTime: row.started_at,
      endTime: row.ended_at,
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      fixCount: Number(row.fix_count),
      activityType: row.activity_type,
      // The cursor is the LAST instant this point consumed, so resuming at
      // `time > cursor` can neither re-emit nor skip a fix.
      cursor: encodeTrackCursor(row.ended_at, bucketSeconds),
    }));

    return {
      points,
      hasNextPage,
      endCursor: points.length > 0 ? points[points.length - 1].cursor : null,
      bucketSeconds,
      // Counted once per walk, on the first page — reusing the SAME count that
      // decided raw-vs-bucketed above, not a second scan of the same rows. The
      // answer cannot change between pages of one walk, so a continuation
      // leaves this null rather than paying for it again.
      totalCount: inViewCount,
    };
  }

  /**
   * Raw fixes matching a track read's filters, ignoring the downsample and the
   * page cap — so the UI can say "316 of 63,044 fixes" rather than presenting a
   * sampled trace as the whole history. `findTrack` also reuses this same
   * count, on the first page, to decide whether the read can stay raw at all.
   */
  async countTrackPoints(context: UserServiceContext, options: TrackOptions = {}): Promise<number> {
    const where = this.buildTrackWhere(context, options, normalizeBbox(options.bbox));

    const rows: Array<{ n: string }> = await this.positionRepository.manager.query(
      `SELECT count(*) AS n FROM ci.position p WHERE ${where.sql}`,
      where.params,
    );

    return Number(rows[0]?.n ?? 0);
  }

  /**
   * The user's whole location history at a glance — first fix, last fix,
   * total count — WITHOUT paging through it.
   *
   * Exists for a caller that needs to span a control by the user's real
   * history before it has downloaded any of it (a playback scrubber, for
   * instance): asking `findTrack` for that would mean reading a full page
   * just to throw away everything but its two end timestamps. This is the
   * same one-row min/max/count `resolveTrackSpanMs` already runs to size a
   * bucket, generalized to answer on its own rather than only as that
   * method's internal step, and it is deliberately UNSCOPED by bbox by
   * default — same reasoning as `countTrackPoints`'s docstring: a scrubber
   * spanning "what's in the current viewport" would shrink every time the
   * user pans, which is not what a control meant to represent the whole
   * history should do. A caller that DOES want the in-viewport extent can
   * still pass a bbox; nothing here assumes one way or the other.
   */
  async getTrackExtent(context: UserServiceContext, options: TrackOptions = {}): Promise<TrackExtent | null> {
    const boxes = normalizeBbox(options.bbox);
    const where = this.buildTrackWhere(context, options, boxes);

    const rows: Array<{ n: string; from_time: Date | null; to_time: Date | null }> =
      await this.positionRepository.manager.query(
        `SELECT count(*) AS n, min(time) AS from_time, max(time) AS to_time
           FROM ci.position p
          WHERE ${where.sql}`,
        where.params,
      );

    const count = Number(rows[0]?.n ?? 0);
    const from = rows[0]?.from_time;
    const to = rows[0]?.to_time;

    if (count === 0 || from == null || to == null) {
      return null;
    }

    return { start: from, end: to, count };
  }

  /**
   * The span the downsample budget is divided by — of the window actually IN
   * VIEW, bbox included, not the whole table.
   *
   * When the caller bounded the window (the explorer's date filters), that IS
   * the span — no query needed. Otherwise it is the min/max time among fixes
   * matching every filter the page itself uses (`buildTrackWhere`, bbox
   * included), so it lands on the SAME index the page and the count already
   * pay for — `position_location_idx`'s GiST scan when there is a viewport,
   * `position_user_id_time_idx` when there is not — rather than a second,
   * differently-shaped one.
   *
   * Narrowing by the viewport is the fix for the bug this method used to have:
   * sizing the bucket off the WHOLE table makes it the same width at every
   * zoom level, so panning into a city that only touches three of the table's
   * thirteen years bought nothing — the trace stayed exactly as coarse as the
   * world view no matter how far in you zoomed. `findTrack` only calls this
   * once it already knows (from {@link countTrackPoints}) that the in-view fix
   * count exceeds the point budget, so this is never the wasted round trip a
   * window small enough to serve raw would otherwise pay.
   */
  private async resolveTrackSpanMs(
    context: UserServiceContext,
    options: TrackOptions,
    boxes: TrackBbox[],
  ): Promise<number> {
    // The date range IS the span of interest only when nothing else narrows
    // the row set further. A bbox can — a user's whole date-filtered range
    // might cover a month, but the fixes actually inside the viewport's box
    // could span three days of it. Take the shortcut ONLY when there is no
    // bbox: with one, the min/max query below is what finds the true in-view
    // span, which is what makes zooming into a bbox sharpen the bucket width
    // even while an explorer date filter is also active. Previously this
    // short-circuited on startTime+endTime alone, so a bbox was silently
    // ignored whenever a date filter was set — bucket width stayed pinned to
    // the filtered range's raw width regardless of how tightly the viewport
    // narrowed the actual fixes inside it.
    if (options.startTime && options.endTime && boxes.length === 0) {
      return options.endTime.getTime() - options.startTime.getTime();
    }

    const where = this.buildTrackWhere(context, options, boxes);
    const rows: Array<{ from_time: Date | null; to_time: Date | null }> =
      await this.positionRepository.manager.query(
        `SELECT min(time) AS from_time, max(time) AS to_time FROM ci.position p WHERE ${where.sql}`,
        where.params,
      );
    const from = rows[0]?.from_time;
    const to = rows[0]?.to_time;

    return from != null && to != null ? to.getTime() - from.getTime() : 0;
  }

  /**
   * The WHERE shared by the page read and its count, so a truncated page and
   * the total it is truncated against always describe the same set of fixes.
   *
   * Callers append their own trailing parameters (bucket width, LIMIT) to the
   * returned array — nothing here reserves a slot, because Postgres rejects a
   * bind that supplies a parameter the statement never mentions.
   */
  private buildTrackWhere(
    context: UserServiceContext,
    options: TrackOptions,
    boxes: TrackBbox[],
    after?: Date,
  ): { sql: string; params: unknown[] } {
    const params: unknown[] = [context.userId];
    const clauses = [
      'p.user_id = $1',
      // Spelled out rather than implied by the bbox predicate: it matches
      // position_location_idx's own `WHERE location IS NOT NULL`, and a fix with
      // no point has nothing to draw even when no viewport is supplied.
      'p.location IS NOT NULL',
    ];

    if (options.startTime) {
      params.push(options.startTime);
      clauses.push(`p.time >= $${params.length}`);
    }

    if (options.endTime) {
      params.push(options.endTime);
      clauses.push(`p.time < $${params.length}`);
    }

    if (after) {
      clauses.push(`p.time > $${params.push(after)}`);
    }

    if (boxes.length > 0) {
      // OR of one or two envelopes — two when the viewport straddles the
      // antimeridian (see normalizeBbox). `&&` is bounding-box overlap on the
      // geography, which is exactly what the GiST index answers.
      const envelopes = boxes.map(([minLon, minLat, maxLon, maxLat]) => {
        const base = params.push(minLon, minLat, maxLon, maxLat) - 3;

        return `p.location && ST_MakeEnvelope($${base}, $${base + 1}, $${base + 2}, $${base + 3}, 4326)::geography`;
      });

      clauses.push(`(${envelopes.join(' OR ')})`);
    }

    return { sql: clauses.join(' AND '), params };
  }

  private createPositionEntity(context: UserServiceContext, item: CreatePositionDto): PositionEntity {
    const location = item.location
      ? {
          type: 'Point' as const,
          coordinates: [item.location.x, item.location.y],
        }
      : null;

    return this.positionRepository.create({
      id: uuidv7(),
      time: new Date(item.time),
      userId: context.userId,
      deviceId: item.device_id ?? null,
      location,
      altitudeMeters: item.altitude_meters ?? null,
      accuracyMeters: item.accuracy_meters ?? null,
      hdop: item.hdop ?? null,
      vdop: item.vdop ?? null,
      headingDegrees: item.heading_degrees ?? null,
      speedMetersPerSecond: item.speed_meters_per_second ?? null,
      address: item.address ?? null,
      city: item.city ?? null,
      region: item.region ?? null,
      country: item.country ?? null,
      postalCode: item.postal_code ?? null,
      name: item.name ?? null,
      description: item.description ?? null,
      provider: item.provider ?? null,
      source: item.source,
      activityType: item.activity_type ?? null,
      locationEntityId: item.location_entity_id ?? null,
      referenceEntityId: item.reference_entity_id ?? null,
      relativeCoordinates: item.relative_coordinates ?? {},
      relativeOrientation: item.relative_orientation ?? {},
      sourceType: item.source_type ?? null,
      sourceSystem: item.source_system ?? null,
      sourceId: item.source_id ?? null,
    });
  }

  private async findExistingByTimes(context: UserServiceContext, times: Date[]): Promise<PositionEntity[]> {
    if (times.length === 0) {
      return [];
    }

    return this.positionRepository.find({
      where: {
        userId: context.userId,
        time: In(times),
      },
    });
  }

  private deduplicateByTime(positions: CreatePositionDto[]): CreatePositionDto[] {
    // Key on the parsed instant, not the raw string: two rows for the same
    // moment written with different timestamp formatting (with/without
    // milliseconds, `Z` vs `+00:00`, ...) must collapse to one row here, or
    // both survive into findExistingByTimes and get inserted as duplicates.
    const seenTimes = new Map<number, CreatePositionDto>();
    for (const position of positions) {
      seenTimes.set(new Date(position.time).getTime(), position);
    }

    return Array.from(seenTimes.values());
  }

  private normalizeHeading(heading?: number): number | undefined {
    if (heading === undefined || heading < 0 || heading > 360) {
      return undefined;
    }

    return heading;
  }

  private mapRawResultsToPositions(rawResults: Array<Record<string, unknown>>): Position[] {
    return rawResults.map((row) => {
      const entity = new PositionEntity();
      entity.id = row.id as string;
      entity.time = new Date(row.time as string);
      entity.userId = row.user_id as string;
      entity.deviceId = row.device_id as string | null;
      entity.location = this.parseLocation(row.location_geojson ?? row.location);
      entity.altitudeMeters = row.altitude_meters as number | null;
      entity.accuracyMeters = row.accuracy_meters as number | null;
      entity.hdop = row.hdop as number | null;
      entity.vdop = row.vdop as number | null;
      entity.headingDegrees = row.heading_degrees as number | null;
      entity.speedMetersPerSecond = row.speed_meters_per_second as number | null;
      entity.address = row.address as string | null;
      entity.city = row.city as string | null;
      entity.region = row.region as string | null;
      entity.country = row.country as string | null;
      entity.postalCode = row.postal_code as string | null;
      entity.name = row.name as string | null;
      entity.description = row.description as string | null;
      entity.provider = row.provider as string | null;
      entity.source = row.source as LocationSource;
      entity.activityType = row.activity_type as string | null;
      entity.locationEntityId = row.location_entity_id as string | null;
      entity.referenceEntityId = row.reference_entity_id as string | null;
      entity.relativeCoordinates = (row.relative_coordinates as Record<string, unknown>) || {};
      entity.relativeOrientation = (row.relative_orientation as Record<string, unknown>) || {};
      entity.isPrivate = (row.is_private as boolean) ?? false;

      return PositionEntity.toEgressType(entity);
    });
  }

  private parseLocation(location: unknown): Point | null {
    if (!location) {
      return null;
    }

    if (
      typeof location === 'object' &&
      location !== null &&
      'type' in location &&
      'coordinates' in location
    ) {
      return location as Point;
    }

    if (typeof location === 'string' && location.includes('POINT')) {
      const match = location.match(/POINT\(([^)]+)\)/);
      if (match) {
        const [lon, lat] = match[1].split(' ').map(Number);

        return {
          type: 'Point',
          coordinates: [lon, lat],
        };
      }
    }

    return null;
  }
}

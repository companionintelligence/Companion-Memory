import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export interface CoverageCount {
  rows: number;
  matched: number;
  pct: number;
}

export interface IngestStatusSnapshot {
  /**
   * Static contract capabilities of this server's `/v1` plane, so a client can
   * feature-detect from the same probe it already makes (GET /v1/ingest/status)
   * instead of version-sniffing. `eventsSourceType`: POST /v1/events accepts an
   * optional provenance `source_type` on each event (absent → the endpoint
   * behaves exactly as before, stamping 'capture').
   */
  capabilities: {
    eventsSourceType: true;
  };
  /** Row counts of the bulk-ingest destination tables. */
  tables: {
    communications: number;
    events: number;
    content: number;
    objects: number;
    browser_activity: number;
    position: number;
    /**
     * The object plane. Reported alongside `objects` rather than folded into
     * it because the whole point of the split is that they count different
     * things: `product_models` are what units ARE, `receipts` /
     * `receipt_line_items` are where they came from, and `object_observations`
     * are sightings that may never become an owned unit at all — an
     * observations count far ahead of an objects count is the expected shape,
     * not a backlog.
     */
    product_models: number;
    receipts: number;
    receipt_line_items: number;
    object_observations: number;
  };
  searchIndex: {
    /** `ci_search.embeddings` rows per entity_type. */
    embeddingsByType: Record<string, number>;
    /** `ci_search.index_skips` rows per entity_type (examined, not embedded). */
    skipsByType: Record<string, number>;
    /** Pending/in-flight/failed jobs on the search-index pgboss queue. */
    queue: { created: number; active: number; failed: number };
  };
  /**
   * Per-user (default) or appliance-wide enrichment coverage. Zeros are present
   * so under-enrichment is a percentage, not an absent field.
   */
  coverage: {
    embedded: Record<string, { rows: number; embedded: number; skipped: number; pctDecided: number }>;
    linked: {
      communicationsWithFrom: CoverageCount;
      eventsWithOrganizer: CoverageCount;
    };
    geocoded: {
      eventsNamedOrSited: CoverageCount;
      positionsAddressed: CoverageCount;
      objectPlaced: CoverageCount;
    };
  };
  /** ISO timestamp the snapshot was taken. */
  at: string;
}

function pct(matched: number, rows: number): number {
  return rows > 0 ? matched / rows : 0;
}

function count(rows: number, matched: number): CoverageCount {
  return { rows, matched, pct: pct(matched, rows) };
}

/**
 * Ingest observability snapshot for the `/v1` bulk plane.
 */
@Injectable()
export class IngestStatusService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async snapshot(
    options: { userId?: string; scope?: 'user' | 'appliance' } = {},
  ): Promise<IngestStatusSnapshot> {
    const appliance = options.scope === 'appliance' || !options.userId;
    const userId = appliance ? null : options.userId;

    const [tableRows, embeddingRows, skipRows, queueRows, coverageRows] = await Promise.all([
      this.dataSource.query<
        Array<{
          communications: string;
          events: string;
          content: string;
          objects: string;
          browser_activity: string;
          position: string;
          product_models: string;
          receipts: string;
          receipt_line_items: string;
          object_observations: string;
        }>
      >(
        userId
          ? `SELECT
               (SELECT count(*) FROM ci.communications WHERE user_id = $1)       AS communications,
               (SELECT count(*) FROM ci.events WHERE user_id = $1)               AS events,
               (SELECT count(*) FROM ci.content WHERE user_id = $1)              AS content,
               (SELECT count(*) FROM ci.objects WHERE user_id::uuid = $1)      AS objects,
               (SELECT count(*) FROM ci.browser_activity WHERE user_id = $1)     AS browser_activity,
               (SELECT count(*) FROM ci.position WHERE user_id = $1)             AS position,
               (SELECT count(*) FROM ci.product_models WHERE user_id = $1)       AS product_models,
               (SELECT count(*) FROM ci.receipts WHERE user_id = $1)             AS receipts,
               (SELECT count(*) FROM ci.receipt_line_items WHERE user_id = $1)   AS receipt_line_items,
               (SELECT count(*) FROM ci.object_observations WHERE user_id = $1)  AS object_observations`
          : `SELECT
               (SELECT count(*) FROM ci.communications)       AS communications,
               (SELECT count(*) FROM ci.events)               AS events,
               (SELECT count(*) FROM ci.content)              AS content,
               (SELECT count(*) FROM ci.objects)            AS objects,
               (SELECT count(*) FROM ci.browser_activity)     AS browser_activity,
               (SELECT count(*) FROM ci.position)             AS position,
               (SELECT count(*) FROM ci.product_models)       AS product_models,
               (SELECT count(*) FROM ci.receipts)             AS receipts,
               (SELECT count(*) FROM ci.receipt_line_items)   AS receipt_line_items,
               (SELECT count(*) FROM ci.object_observations)  AS object_observations`,
        userId ? [userId] : [],
      ),
      this.dataSource.query<Array<{ entity_type: string; count: string }>>(
        userId
          ? `SELECT entity_type, count(*) AS count FROM ci_search.embeddings WHERE user_id = $1 GROUP BY entity_type`
          : `SELECT entity_type, count(*) AS count FROM ci_search.embeddings GROUP BY entity_type`,
        userId ? [userId] : [],
      ),
      this.dataSource.query<Array<{ entity_type: string; count: string }>>(
        `SELECT entity_type, count(*) AS count FROM ci_search.index_skips GROUP BY entity_type`,
      ),
      this.dataSource.query<Array<{ state: string; count: string }>>(
        `SELECT state, count(*) AS count
           FROM pgboss.job
          WHERE name = 'search-index' AND state IN ('created', 'active', 'failed')
          GROUP BY state`,
      ),
      this.dataSource.query<
        Array<{
          comms_linked: string;
          events_linked: string;
          events_geocoded: string;
          positions_named: string;
          inv_coords: string;
          inv_placed: string;
        }>
      >(
        userId
          ? `SELECT
               (SELECT count(*) FROM ci.communications WHERE user_id = $1 AND from_entity_id IS NOT NULL) AS comms_linked,
               (SELECT count(*) FROM ci.events WHERE user_id = $1 AND organizer_entity_id IS NOT NULL) AS events_linked,
               (SELECT count(*) FROM ci.events WHERE user_id = $1 AND (
                  location_entity_id IS NOT NULL
                  OR (location_name IS NOT NULL AND btrim(location_name) <> '')
                  OR location_coordinates IS NOT NULL
               )) AS events_geocoded,
               (SELECT count(*) FROM ci.position WHERE user_id = $1 AND COALESCE(btrim(address), '') <> '') AS positions_named,
               (SELECT count(*) FROM ci.objects WHERE user_id::uuid = $1 AND current_location_coordinates IS NOT NULL) AS inv_coords,
               (SELECT count(*) FROM ci.objects WHERE user_id::uuid = $1 AND last_seen_place_entity_id IS NOT NULL) AS inv_placed`
          : `SELECT
               (SELECT count(*) FROM ci.communications WHERE from_entity_id IS NOT NULL) AS comms_linked,
               (SELECT count(*) FROM ci.events WHERE organizer_entity_id IS NOT NULL) AS events_linked,
               (SELECT count(*) FROM ci.events WHERE (
                  location_entity_id IS NOT NULL
                  OR (location_name IS NOT NULL AND btrim(location_name) <> '')
                  OR location_coordinates IS NOT NULL
               )) AS events_geocoded,
               (SELECT count(*) FROM ci.position WHERE COALESCE(btrim(address), '') <> '') AS positions_named,
               (SELECT count(*) FROM ci.objects WHERE current_location_coordinates IS NOT NULL) AS inv_coords,
               (SELECT count(*) FROM ci.objects WHERE last_seen_place_entity_id IS NOT NULL) AS inv_placed`,
        userId ? [userId] : [],
      ),
    ]);

    const toByType = (rows: Array<{ entity_type: string; count: string }>) =>
      Object.fromEntries(rows.map((row) => [row.entity_type, Number(row.count)]));

    const queue = { created: 0, active: 0, failed: 0 };
    for (const row of queueRows) {
      queue[row.state as keyof typeof queue] = Number(row.count);
    }

    const tablesRaw = tableRows[0];
    const tables = {
      communications: Number(tablesRaw?.communications ?? 0),
      events: Number(tablesRaw?.events ?? 0),
      content: Number(tablesRaw?.content ?? 0),
      objects: Number(tablesRaw?.objects ?? 0),
      browser_activity: Number(tablesRaw?.browser_activity ?? 0),
      position: Number(tablesRaw?.position ?? 0),
      product_models: Number(tablesRaw?.product_models ?? 0),
      receipts: Number(tablesRaw?.receipts ?? 0),
      receipt_line_items: Number(tablesRaw?.receipt_line_items ?? 0),
      object_observations: Number(tablesRaw?.object_observations ?? 0),
    };
    const embeddingsByType = toByType(embeddingRows);
    const skipsByType = toByType(skipRows);
    const cover = coverageRows[0];

    const entityRows: Record<string, number> = {
      communication: tables.communications,
      event: tables.events,
      content: tables.content,
      item: tables.objects,
      'browser-activity': tables.browser_activity,
      position: tables.position,
    };

    const embedded: IngestStatusSnapshot['coverage']['embedded'] = {};
    for (const [entityType, rows] of Object.entries(entityRows)) {
      const embeddedCount = embeddingsByType[entityType] ?? 0;
      const skipped = skipsByType[entityType] ?? 0;
      embedded[entityType] = {
        rows,
        embedded: embeddedCount,
        skipped,
        pctDecided: pct(embeddedCount + skipped, rows),
      };
    }

    return {
      capabilities: {
        eventsSourceType: true,
      },
      tables,
      searchIndex: {
        embeddingsByType,
        skipsByType,
        queue,
      },
      coverage: {
        embedded,
        linked: {
          communicationsWithFrom: count(tables.communications, Number(cover?.comms_linked ?? 0)),
          eventsWithOrganizer: count(tables.events, Number(cover?.events_linked ?? 0)),
        },
        geocoded: {
          eventsNamedOrSited: count(tables.events, Number(cover?.events_geocoded ?? 0)),
          positionsAddressed: count(tables.position, Number(cover?.positions_named ?? 0)),
          objectPlaced: count(Number(cover?.inv_coords ?? 0), Number(cover?.inv_placed ?? 0)),
        },
      },
      at: new Date().toISOString(),
    };
  }
}

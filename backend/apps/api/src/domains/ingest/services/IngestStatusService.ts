import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export interface IngestStatusSnapshot {
  /** Row counts of the bulk-ingest destination tables. */
  tables: {
    communications: number;
    events: number;
    content: number;
    inventory: number;
    browser_activity: number;
    position: number;
  };
  searchIndex: {
    /** `ci_search.embeddings` rows per entity_type. */
    embeddingsByType: Record<string, number>;
    /** `ci_search.index_skips` rows per entity_type (examined, not embedded). */
    skipsByType: Record<string, number>;
    /** Pending/in-flight/failed jobs on the search-index pgboss queue. */
    queue: { created: number; active: number; failed: number };
  };
  /** ISO timestamp the snapshot was taken. */
  at: string;
}

/**
 * Ingest observability snapshot for the `/v1` bulk plane: row counts of the
 * bulk-ingest destination tables plus the search-index side (embeddings + skip
 * markers per type, and the search-index queue depth from pgboss). One call
 * answers "did the bulk load land, and how far along is the index?".
 *
 * Same snapshot GET /api/maintenance/ingest-status serves (that handler
 * currently inlines these queries in MaintenanceController — converging it onto
 * this service is a follow-up kept out of this change to avoid touching the
 * maintenance controller), plus a `position` table count since positions are
 * part of the /v1 bulk plane. The plain count(*) on the communications
 * hypertable is ~1-2s at 1M rows — acceptable for an ops endpoint hit by hand
 * or a post-load poller.
 */
@Injectable()
export class IngestStatusService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async snapshot(): Promise<IngestStatusSnapshot> {
    const [tableRows, embeddingRows, skipRows, queueRows] = await Promise.all([
      this.dataSource.query<
        Array<{
          communications: string;
          events: string;
          content: string;
          inventory: string;
          browser_activity: string;
          position: string;
        }>
      >(
        `SELECT
           (SELECT count(*) FROM ci.communications)   AS communications,
           (SELECT count(*) FROM ci.events)           AS events,
           (SELECT count(*) FROM ci.content)          AS content,
           (SELECT count(*) FROM ci.inventory)        AS inventory,
           (SELECT count(*) FROM ci.browser_activity) AS browser_activity,
           (SELECT count(*) FROM ci.position)         AS position`,
      ),
      this.dataSource.query<Array<{ entity_type: string; count: string }>>(
        `SELECT entity_type, count(*) AS count FROM ci_search.embeddings GROUP BY entity_type`,
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
    ]);

    const toByType = (rows: Array<{ entity_type: string; count: string }>) =>
      Object.fromEntries(rows.map((row) => [row.entity_type, Number(row.count)]));

    const queue = { created: 0, active: 0, failed: 0 };
    for (const row of queueRows) {
      queue[row.state as keyof typeof queue] = Number(row.count);
    }

    const tables = tableRows[0];

    return {
      tables: {
        communications: Number(tables?.communications ?? 0),
        events: Number(tables?.events ?? 0),
        content: Number(tables?.content ?? 0),
        inventory: Number(tables?.inventory ?? 0),
        browser_activity: Number(tables?.browser_activity ?? 0),
        position: Number(tables?.position ?? 0),
      },
      searchIndex: {
        embeddingsByType: toByType(embeddingRows),
        skipsByType: toByType(skipRows),
        queue,
      },
      at: new Date().toISOString(),
    };
  }
}

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { EntityIdentifierService, type IdentifierKey, normalizeIdentifier } from '@ci/domains/graph';

/** Default window width — one TimescaleDB-chunk-friendly slice per pass. */
const DEFAULT_WINDOW_DAYS = 7;

/** Default cap on candidate rows examined per window (bounds memory + a query). */
const DEFAULT_WINDOW_LIMIT = 5000;

export interface CommunicationLinkBackfillOptions {
  /**
   * Only consider communications with `time` in [startTime, endTime]. STRONGLY
   * recommended on the hypertable: an unbounded pass scans every chunk (the
   * all-chunk Append that segfaulted TSDB 2.28). When omitted the service
   * derives the bound from the data's own MIN/MAX(time) and walks it in
   * windows, but a caller-supplied range is cheaper and safer.
   */
  startTime?: Date;
  endTime?: Date;
  /** Window width in days (default 7). Each window is one bounded read+update. */
  windowDays?: number;
  /** Max candidate rows pulled per window (default 5000). */
  windowLimit?: number;
}

export interface CommunicationLinkBackfillResult {
  /** Candidate communications examined (had an unset from/to and metadata). */
  examined: number;
  /** Rows whose from_entity_id was filled. */
  fromLinked: number;
  /** Rows whose to_entity_ids was filled (in whole or part). */
  toLinked: number;
  /** Time windows processed. */
  windows: number;
  /** The resolved [start, end] actually scanned (ISO strings), or null if no data. */
  range: { start: string; end: string } | null;
}

interface CandidateRow {
  id: string;
  time: Date;
  user_id: string;
  from_entity_id: string | null;
  to_entity_ids: string[] | null;
  participants_metadata: Record<string, unknown> | null;
}

/**
 * RE-RUNNABLE people-linking backfill for `ci.communications`.
 *
 * For every communication missing its graph links, normalize the raw
 * participant strings in `participants_metadata` and resolve them against
 * `ci.entity_identifiers` (the email/phone -> entity_id index populated on graph
 * ingest):
 *   - `participants_metadata->>'from'`  -> `from_entity_id`  (when NULL)
 *   - `participants_metadata->'to'` (array) -> `to_entity_ids` (when NULL/empty)
 *
 * No match leaves the column NULL — it never creates stub Person entities, and
 * it only ever writes previously-NULL columns, so it is idempotent and safe to
 * re-run as new identifiers arrive.
 *
 * Hypertable safety: `communications` is a TimescaleDB hypertable partitioned on
 * `time`. Every read/update is bounded to a [start, end) time window so Postgres
 * can exclude non-matching chunks rather than building the all-chunk Append plan
 * that segfaulted TSDB 2.28. The service walks the requested (or data-derived)
 * range in windows of {@link CommunicationLinkBackfillOptions.windowDays}.
 *
 * Operator-invoked via POST /api/maintenance/link-communications (see
 * MaintenanceController) — never auto-run, never in the hot ingest path.
 */
@Injectable()
export class CommunicationLinkBackfillService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly entityIdentifierService: EntityIdentifierService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(CommunicationLinkBackfillService.name);
  }

  async backfill(
    userId: string,
    options: CommunicationLinkBackfillOptions = {},
  ): Promise<CommunicationLinkBackfillResult> {
    const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
    const windowLimit = options.windowLimit ?? DEFAULT_WINDOW_LIMIT;

    const bounds = await this.resolveBounds(userId, options.startTime, options.endTime);
    if (bounds == null) {
      return { examined: 0, fromLinked: 0, toLinked: 0, windows: 0, range: null };
    }

    const { start, end } = bounds;

    let examined = 0;
    let fromLinked = 0;
    let toLinked = 0;
    let windows = 0;

    const windowMs = windowDays * 24 * 60 * 60 * 1000;

    // Walk newest-first: more recent communications are likelier to have a
    // matching, recently-ingested Person. Each window is its own bounded scan.
    let windowEnd = end;
    while (windowEnd > start) {
      const windowStart = new Date(Math.max(start.getTime(), windowEnd.getTime() - windowMs));

      const windowResult = await this.backfillWindow(userId, windowStart, windowEnd, windowLimit);
      examined += windowResult.examined;
      fromLinked += windowResult.fromLinked;
      toLinked += windowResult.toLinked;
      windows += 1;

      // Step to the next, older window. windowStart is inclusive here and used as
      // the exclusive upper bound of the next window, so no row is double-counted.
      windowEnd = windowStart;
    }

    this.logger.log('Communication link backfill complete', {
      userId,
      examined,
      fromLinked,
      toLinked,
      windows,
      start: start.toISOString(),
      end: end.toISOString(),
    });

    return {
      examined,
      fromLinked,
      toLinked,
      windows,
      range: { start: start.toISOString(), end: end.toISOString() },
    };
  }

  /**
   * Resolve the [start, end] time range to scan. Uses caller-supplied bounds
   * verbatim when both are given; otherwise fills the missing side from the
   * candidate data's own MIN/MAX(time) so an operator can run the whole history
   * without naming dates (still windowed underneath). Returns null when there
   * are no candidate rows at all.
   */
  private async resolveBounds(
    userId: string,
    startTime: Date | undefined,
    endTime: Date | undefined,
  ): Promise<{ start: Date; end: Date } | null> {
    if (startTime != null && endTime != null) {
      return startTime <= endTime ? { start: startTime, end: endTime } : null;
    }

    const rows: Array<{ min_time: Date | null; max_time: Date | null }> = await this.dataSource.query(
      `SELECT MIN(time) AS min_time, MAX(time) AS max_time
         FROM ci.communications
        WHERE user_id = $1
          AND from_entity_id IS NULL`,
      [userId],
    );

    const minTime = rows[0]?.min_time ?? null;
    const maxTime = rows[0]?.max_time ?? null;
    if (minTime == null || maxTime == null) {
      return null;
    }

    const start = startTime ?? new Date(minTime);
    // Add 1ms so the inclusive MAX(time) row falls inside a half-open window.
    const end = endTime ?? new Date(new Date(maxTime).getTime() + 1);

    return start <= end ? { start, end } : null;
  }

  /**
   * Backfill a single bounded time window: [windowStart, windowEnd). Reads
   * candidate rows (unset links + metadata) within the window, resolves their
   * normalized participants in ONE batched identifier lookup, then writes the
   * resolved links back row-by-row within the same window bound.
   */
  private async backfillWindow(
    userId: string,
    windowStart: Date,
    windowEnd: Date,
    limit: number,
  ): Promise<{ examined: number; fromLinked: number; toLinked: number }> {
    const candidates: CandidateRow[] = await this.dataSource.query(
      `SELECT id, time, user_id, from_entity_id, to_entity_ids, participants_metadata
         FROM ci.communications
        WHERE user_id = $1
          AND time >= $2
          AND time < $3
          AND (from_entity_id IS NULL OR to_entity_ids IS NULL OR cardinality(to_entity_ids) = 0)
          AND participants_metadata IS NOT NULL
        ORDER BY time DESC
        LIMIT $4`,
      [userId, windowStart.toISOString(), windowEnd.toISOString(), limit],
    );

    if (candidates.length === 0) {
      return { examined: 0, fromLinked: 0, toLinked: 0 };
    }

    // Collect every distinct identifier this window needs, then resolve them all
    // in a single query (one round-trip for the whole window).
    const keys: IdentifierKey[] = [];
    const seen = new Set<string>();
    const addKey = (key: IdentifierKey | null) => {
      if (key == null) {
        return;
      }

      const dedupe = `${key.kind}:${key.valueNormalized}`;
      if (!seen.has(dedupe)) {
        seen.add(dedupe);
        keys.push(key);
      }
    };

    for (const row of candidates) {
      const meta = row.participants_metadata ?? {};
      if (row.from_entity_id == null) {
        addKey(classify(readString(meta.from)));
      }

      if (row.to_entity_ids == null || row.to_entity_ids.length === 0) {
        for (const raw of readStringArray(meta.to)) {
          addKey(classify(raw));
        }
      }
    }

    const resolved = await this.entityIdentifierService.findEntityIdsByIdentifiers(userId, keys);

    const lookup = (raw: string | null): string | null => {
      const key = classify(raw);
      if (key == null) {
        return null;
      }

      return resolved.get(`${key.kind}:${key.valueNormalized}`) ?? null;
    };

    let examined = 0;
    let fromLinked = 0;
    let toLinked = 0;

    for (const row of candidates) {
      examined += 1;
      const meta = row.participants_metadata ?? {};

      const fromId = row.from_entity_id == null ? lookup(readString(meta.from)) : null;

      let toIds: string[] | null = null;
      if (row.to_entity_ids == null || row.to_entity_ids.length === 0) {
        const ids = readStringArray(meta.to)
          .map((raw) => lookup(raw))
          .filter((id): id is string => id != null);
        // Only write when we actually resolved at least one recipient.
        toIds = ids.length > 0 ? unique(ids) : null;
      }

      if (fromId == null && toIds == null) {
        continue;
      }

      // Update is bounded by the partition key (time + user_id + id) so it stays
      // within this one chunk. The NULL guards in WHERE keep it idempotent even
      // if the row changed since the read.
      await this.dataSource.query(
        `UPDATE ci.communications
            SET from_entity_id = COALESCE($4, from_entity_id),
                to_entity_ids   = CASE
                                    WHEN $5::uuid[] IS NOT NULL
                                         AND (to_entity_ids IS NULL OR cardinality(to_entity_ids) = 0)
                                    THEN $5::uuid[]
                                    ELSE to_entity_ids
                                  END
          WHERE user_id = $1
            AND time = $2
            AND id = $3`,
        [userId, row.time, row.id, fromId, toIds],
      );

      if (fromId != null) {
        fromLinked += 1;
      }

      if (toIds != null) {
        toLinked += 1;
      }
    }

    return { examined, fromLinked, toLinked };
  }
}

/**
 * Classify a raw participant string as an email or phone and normalize it with
 * the SAME shared rule the identifier index uses. Returns null for empty /
 * unclassifiable input. An '@' marks an email; otherwise it is a phone number.
 */
function classify(raw: string | null): IdentifierKey | null {
  if (raw == null) {
    return null;
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const kind = trimmed.includes('@') ? 'email' : 'phone';
  const valueNormalized = normalizeIdentifier(kind, trimmed);
  if (valueNormalized == null) {
    return null;
  }

  return { kind, valueNormalized };
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readStringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }

  return [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { classifyParticipant, EntityIdentifierService, type IdentifierKey } from '@ci/domains/graph';

/** Default window width — one TimescaleDB-chunk-friendly slice per pass. */
const DEFAULT_WINDOW_DAYS = 7;

/** Default cap on candidate rows examined per window (bounds memory + a query). */
const DEFAULT_WINDOW_LIMIT = 5000;

/**
 * Per-window progress snapshot for {@link CommunicationLinkBackfillOptions.onProgress}.
 * All counts are CUMULATIVE running totals at the point the most recent window's
 * writes committed; `windowsDone` is the numerator and `windowsTotal` the
 * denominator of a determinate progress bar (so `windowsDone / windowsTotal` is a
 * valid 0..1 ratio that reaches 1 on completion).
 */
export interface CommunicationLinkBackfillProgress {
  /** Candidate communications examined so far (cumulative). */
  examined: number;
  /** Rows whose from_entity_id was filled so far (cumulative). */
  fromLinked: number;
  /** Rows whose to_entity_ids was filled so far (cumulative). */
  toLinked: number;
  /** Windows whose writes have committed so far (numerator). */
  windowsDone: number;
  /** Total windows this run will process (denominator), known up front. */
  windowsTotal: number;
}

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
  /**
   * Invoked once per window, AFTER that window's writes commit, with cumulative
   * counts plus `windowsDone`/`windowsTotal`. Drives a determinate per-window
   * progress bar for the importer's maintenance stage. Optional; the synchronous
   * result return value is unchanged whether or not this is supplied.
   */
  onProgress?: (partial: CommunicationLinkBackfillProgress) => void;
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

    // Denominator known up front: the while-loop below steps windowEnd down from
    // `end` to `start` in windowMs slices, so it runs ceil((end - start) / windowMs)
    // times. Matches the loop's stepping exactly so windowsDone reaches this on
    // completion. (>=1 whenever there is any range; ceil of 0 stays 0.)
    const windowsTotal = Math.ceil((end.getTime() - start.getTime()) / windowMs);

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

      // This window's writes have committed (backfillWindow awaited above), so
      // emit cumulative progress with windows as the numerator. Done AFTER the
      // writes commit so a consumer never sees progress ahead of durable state.
      options.onProgress?.({
        examined,
        fromLinked,
        toLinked,
        windowsDone: windows,
        windowsTotal,
      });

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

    // The bounds MUST cover every row backfillWindow() will treat as a candidate,
    // otherwise rows that only need to_entity_ids linked (from_entity_id already
    // set) fall outside [min,max] and are silently skipped. Keep this predicate
    // byte-identical to backfillWindow()'s candidate WHERE clause.
    const rows: Array<{ min_time: Date | null; max_time: Date | null }> = await this.dataSource.query(
      `SELECT MIN(time) AS min_time, MAX(time) AS max_time
         FROM ci.communications
        WHERE user_id = $1
          AND (from_entity_id IS NULL OR to_entity_ids IS NULL OR cardinality(to_entity_ids) = 0)`,
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
    let examined = 0;
    let fromLinked = 0;
    let toLinked = 0;

    // Keyset cursor (time, id) DESC. A single LIMIT would strand every candidate
    // past the first page in a dense window (e.g. a high-volume sender whose
    // messages in one window exceed the page size) — and because the outer loop
    // then steps to an older window, those stranded rows would never be reached
    // (the observed "31 of 122k linked" bug). Page through the whole window with
    // a (time, id) cursor so every candidate is examined exactly once.
    let cursorTime = windowEnd.toISOString();
    let cursorId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

    for (;;) {
      const candidates: CandidateRow[] = await this.dataSource.query(
        `SELECT id, time, user_id, from_entity_id, to_entity_ids, participants_metadata
           FROM ci.communications
          WHERE user_id = $1
            AND time >= $2
            AND time < $3
            AND (from_entity_id IS NULL OR to_entity_ids IS NULL OR cardinality(to_entity_ids) = 0)
            AND participants_metadata IS NOT NULL
            AND (time, id) < ($5::timestamptz, $6::uuid)
          ORDER BY time DESC, id DESC
          LIMIT $4`,
        [userId, windowStart.toISOString(), windowEnd.toISOString(), limit, cursorTime, cursorId],
      );

      if (candidates.length === 0) {
        break;
      }

      // Collect every distinct identifier this page needs, then resolve them all
      // in a single query (one round-trip for the whole page).
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
          addKey(classifyParticipant(readString(meta.from)));
        }

        if (row.to_entity_ids == null || row.to_entity_ids.length === 0) {
          for (const raw of readStringArray(meta.to)) {
            addKey(classifyParticipant(raw));
          }
        }
      }

      const resolved = await this.entityIdentifierService.findEntityIdsByIdentifiers(userId, keys);

      const lookup = (raw: string | null): string | null => {
        const key = classifyParticipant(raw);
        if (key == null) {
          return null;
        }

        return resolved.get(`${key.kind}:${key.valueNormalized}`) ?? null;
      };

      // Resolve every candidate in memory, collecting the writes, then apply
      // them as ONE set-based UPDATE per page. The previous one-round-trip-per-row
      // UPDATE was the dominant cost over a long history (a 22-year backfill is
      // ~100k+ writes), so a single HTTP call never finished and only the
      // newest windows linked. Parallel arrays are zipped with unnest below.
      const updIds: string[] = [];
      const updTimes: string[] = [];
      const updFromIds: (string | null)[] = [];
      const updToIds: (string | null)[] = []; // JSON array of uuids, or null

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

        if (fromId != null || toIds != null) {
          updIds.push(row.id);
          updTimes.push(row.time instanceof Date ? row.time.toISOString() : String(row.time));
          updFromIds.push(fromId);
          updToIds.push(toIds != null ? JSON.stringify(toIds) : null);

          if (fromId != null) {
            fromLinked += 1;
          }

          if (toIds != null) {
            toLinked += 1;
          }
        }
      }

      if (updIds.length > 0) {
        // One set-based UPDATE for the whole page. `to_ids` rides as jsonb (a
        // uuid[][] can't be unnested element-wise); each row's array is rebuilt
        // in SQL. Still bounded to this page's (user_id, time, id) rows so it
        // stays chunk-local; the NULL guards keep it idempotent.
        //
        // Historical rows live in COMPRESSED TimescaleDB chunks; a wide UPDATE
        // decompresses them and exceeds the default per-txn cap (100k tuples),
        // aborting the backfill. Lift the cap for this txn only — a one-time
        // backfill; the compression policy recompacts the touched chunks later.
        await this.dataSource.transaction(async (em) => {
          await em.query('SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0');
          await em.query(
            `UPDATE ci.communications c
              SET from_entity_id = COALESCE(u.from_id, c.from_entity_id),
                  to_entity_ids   = CASE
                                      WHEN u.to_ids IS NOT NULL
                                           AND (c.to_entity_ids IS NULL OR cardinality(c.to_entity_ids) = 0)
                                      THEN u.to_ids
                                      ELSE c.to_entity_ids
                                    END
             FROM (
               SELECT t.id,
                      t.time,
                      t.from_id,
                      CASE
                        WHEN t.to_json IS NULL THEN NULL
                        ELSE ARRAY(SELECT jsonb_array_elements_text(t.to_json))::uuid[]
                      END AS to_ids
                 FROM unnest($2::uuid[], $3::timestamptz[], $4::uuid[], $5::jsonb[])
                        AS t(id, time, from_id, to_json)
             ) u
            WHERE c.user_id = $1
              AND c.time = u.time
              AND c.id = u.id`,
            [userId, updIds, updTimes, updFromIds, updToIds],
          );
        });
      }

      // Advance the keyset cursor to the oldest row in this page. Strictly
      // monotonic (time DESC, id DESC), so the loop always makes progress and
      // terminates; a short page means the window is drained.
      const last = candidates[candidates.length - 1];
      cursorTime = last.time instanceof Date ? last.time.toISOString() : String(last.time);
      cursorId = last.id;

      if (candidates.length < limit) {
        break;
      }
    }

    return { examined, fromLinked, toLinked };
  }
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

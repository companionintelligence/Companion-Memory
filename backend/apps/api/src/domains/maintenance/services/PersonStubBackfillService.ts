import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import {
  EntityIdentifierService,
  type GraphEntityInputDto,
  GraphIngestService,
  type IdentifierKey,
  type IdentifierKind,
  normalizeIdentifier,
} from '@ci/domains/graph';

/** Default window width — one TimescaleDB-chunk-friendly slice per pass. */
const DEFAULT_WINDOW_DAYS = 7;

/** Default cap on candidate rows examined per window (bounds memory + a query). */
const DEFAULT_WINDOW_LIMIT = 5000;

/**
 * sourceSystem the stub Person entities are stamped with. Routes them under
 * `linked_table = 'import:communications:participant'` so the linked-key upsert
 * is reproducible AND distinct from contact-importer Person entities (a real
 * import would write its own row under its own linked_table; an importer that
 * pushes the same email later does NOT collide with us, and the identifier
 * index keeps pointing at whichever Person we already created — safe but not
 * a merge; that's a separate chip).
 */
const STUB_SOURCE_SYSTEM = 'communications:participant';

export interface PersonStubBackfillOptions {
  /**
   * Only consider communications with `time` in [startTime, endTime]. Strongly
   * recommended on the hypertable — an unbounded scan touches every chunk.
   * When omitted the service derives bounds from MIN/MAX(time).
   */
  startTime?: Date;
  endTime?: Date;
  /** Window width in days (default 7). Each window is one bounded read. */
  windowDays?: number;
  /** Max candidate rows pulled per window (default 5000). */
  windowLimit?: number;
}

export interface PersonStubBackfillResult {
  /** Candidate communications examined. */
  examined: number;
  /** Distinct (kind, value) identifiers seen across all windows. */
  identifiersSeen: number;
  /** Identifiers the prefilter found already covered by the index. */
  identifiersExisting: number;
  /**
   * Upper bound on stub Person entities created. Sourced from
   * `GraphIngestService.ingest`'s `entitiesProcessed`, which also counts
   * idempotent resolves of pre-existing linked-key rows — so a concurrent
   * writer that landed the same key between this run's prefilter and ingest
   * is counted here even though no row was inserted. Treat as "stubs
   * attempted"; the actual delta is bounded above by this number.
   */
  peopleCreated: number;
  /**
   * Upper bound on identifier-index rows inserted. Equals the count of new
   * entities sent to ingest (one identifier per entity by construction); the
   * actual inserts can be fewer because the ON CONFLICT DO NOTHING upsert
   * drops anything a concurrent writer landed first.
   */
  identifiersIndexed: number;
  /** Errors surfaced by GraphIngestService.ingest, joined by '\n'. */
  errors: string[];
  /** Time windows processed. */
  windows: number;
  /** The resolved [start, end] actually scanned (ISO strings), or null if no data. */
  range: { start: string; end: string } | null;
}

interface CandidateRow {
  id: string;
  time: Date;
  participants_metadata: Record<string, unknown> | null;
}

interface SeenIdentifier {
  key: IdentifierKey;
  /** First-seen raw participant string. Used as the stub Person's display name. */
  rawName: string;
}

/**
 * One-shot people-extraction backfill for `ci.communications`.
 *
 * Walks the corpus, distincts the raw participant strings in
 * `participants_metadata.{from,to,cc,bcc}`, and creates a stub Person entity
 * + `ci.entity_identifiers` row for every NEW (kind, value_normalized) the
 * identifier index doesn't already cover. This is the foundation step that
 * unblocks {@link CommunicationLinkBackfillService}: that service resolves
 * participants against the identifier index but never CREATES them, so a fresh
 * corpus (no contact importer ran, importer didn't push Person nodes carrying
 * `properties.emails`/`.phones`, etc.) leaves the index empty and every
 * communication unlinked. Run this FIRST, then /api/maintenance/link-communications.
 *
 * Delegates entity + identifier writes to {@link GraphIngestService.ingest},
 * which is itself idempotent (entities dedupe on the linked-key partial unique
 * index; identifiers dedupe on the (owner_user_id, kind, value_normalized)
 * unique index). Safe to re-run as new corpora arrive.
 *
 * Hypertable safety: every read is bounded to a [start, end) `time` window so
 * Postgres can exclude non-matching TimescaleDB chunks — the same pattern the
 * link backfill uses. Operator-invoked via
 * POST /api/maintenance/extract-people-from-communications.
 */
@Injectable()
export class PersonStubBackfillService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly graphIngestService: GraphIngestService,
    private readonly entityIdentifierService: EntityIdentifierService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PersonStubBackfillService.name);
  }

  async backfill(userId: string, options: PersonStubBackfillOptions = {}): Promise<PersonStubBackfillResult> {
    const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
    const windowLimit = options.windowLimit ?? DEFAULT_WINDOW_LIMIT;

    const bounds = await this.resolveBounds(userId, options.startTime, options.endTime);
    if (bounds == null) {
      return {
        examined: 0,
        identifiersSeen: 0,
        identifiersExisting: 0,
        peopleCreated: 0,
        identifiersIndexed: 0,
        errors: [],
        windows: 0,
        range: null,
      };
    }

    const { start, end } = bounds;

    let examined = 0;
    let identifiersSeen = 0;
    let identifiersExisting = 0;
    let peopleCreated = 0;
    let identifiersIndexed = 0;
    const errors: string[] = [];
    let windows = 0;

    const windowMs = windowDays * 24 * 60 * 60 * 1000;

    // Walk newest-first to mirror the link backfill so an operator who runs the
    // pair sees the most-recent communications light up first.
    let windowEnd = end;
    while (windowEnd > start) {
      const windowStart = new Date(Math.max(start.getTime(), windowEnd.getTime() - windowMs));

      const windowResult = await this.backfillWindow(userId, windowStart, windowEnd, windowLimit);
      examined += windowResult.examined;
      identifiersSeen += windowResult.identifiersSeen;
      identifiersExisting += windowResult.identifiersExisting;
      peopleCreated += windowResult.peopleCreated;
      identifiersIndexed += windowResult.identifiersIndexed;
      errors.push(...windowResult.errors);
      windows += 1;

      windowEnd = windowStart;
    }

    this.logger.log('Person stub backfill complete', {
      userId,
      examined,
      identifiersSeen,
      identifiersExisting,
      peopleCreated,
      identifiersIndexed,
      windows,
      start: start.toISOString(),
      end: end.toISOString(),
    });

    return {
      examined,
      identifiersSeen,
      identifiersExisting,
      peopleCreated,
      identifiersIndexed,
      errors,
      windows,
      range: { start: start.toISOString(), end: end.toISOString() },
    };
  }

  /**
   * Resolve the [start, end] time range to scan. Uses caller-supplied bounds
   * verbatim when both are given; otherwise fills the missing side from the
   * candidate data's own MIN/MAX(time). Returns null when no candidate rows
   * exist (no work to do).
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
          AND participants_metadata IS NOT NULL
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
   * Backfill a single bounded time window. Streams candidates with a keyset
   * cursor (time, id) DESC so a dense window doesn't strand later pages, then
   * fans the distinct identifiers it discovers into one prefilter query +
   * one GraphIngestService.ingest call per page.
   */
  private async backfillWindow(
    userId: string,
    windowStart: Date,
    windowEnd: Date,
    limit: number,
  ): Promise<{
    examined: number;
    identifiersSeen: number;
    identifiersExisting: number;
    peopleCreated: number;
    identifiersIndexed: number;
    errors: string[];
  }> {
    let examined = 0;
    let identifiersSeen = 0;
    let identifiersExisting = 0;
    let peopleCreated = 0;
    let identifiersIndexed = 0;
    const errors: string[] = [];

    let cursorTime = windowEnd.toISOString();
    let cursorId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

    for (;;) {
      const candidates: CandidateRow[] = await this.dataSource.query(
        `SELECT id, time, participants_metadata
           FROM ci.communications
          WHERE user_id = $1
            AND time >= $2
            AND time < $3
            AND participants_metadata IS NOT NULL
            AND (from_entity_id IS NULL OR to_entity_ids IS NULL OR cardinality(to_entity_ids) = 0)
            AND (time, id) < ($5::timestamptz, $6::uuid)
          ORDER BY time DESC, id DESC
          LIMIT $4`,
        [userId, windowStart.toISOString(), windowEnd.toISOString(), limit, cursorTime, cursorId],
      );

      if (candidates.length === 0) {
        break;
      }

      // Collect every distinct identifier this page surfaces. First-seen raw
      // participant wins the display name slot — we don't crawl every row to
      // pick a "best" name; the importer's later contact push (or a Concept
      // rewrite job) is where real names land.
      const seenByComposite = new Map<string, SeenIdentifier>();

      for (const row of candidates) {
        examined += 1;
        const meta = row.participants_metadata ?? {};
        const collect = (raw: string | null) => {
          const key = classify(raw);
          if (key == null) {
            return;
          }

          const composite = `${key.kind}:${key.valueNormalized}`;
          if (seenByComposite.has(composite)) {
            return;
          }

          seenByComposite.set(composite, { key, rawName: (raw ?? '').trim() });
        };

        collect(readString(meta.from));
        for (const raw of readStringArray(meta.to)) {
          collect(raw);
        }

        for (const raw of readStringArray(meta.cc)) {
          collect(raw);
        }

        for (const raw of readStringArray(meta.bcc)) {
          collect(raw);
        }
      }

      identifiersSeen += seenByComposite.size;

      if (seenByComposite.size > 0) {
        // Prefilter against the identifier index in ONE query so we only
        // re-ingest the genuinely new identifiers. GraphIngestService.ingest is
        // idempotent on its own (linked-key + identifier-unique-index), so
        // skipping the prefilter would still be correct — just N findOne
        // round-trips for already-seen entities. The prefilter trades one query
        // for that bulk savings on re-runs.
        const allKeys = [...seenByComposite.values()].map((s) => s.key);
        const existing = await this.entityIdentifierService.findEntityIdsByIdentifiers(userId, allKeys);

        const newEntities: GraphEntityInputDto[] = [];
        for (const [composite, seen] of seenByComposite) {
          if (existing.has(composite)) {
            identifiersExisting += 1;
            continue;
          }

          // properties.{emails|phones} is what GraphIngestService.indexIdentifiers
          // reads to populate ci.entity_identifiers; the value rides as a single-
          // element string[] (the canonical contract shape) so the same path the
          // contact importer uses lights up.
          const propertyKey = seen.key.kind === 'email' ? 'emails' : 'phones';
          newEntities.push({
            key: `${STUB_SOURCE_SYSTEM}:${seen.key.kind}:${seen.key.valueNormalized}`,
            entityType: 'Person',
            // Prefer the raw participant string for display (often carries a
            // "Name <addr>" header); fall back to the normalized value when the
            // raw was empty/whitespace-only.
            name: seen.rawName.length > 0 ? seen.rawName : seen.key.valueNormalized,
            sourceSystem: STUB_SOURCE_SYSTEM,
            properties: { [propertyKey]: [seen.key.valueNormalized] },
          });
        }

        if (newEntities.length > 0) {
          const result = await this.graphIngestService.ingest(toServiceContext({ userId }), {
            entities: newEntities,
            relationships: [],
          });

          peopleCreated += result.entitiesProcessed;
          // result.entitiesProcessed counts every entity ingested (including a
          // no-op resolve to an existing linked-key row), so it is an upper bound
          // on stub creations. identifiersIndexed comes from a follow-up count of
          // ci.entity_identifiers rows whose entity_id is one of the newly-
          // returned ones — but indexIdentifiers swallows its own count, so we
          // mirror it instead: every newEntities item contributes exactly one
          // identifier row (we collected one (kind,value) per entity).
          identifiersIndexed += newEntities.length;
          errors.push(...result.errors);
        }
      }

      const last = candidates[candidates.length - 1];
      cursorTime = last.time instanceof Date ? last.time.toISOString() : String(last.time);
      cursorId = last.id;

      if (candidates.length < limit) {
        break;
      }
    }

    return {
      examined,
      identifiersSeen,
      identifiersExisting,
      peopleCreated,
      identifiersIndexed,
      errors,
    };
  }
}

/**
 * Classify a raw participant string as an email or phone and normalize it with
 * the SAME shared rule the identifier index uses. Mirrors the helper in
 * CommunicationLinkBackfillService — kept inline because the two services must
 * agree byte-for-byte on what counts as a match.
 */
function classify(raw: string | null): IdentifierKey | null {
  if (raw == null) {
    return null;
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const kind: IdentifierKind = trimmed.includes('@') ? 'email' : 'phone';
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

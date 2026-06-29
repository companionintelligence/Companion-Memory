import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { EntityIdentifierService, type IdentifierKey, normalizeIdentifier } from '@ci/domains/graph';

/** Default cap on candidate rows examined per page (bounds memory + a query). */
const DEFAULT_PAGE_SIZE = 2000;

/**
 * Per-page progress snapshot for {@link EventParticipantBackfillOptions.onProgress}.
 * All counts are CUMULATIVE running totals at the point the most recent page's
 * UPDATE committed. `pagesDone` is the numerator; there is no `pagesTotal` —
 * candidate-count probing isn't worth a second filtered scan over `ci.events`,
 * so the streaming consumer shows an indeterminate "pages so far" indicator
 * until the final result line.
 */
export interface EventParticipantBackfillProgress {
  /** Candidate events examined so far (cumulative). */
  examined: number;
  /** Rows whose organizer_entity_id was filled so far (cumulative). */
  organizersLinked: number;
  /** Rows whose participant_entity_ids was filled so far (cumulative). */
  participantsLinked: number;
  /** Pages whose writes have committed so far. */
  pagesDone: number;
}

export interface EventParticipantBackfillOptions {
  /** Max candidate rows pulled per page (default 2000). */
  pageSize?: number;
  /**
   * Invoked once per page, AFTER that page's writes commit, with cumulative
   * counts. Optional; the synchronous return value is unchanged whether or not
   * this is supplied. Mirrors {@link CommunicationLinkBackfillOptions.onProgress}
   * so the controller's NDJSON streaming wrapper is uniform across backfills.
   */
  onProgress?: (partial: EventParticipantBackfillProgress) => void;
}

export interface EventParticipantBackfillResult {
  /** Candidate events examined (had an unset link + relevant metadata). */
  examined: number;
  /** Rows whose organizer_entity_id was filled. */
  organizersLinked: number;
  /** Rows whose participant_entity_ids was filled. */
  participantsLinked: number;
  /** Pages processed. */
  pages: number;
}

interface CandidateRow {
  event_id: string;
  start_time: Date;
  organizer_entity_id: string | null;
  participant_entity_ids: string[] | null;
  metadata: Record<string, unknown> | null;
}

/**
 * RE-RUNNABLE people-linking backfill for `ci.events`.
 *
 * For every event missing its graph links, parse the raw organizer + attendee
 * emails out of `event.metadata` and resolve them against `ci.entity_identifiers`
 * (the email/phone -> entity_id index populated on Person graph ingest):
 *   - organizer (`metadata.organizerEmail` and friends) -> `organizer_entity_id`
 *     (when NULL)
 *   - attendees (`metadata.participants[].email` and friends, an array)
 *     -> `participant_entity_ids` (when NULL/empty)
 *
 * No match leaves the column NULL — it never creates stub Person entities, and
 * it only ever writes previously-NULL/empty columns, so re-running is a no-op
 * for already-linked rows. Safe to re-run as new Person identifiers arrive.
 *
 * The metadata key parser is intentionally lenient: the live Google/Outlook
 * calendar transformers write `organizerEmail` and `participants: Array<{email}>`,
 * but the importer flattens timeline items from many sources into ci.events
 * with varying shapes (the [[import-mapping-flattening]] note). We accept the
 * camelCase keys as primary and fall back to PascalCase / `from` / `attendees`
 * / `to` so a non-calendar source carrying `metadata.From` still links its
 * sender — sources with no participant data are simply a no-op.
 *
 * Unlike the communications hypertable, ci.events is a plain table, so the
 * scan doesn't need TimescaleDB chunk-safety windowing — a single keyset
 * pagination on (start_time, event_id) DESC against the existing
 * `events_user_time_idx` is enough. The PK is `event_id`, so the per-page
 * UPDATE joins on (user_id, event_id) and stays scoped to the candidate rows.
 *
 * Operator-invoked via POST /api/maintenance/link-events (see
 * MaintenanceController) — never auto-run, never in the hot ingest path.
 */
@Injectable()
export class EventParticipantBackfillService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly entityIdentifierService: EntityIdentifierService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(EventParticipantBackfillService.name);
  }

  async backfill(
    userId: string,
    options: EventParticipantBackfillOptions = {},
  ): Promise<EventParticipantBackfillResult> {
    const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;

    let examined = 0;
    let organizersLinked = 0;
    let participantsLinked = 0;
    let pages = 0;

    // Keyset cursor (start_time, event_id) DESC against events_user_time_idx.
    // Seed past the max so the first page's strict `<` predicate matches every
    // candidate row; subsequent pages advance to the page's oldest (time, id).
    let cursorTime = '9999-12-31T23:59:59.999Z';
    let cursorId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

    for (;;) {
      const candidates: CandidateRow[] = await this.dataSource.query(
        `SELECT event_id, start_time, organizer_entity_id, participant_entity_ids, metadata
           FROM ci.events
          WHERE user_id = $1
            AND (
              organizer_entity_id IS NULL
              OR participant_entity_ids IS NULL
              OR cardinality(participant_entity_ids) = 0
            )
            AND (
              metadata ? 'organizerEmail'
              OR metadata ? 'organizer_email'
              OR metadata ? 'organizer'
              OR metadata ? 'Organizer'
              OR metadata ? 'from'
              OR metadata ? 'From'
              OR metadata ? 'participants'
              OR metadata ? 'Participants'
              OR metadata ? 'attendees'
              OR metadata ? 'Attendees'
              OR metadata ? 'to'
              OR metadata ? 'To'
            )
            AND (start_time, event_id) < ($3::timestamptz, $4::uuid)
          ORDER BY start_time DESC, event_id DESC
          LIMIT $2`,
        [userId, pageSize, cursorTime, cursorId],
      );

      if (candidates.length === 0) {
        break;
      }

      // Collect every distinct identifier this page needs, then resolve them
      // all in a single query (one round-trip for the whole page).
      const keys: IdentifierKey[] = [];
      const seen = new Set<string>();
      const addEmail = (raw: string | null) => {
        const key = classifyEmail(raw);
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
        const meta = row.metadata ?? {};
        if (row.organizer_entity_id == null) {
          addEmail(readOrganizerEmail(meta));
        }

        if (row.participant_entity_ids == null || row.participant_entity_ids.length === 0) {
          for (const raw of readParticipantEmails(meta)) {
            addEmail(raw);
          }
        }
      }

      const resolved = await this.entityIdentifierService.findEntityIdsByIdentifiers(userId, keys);

      const lookup = (raw: string | null): string | null => {
        const key = classifyEmail(raw);
        if (key == null) {
          return null;
        }

        return resolved.get(`${key.kind}:${key.valueNormalized}`) ?? null;
      };

      // Resolve every candidate in memory, collecting the writes, then apply
      // them as ONE set-based UPDATE per page. The PK join is (user_id, event_id);
      // the NULL guards in the UPDATE's SET keep it idempotent on re-runs.
      const updIds: string[] = [];
      const updOrganizerIds: (string | null)[] = [];
      const updParticipantIds: (string | null)[] = []; // jsonb array of uuids, or null

      for (const row of candidates) {
        examined += 1;
        const meta = row.metadata ?? {};

        const organizerId = row.organizer_entity_id == null ? lookup(readOrganizerEmail(meta)) : null;

        let participantIds: string[] | null = null;
        if (row.participant_entity_ids == null || row.participant_entity_ids.length === 0) {
          const ids = readParticipantEmails(meta)
            .map((raw) => lookup(raw))
            .filter((id): id is string => id != null);
          participantIds = ids.length > 0 ? unique(ids) : null;
        }

        if (organizerId != null || participantIds != null) {
          updIds.push(row.event_id);
          updOrganizerIds.push(organizerId);
          updParticipantIds.push(participantIds != null ? JSON.stringify(participantIds) : null);

          if (organizerId != null) {
            organizersLinked += 1;
          }

          if (participantIds != null) {
            participantsLinked += 1;
          }
        }
      }

      if (updIds.length > 0) {
        // One set-based UPDATE for the whole page. `participant_ids` rides as
        // jsonb (a uuid[][] can't be unnested element-wise); each row's array
        // is rebuilt in SQL. The CASE/COALESCE guards make re-runs idempotent
        // even if a row was linked between SELECT and UPDATE.
        await this.dataSource.query(
          `UPDATE ci.events e
              SET organizer_entity_id = COALESCE(u.organizer_id, e.organizer_entity_id),
                  participant_entity_ids = CASE
                                             WHEN u.participant_ids IS NOT NULL
                                                  AND (e.participant_entity_ids IS NULL
                                                       OR cardinality(e.participant_entity_ids) = 0)
                                             THEN u.participant_ids
                                             ELSE e.participant_entity_ids
                                           END
             FROM (
               SELECT t.id,
                      t.organizer_id,
                      CASE
                        WHEN t.participants_json IS NULL THEN NULL
                        ELSE ARRAY(SELECT jsonb_array_elements_text(t.participants_json))::uuid[]
                      END AS participant_ids
                 FROM unnest($2::uuid[], $3::uuid[], $4::jsonb[])
                        AS t(id, organizer_id, participants_json)
             ) u
            WHERE e.user_id = $1
              AND e.event_id = u.id`,
          [userId, updIds, updOrganizerIds, updParticipantIds],
        );
      }

      pages += 1;

      // This page's writes have committed (the UPDATE above awaited), so emit
      // cumulative progress. Done AFTER the commit so a streaming consumer
      // never sees progress ahead of durable state.
      options.onProgress?.({
        examined,
        organizersLinked,
        participantsLinked,
        pagesDone: pages,
      });

      // Advance the keyset cursor to the oldest row in this page. Strictly
      // monotonic (start_time DESC, event_id DESC), so progress is guaranteed
      // and the loop terminates; a short page means we've drained the table.
      const last = candidates[candidates.length - 1];
      cursorTime = last.start_time instanceof Date ? last.start_time.toISOString() : String(last.start_time);
      cursorId = last.event_id;

      if (candidates.length < pageSize) {
        break;
      }
    }

    this.logger.log('Event participant backfill complete', {
      userId,
      examined,
      organizersLinked,
      participantsLinked,
      pages,
    });

    return { examined, organizersLinked, participantsLinked, pages };
  }
}

/**
 * Pull a single organizer email out of a metadata blob. The live Google/Outlook
 * transformers write `organizerEmail` (a plain string); importer-derived events
 * may carry `organizer` as a string or `{email, name}` object, or use the
 * email-style `from` key. Order matches priority: the cleanest, most specific
 * key wins.
 */
function readOrganizerEmail(meta: Record<string, unknown>): string | null {
  const direct = readString(meta.organizerEmail) ?? readString(meta.organizer_email);
  if (direct != null) {
    return direct;
  }

  const nested = extractEmail(meta.organizer) ?? extractEmail(meta.Organizer);
  if (nested != null) {
    return nested;
  }

  return readString(meta.from) ?? readString(meta.From);
}

/**
 * Pull every attendee email out of a metadata blob. The live calendar
 * transformers write `participants: Array<{email, name, responseStatus, ...}>`.
 * Other shapes accepted: bare string arrays, PascalCase keys, the email-side
 * `attendees`/`to` keys. Duplicates within a single source array are preserved
 * (the caller dedupes by normalized identifier).
 */
function readParticipantEmails(meta: Record<string, unknown>): string[] {
  const sources: unknown[] = [
    meta.participants,
    meta.Participants,
    meta.attendees,
    meta.Attendees,
    meta.to,
    meta.To,
  ];

  const out: string[] = [];
  for (const src of sources) {
    if (!Array.isArray(src)) {
      continue;
    }

    for (const item of src) {
      const email = extractEmail(item);
      if (email != null) {
        out.push(email);
      }
    }
  }

  return out;
}

/**
 * Coerce a participant entry (string OR object) into an email string. Handles
 * the Google shape ({email, name, ...}), the Outlook Graph shape
 * ({emailAddress: {address, name}}) defensively in case a non-transformer
 * source dumps the raw Graph payload into metadata, and the bare-string case.
 */
function extractEmail(item: unknown): string | null {
  if (typeof item === 'string') {
    return item;
  }

  if (item == null || typeof item !== 'object') {
    return null;
  }

  const obj = item as Record<string, unknown>;

  const direct = readString(obj.email) ?? readString(obj.Email) ?? readString(obj.address);
  if (direct != null) {
    return direct;
  }

  const nested = obj.emailAddress;
  if (nested != null && typeof nested === 'object') {
    const address = (nested as Record<string, unknown>).address;
    if (typeof address === 'string' && address.length > 0) {
      return address;
    }
  }

  return null;
}

/**
 * Calendar metadata only carries emails (organizer + attendees are always
 * addressed by email, never phone), so we normalize as 'email' unconditionally
 * — calling the shared `normalizeIdentifier` so this stays byte-identical to
 * what GraphIngestService writes into ci.entity_identifiers. A raw without an
 * '@' is dropped (no match possible).
 */
function classifyEmail(raw: string | null): IdentifierKey | null {
  if (raw == null) {
    return null;
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0 || !trimmed.includes('@')) {
    return null;
  }

  const valueNormalized = normalizeIdentifier('email', trimmed);
  if (valueNormalized == null) {
    return null;
  }

  return { kind: 'email', valueNormalized };
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? value : null;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

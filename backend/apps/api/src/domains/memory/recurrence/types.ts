/**
 * Read-time RRULE expansion — the shapes the four steps hand each other.
 *
 * Nothing here is persisted. `ci.events` holds ONE row per recurring series
 * (the Google connector fetches `singleEvents=false` on purpose, and the .ics
 * importer deliberately does not expand either), so every surface that reads
 * committed time — the schedule grid, the planner's gap solver, peer free/busy
 * — used to see a weekly standup exactly once. These types describe the
 * occurrences computed for the duration of one read and thrown away.
 *
 * Writing them back is not an option: an occurrence's natural key is
 * `<uid>#<instant>`, which is the SAME namespace a real "changed this one
 * occurrence" override syncs into, so materialized rows would collide with
 * `events_source_identity_uniq` the moment the user edits one.
 */

/**
 * One series' rule, reduced to what the expander needs and nothing else.
 *
 * The instants are split deliberately. `dtstartFloating` is a WALL CLOCK
 * rendered as a fake-UTC `Date` — the series' own local time with no zone
 * attached — because that is the only domain in which "every Monday at 09:00"
 * survives a DST transition. `exdates`/`rdates` are real instants, because RFC
 * 5545 lets each of them carry its own TZID and the only spelling they all
 * converge on is the instant itself.
 */
export interface RecurrenceSpec {
  /** DTSTART's wall clock in {@link timeZone}, rendered as fake UTC. */
  dtstartFloating: Date;
  /** Fixed occurrence length; null when the master has no `end_time`. */
  durationMs: number | null;
  /**
   * Set INSTEAD of {@link durationMs} for all-day and multi-day series: the end
   * is re-derived from the local calendar each occurrence, so a 24h event on a
   * 23h local day still ends at midnight rather than 23:00.
   */
  wholeLocalDays: number | null;
  /** IANA zone the rule is walked in. Forced to `UTC` for all-day series. */
  timeZone: string;
  /** Where {@link timeZone} came from — surfaced on every occurrence so drift is visible. */
  timeZoneSource: 'series' | 'pattern' | 'user' | 'server' | 'utc-allday';
  /** The RRULE's value, `RRULE:` prefix stripped, with any UTC `UNTIL` rewritten floating. */
  rruleLine: string;
  /** EXDATE instants (all TZID/VALUE spellings already converged). */
  exdates: Date[];
  /** RDATE instants, likewise. */
  rdates: Date[];
  isAllDay: boolean;
}

/** One computed occurrence, before it is dressed up as an {@link Event}. */
export interface OccurrenceSpec {
  /** `ci.events.event_id` of the series master this came from. */
  seriesId: string;
  /** Synthetic, deterministic uuidv5 — see occurrenceIdentity.ts for why not `<uuid>@<instant>`. */
  occurrenceId: string;
  startTime: Date;
  endTime: Date | null;
  /** RECURRENCE-ID spelling of {@link startTime} (`YYYYMMDDTHHMMSSZ`). */
  recurrenceInstant: string;
  /** `source_id` this occurrence WOULD have if the user had edited it — the suppression key. */
  overrideSourceId: string;
  timeZoneSource: RecurrenceSpec['timeZoneSource'];
}

export interface ExpansionWindow {
  from: Date;
  to: Date;
}

/**
 * Every ceiling the expander answers to. They exist because an RRULE with no
 * COUNT and no UNTIL is infinite by construction, and because a rule can be
 * unsatisfiable — the generator then walks to year 9999 producing nothing.
 */
export interface ExpansionLimits {
  /** Occurrences one series may contribute to a single read. */
  maxOccurrencesPerSeries: number;
  /** Dates the generator may produce for one series, in-window or not. */
  maxIterations: number;
  /** Occurrences one `findInRange` call may synthesize across all series. */
  maxTotalOccurrences: number;
}

/**
 * Why a series contributed less than the calendar shows — the calendar surface
 * cannot render these yet, but they are the difference between "there is no
 * standup" and "we stopped counting", so they are reported rather than dropped.
 */
export type ExpansionDiagnostic =
  | { kind: 'unparseable'; seriesId: string; reason: string }
  | { kind: 'sub-daily-rejected'; seriesId: string; freq: string }
  | { kind: 'truncated'; seriesId: string; limit: keyof ExpansionLimits }
  | { kind: 'unfederated-identity'; seriesId: string };

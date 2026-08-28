import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

import { PIPELINE_QUEUES } from '../../constants';
import type { Stage, StageResult, StageSource } from '../../types';
import { STAGE_VERSIONS, type StageVersion } from '../../versions';

/**
 * This stage's id.
 *
 * Declared here ahead of its `STAGE_IDS` entry, exactly as `INDEX_EMBED_STAGE_ID`
 * and `ENRICH_GEOCODE_STAGE_ID` were: the central wiring (`constants.ts`,
 * `versions.ts`, `StageRegistry`, `stageProviders`) is one reviewable change and
 * this file is another. `__tests__/stageWiring.spec.ts` fails, by name, for as
 * long as the two are apart, which is the point of that file.
 *
 * IDS ARE PERMANENT — the id is the third component of `ci.pipeline_state`'s
 * primary key, so renaming it abandons every ledger row written under the old
 * name and re-repairs the whole corpus under the new one. For a stage that MOVES
 * DATES ON THE USER'S TIMELINE that is not an academic cost.
 */
export const CLEAN_TEMPORAL_REPAIR_STAGE_ID = 'clean.temporal_repair';

/** The ledger `entity_type` this stage records under. */
const ENTITY_TYPE = 'event';

// ---------------------------------------------------------------------------
// The version
// ---------------------------------------------------------------------------

/**
 * Generation of the CLASSIFICATION AND REPAIR rules — {@link SOURCE_TIME_SPECS},
 * the classes in {@link classifyEventTime}, and the two vocabularies
 * {@link TIME_SOURCES} / {@link TIME_PRECISIONS}.
 *
 * Bump it in the same commit that edits any of them. Adding one line to
 * `SOURCE_TIME_SPECS` is the common case and it is exactly the case a bump is
 * for: every row of that source is currently recorded
 * `skipped: source_time_spec_missing`, and only `stage_version < $current`
 * re-opens a skip.
 */
export const TEMPORAL_RULE_GENERATION = 2;

/**
 * The stage version.
 *
 * One term today, spelled as a derivation for the reason `GeocodeStage` spells
 * its version as one: this file is written before `versions.ts` learns the id,
 * and `stageVersion(id)` THROWS on a missing entry, so a stage that cannot yet
 * be declared centrally cannot use it. When a second generation appears (the
 * retained-payload reparse of §6.6, which needs `ci.source_records` and
 * therefore Phase 6) it joins as `A + B - 1`, offset so both-at-1 gives 1
 * because `versions.ts` refuses a version below 1.
 *
 * A SUM, never a hash: a sum is monotone in each term so the version can only go
 * UP, and `versions.ts` documents at length why a version that goes down leaves
 * every processed row looking stale-*forward* and permanently invisible.
 */
export const TEMPORAL_REPAIR_VERSION = TEMPORAL_RULE_GENERATION;

/**
 * The version this stage reports, cross-checked against `STAGE_VERSIONS`.
 *
 * `StageRegistry.assertConsistent` requires `stage.version` to equal
 * `STAGE_VERSIONS[id]`. A missing entry is NOT an error here — this file is
 * imported by its own spec before the central declarations land — but a
 * DISAGREEING entry is, and it throws here, where the fix is one line.
 *
 * `versions` is a parameter only so a test can prove the cross-check without
 * mutating the production declaration. Only the literal form is checked, for the
 * reason `PositionReverseStage` gives: the thunk for this stage could only be
 * this very function, so invoking one here would recurse forever.
 */
export function temporalRepairStageVersion(versions: Record<string, StageVersion> = STAGE_VERSIONS): number {
  const declared = versions[CLEAN_TEMPORAL_REPAIR_STAGE_ID];

  if (typeof declared === 'number' && declared !== TEMPORAL_REPAIR_VERSION) {
    throw new Error(
      `STAGE_VERSIONS["${CLEAN_TEMPORAL_REPAIR_STAGE_ID}"] declares ${declared} but the stage ` +
        `derives ${TEMPORAL_REPAIR_VERSION} from TEMPORAL_RULE_GENERATION ` +
        `(${TEMPORAL_RULE_GENERATION}). Bumping a generation is only half the change: update ` +
        `versions.ts in the same commit, or the two disagree about which rows have already been ` +
        `repaired — and a date this stage moved is a date the user sees move.`,
    );
  }

  return TEMPORAL_REPAIR_VERSION;
}

// Run at module load rather than at the first sweep, for the reason every other
// derived-version stage does: the earliest failure is the cheapest one.
temporalRepairStageVersion();

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

/**
 * Where the sweep looks for candidates, and which of those rows this stage
 * APPLIES to.
 *
 * ── READ THIS BEFORE ADDING `s.time_source IS NULL` ────────────────────────
 *
 * `time_source`, `time_precision`, `start_time_original` and `end_time_original`
 * are this stage's OUTPUT. A predicate over any of them re-creates the exact
 * ratchet the ledger exists to remove: the row would leave the candidate set the
 * moment the stage wrote anything, and bumping
 * {@link TEMPORAL_RULE_GENERATION} — the only mechanism this subsystem provides
 * for improving a repair — could never bring it back. Worse than for most
 * stages, because the rows this stage gets WRONG are precisely the ones it wants
 * to revisit: a row marked `time_precision='ambiguous'` today is a row a better
 * rule should re-examine tomorrow.
 *
 * `StageRegistry.assertApplicabilityPredicate` catches the sibling mistake
 * (reaching into `ci.pipeline_state` from here). Nothing can catch this one,
 * which is why it is written out at this length.
 *
 * What the predicate DOES say is what a row IS: a live event. `is_deleted` is
 * applicability, not completion — `ci.events` is soft-deleted, and repairing a
 * tombstone's timestamp changes nothing anybody reads.
 *
 * Note what is NOT filtered here: `source_system`. A row from a source with no
 * {@link SOURCE_TIME_SPECS} entry is still swept, and recorded
 * `skipped: source_time_spec_missing` — countable, so the coverage endpoint
 * answers "which of my sources still have unexamined timestamps?" with a number
 * and a list instead of a silence. Filtering them out in SQL would make those
 * rows invisible rather than pending.
 */
export const TEMPORAL_REPAIR_SOURCE: StageSource = {
  schema: 'ci',
  table: 'events',
  idColumn: 'event_id',
  userColumn: 'user_id',
  predicate: `COALESCE(s.is_deleted, false) = false`,
};

// ---------------------------------------------------------------------------
// The provenance vocabulary
// ---------------------------------------------------------------------------

/**
 * `ci.events.time_source` — WHERE the stored instant came from. This is the
 * column that makes a repaired timestamp distinguishable from an original one.
 *
 * ── Why a column and not a derived fact ────────────────────────────────────
 *
 * The rebuild plan's §6.6 answer is a `timestamp.inferred` row in
 * `ci.derived_facts`. **That table does not exist** (pipeline README, "What is
 * NOT built yet": `StageResult.confidence` and `.detail` are validated and then
 * DROPPED), and creating it is Phase 8's change, not this one. But even once it
 * exists the derived fact is the wrong home for THIS marker, for one reason:
 *
 * > every reader of a timestamp must see the marker, and the readers of a
 * > timestamp are the timeline, HBPE and RAG — all of which read
 * > `ci.events.start_time` directly.
 *
 * A provenance signal that lives in a table nobody joins is a signal that does
 * not exist. `GeocodeStage` makes the same call for `metadata.location_source`
 * and states the same honest cost: a derived-fact row is where two writers'
 * assertions coexist and are RANKED, and a column is where exactly one writer's
 * answer lives. This stage has one writer per row, so the column is sufficient;
 * when `ci.derived_facts` lands, the fact row becomes the audit trail and this
 * column becomes its projection, which is what `promote.projection` is for.
 *
 * What makes the column safe is the pair of `*_original` columns beside it: the
 * pre-repair instant is PRESERVED, so the repair is undone by one UPDATE. That
 * is the difference between a correction and a destruction.
 */
export const TIME_SOURCES = {
  /** The source supplied this instant and it survived ingest intact. */
  SOURCE: 'source',
  /** A human typed it. Not derived from any import. */
  USER: 'user',
  /** THIS STAGE MOVED THE DATE. `start_time_original` holds what was here before. */
  REPAIRED: 'repaired',
  /**
   * Synthesized at import — the source supplied NO date and the transform
   * stamped a wall clock anyway. The instant is not evidence of anything and the
   * UI must not present it as one.
   */
  INGEST: 'ingest',
} as const;

export type TimeSource = (typeof TIME_SOURCES)[keyof typeof TIME_SOURCES];

/**
 * `ci.events.time_precision` — HOW MUCH of the stored instant is meaningful.
 *
 * `day` is the one that earns its keep: an all-day calendar event has no time of
 * day at all, and rendering its midnight as a time is how "June 15" becomes
 * "June 14, 5:00 PM" for a US-Pacific reader.
 */
export const TIME_PRECISIONS = {
  SECOND: 'second',
  MINUTE: 'minute',
  DAY: 'day',
  /** Parsed, but the correct interpretation could not be determined. */
  AMBIGUOUS: 'ambiguous',
  /** There was no source timestamp at all. */
  UNKNOWN: 'unknown',
} as const;

export type TimePrecision = (typeof TIME_PRECISIONS)[keyof typeof TIME_PRECISIONS];

// ---------------------------------------------------------------------------
// What each source's payload actually carries — DECLARED, not sniffed
// ---------------------------------------------------------------------------

/**
 * How to read one source system's retained `ci.events.metadata`.
 *
 * DECLARED per source, deliberately, and the pipeline's constants file gives the
 * general form of the argument: a rule that only exists as a string literal
 * discovered at runtime cannot be reviewed in a diff. The specific argument here
 * is stronger. Sniffing metadata for "something that looks like a date" over a
 * 324,044-row personal archive means a key that happens to parse — an order
 * number, a filename with a date in it, a `contentHash` that embeds one — silently
 * becomes the authority for when something in the user's life happened. Every key
 * this stage trusts is named here, by a human, per source.
 *
 * An UNDECLARED source is not a failure and not a guess: it is
 * `skipped: source_time_spec_missing`, which is countable and which a version
 * bump re-opens the moment a spec is added.
 */
export interface SourceTimeSpec {
  /**
   * `metadata` keys carrying the source's OWN timestamp string, in priority
   * order. Empty means the source retained none, so this stage can neither
   * confirm nor repair the stored instant.
   */
  readonly timestampKeys: readonly string[];

  /**
   * `metadata` keys carrying an IANA zone / TZID for a floating wall clock, in
   * priority order. Empty means the zone must come from the user.
   */
  readonly zoneKeys: readonly string[];

  /** `metadata` key naming the record kind within this source. */
  readonly kindKey: string | null;

  /**
   * Record kinds that HAVE NO SOURCE TIMESTAMP BY CONSTRUCTION.
   *
   * Not "we failed to find one" — "this kind of record does not have one". A
   * Google Maps saved place ("Home", "Work", "Gym") is a bookmark; it never
   * happened at a time. Whatever is in `start_time` for such a row was minted by
   * the transform.
   */
  readonly undatedKinds: readonly string[];

  /**
   * True when this source's transform builds instants by interpreting a FLOATING
   * wall clock (no offset) as UTC. Then, and only then, the original wall clock
   * is recoverable from the stored instant without the raw payload: it is the
   * stored instant read in UTC.
   *
   * `google_calendar` is the documented case, and the code is in the repo:
   * `TransformGoogleCalendar.extractEventDetails` takes
   * `event.start.dateTime || event.start.date` and drops `event.start.timeZone`
   * on the floor — the field is declared on its `CalendarEvent` interface and
   * never read — then `parseDateTime` calls `new Date(str)`. For the date-only
   * form (`"2020-06-15"`, which is also how `isAllDayEvent` is decided, by the
   * absence of a `T`) ECMA-262 specifies UTC, so a US-Pacific user's June 15
   * all-day event is stored at `2020-06-15T00:00:00Z` and renders as June 14,
   * 17:00. That is recoverable, and {@link classifyEventTime} recovers it.
   */
  readonly floatingAsUtc: boolean;
}

function spec(overrides: Partial<SourceTimeSpec> = {}): SourceTimeSpec {
  return {
    timestampKeys: [],
    zoneKeys: [],
    kindKey: null,
    undatedKinds: [],
    floatingAsUtc: false,
    ...overrides,
  };
}

/**
 * The declared specs, keyed by `ci.events.source_system`.
 *
 * Every entry below was verified against the real corpus (`ci.events`, 324,044
 * rows) or against the transform in this repo that writes it. A source is added
 * here only when someone has read the payload; the ones deliberately NOT added
 * are listed under {@link UNSPECIFIED_SOURCE_REASON}.
 */
export const SOURCE_TIME_SPECS: Readonly<Record<string, SourceTimeSpec>> = {
  /**
   * `TransformGoogleCalendar`. No timestamp key: the transform's `metadata`
   * carries `connectionId`, the organizer, the participants and the raw event's
   * id/summary/status — and not the start string, and not `start.timeZone`. So
   * confirmation is impossible and the ONLY repairable class is the all-day one,
   * which needs no raw payload (see {@link SourceTimeSpec.floatingAsUtc}).
   */
  google_calendar: spec({ zoneKeys: ['timeZone', 'timezone', 'TZID'], floatingAsUtc: true }),

  /**
   * `TransformOutlookCalendar` carries the same shape (`start.timeZone` declared
   * and unused) and is included on the strength of the transform, not of corpus
   * rows — there are none on this appliance.
   */
  outlook_calendar: spec({ zoneKeys: ['timeZone', 'timezone', 'TZID'], floatingAsUtc: true }),

  /**
   * CI-Import-Tools Amazon orders. `Order Date` is retained verbatim and carries
   * an explicit `Z` (verified: 2,147 of 2,777 rows), so this source can be
   * CONFIRMED — the one source in the corpus where the stored instant can be
   * checked against the source's own string rather than merely labelled.
   */
  amazon: spec({ timestampKeys: ['Order Date'] }),

  /**
   * CI-Import-Tools Google Maps. Two record kinds share the source system and
   * only one of them is dated:
   *
   *  - `place_review` — a review has a real date. It is not retained in
   *    `metadata`, so this stage can only label it.
   *  - `labeled_place` — a SAVED PLACE. "Home", "Work", "Gym". It never happened.
   *    All five on this appliance carry `start_time = 2026-08-08T23:42:37Z`, one
   *    identical wall clock from the import run, which puts them at the top of
   *    the user's timeline dated today. That is the bug this stage exists to
   *    stop lying about, and it is not repairable — there is no date to recover.
   *    It is MARKABLE, which is the whole difference between "the UI says
   *    today" and "the UI says date unknown".
   */
  google_maps_places: spec({ kindKey: 'Kind', undatedKinds: ['labeled_place'] }),

  /**
   * Reddit. Same shape as `google_maps_places`: dated and undated kinds share
   * one source system, and the undated ones are AFFILIATIONS rather than
   * events — `moderated_subreddit` / `subscribed_subreddit` say "I moderate
   * r/bitscoop", a piece of current state that never happened at an instant.
   * `RedditFileImporter.pushSubreddit` pushes them with `timestamp: undefined`
   * (moderated_subreddits.csv is `subreddit` only — there is no date in the
   * file to lose), and the push's affiliation branch keeps them on the timeline
   * anyway, so `start_time` is the createdAt fallback: the import wall clock.
   * Both rows on this appliance carry the identical 2026-08-21T00:43:50.949Z.
   *
   * Not repairable — nothing to recover — but markable, which is the whole
   * difference between the timeline claiming a subreddit was moderated today
   * and the UI saying the date is unknown.
   *
   * The dated kinds of the same source (`post`, `comment`, `message`,
   * `purchase`, `announcement`) are untouched by this: reddit.ts parses real
   * dates for all of them, and only the two kinds listed here are Class 1.
   */
  reddit: spec({ kindKey: 'Kind', undatedKinds: ['moderated_subreddit', 'subscribed_subreddit'] }),
};

/**
 * Why the corpus's four remaining sources are NOT in {@link SOURCE_TIME_SPECS}.
 *
 * `google_voice` (309,689 rows), `twitter` (5,873), `whatsapp` (5,329) and
 * `uber` (278) all retain a `contentHash`, and for `whatsapp` and `uber` that
 * hash HAPPENS to embed an ISO instant
 * (`uber|2026-01-25T09:02:52.000Z|40 Berkeley St…`). Parsing a timestamp out of
 * an opaque idempotency key would work today and would silently re-date the
 * corpus the day the importer changes the key format — a failure with no
 * error, no dead letter and no coverage number that looks wrong, i.e. exactly
 * the class of defect this subsystem exists to delete. The correct source is
 * `ci.source_records.payload`, which is Phase 6.
 *
 * (`twitter` ids are Snowflakes and DO carry a trustworthy millisecond
 * timestamp. That is a real second opinion and it belongs in its own generation
 * with its own tests, not smuggled into this one.)
 */
export const UNSPECIFIED_SOURCE_REASON = 'source_time_spec_missing';

// ---------------------------------------------------------------------------
// Time-zone arithmetic, on the platform's own tz database
// ---------------------------------------------------------------------------

/** A wall clock with no zone attached — the thing a floating date-time is. */
export interface WallClock {
  year: number;
  /** 1-12, as humans write it. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

/**
 * Formatters are expensive to construct and this runs per row, so they are
 * memoised per zone. The map is unbounded in principle and bounded in practice
 * by the number of IANA zones a personal archive mentions.
 */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = FORMATTERS.get(timeZone);

  if (cached != null) {
    return cached;
  }

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  FORMATTERS.set(timeZone, formatter);

  return formatter;
}

/**
 * The only zone names accepted without an `Area/Location` shape.
 *
 * Both denote a fixed zero offset and neither is ambiguous.
 */
const UNAMBIGUOUS_FIXED_ZONES: ReadonlySet<string> = new Set(['UTC', 'GMT']);

/**
 * Is this a zone that names ONE place, and that Node's bundled tz database
 * recognises?
 *
 * ── Why the `Area/Location` requirement, and not just "does ICU accept it" ──
 *
 * ICU accepts bare abbreviations and resolves each to one arbitrary zone,
 * silently. Measured on this appliance's Node:
 *
 * ```
 * PST → America/Los_Angeles   CST → America/Chicago   (not China)
 * IST → Asia/Calcutta         (not Israel, not Ireland)
 * AST → America/Anchorage     (not Arabia, not Atlantic)
 * EST → America/Panama
 * ```
 *
 * That is EXACTLY the defect the rebuild plan §6.6 records in
 * `domains/etl/util.ts` — "a hand-rolled ~50-entry timezone-abbreviation table
 * ... mapping ambiguous ones to one arbitrary offset (`CST` → US Central, not
 * China; `AST` → Arabia, not Atlantic; `IST` → India, not Israel/Ireland)" —
 * reimplemented by ICU instead of by hand. Accepting it here would move a user's
 * dates by hours on the strength of a coin flip made inside a formatting
 * library, and it would look like a successful repair. An abbreviation is
 * therefore not a zone: it makes the row `time_precision = 'ambiguous'`, which
 * is the honest answer and which a later generation can improve on.
 *
 * A value with surrounding whitespace is rejected rather than trimmed, so the
 * string this validates is byte-identical to the one
 * {@link zonedWallClockToUtc} will hand to `Intl`. Callers trim first.
 */
export function isKnownTimeZone(timeZone: string | null | undefined): timeZone is string {
  if (timeZone == null || timeZone.length === 0 || timeZone !== timeZone.trim()) {
    return false;
  }

  if (!timeZone.includes('/') && !UNAMBIGUOUS_FIXED_ZONES.has(timeZone)) {
    return false;
  }

  try {
    formatterFor(timeZone);

    return true;
  } catch {
    return false;
  }
}

/** The wall clock `timeZone` shows at `instant`. */
function wallClockIn(instant: Date, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);

    return part == null ? 0 : Number(part.value);
  };

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
    millisecond: instant.getUTCMilliseconds(),
  };
}

/** The wall clock UTC shows at `instant` — i.e. what `new Date(floating)` produced. */
export function wallClockInUtc(instant: Date): WallClock {
  return {
    year: instant.getUTCFullYear(),
    month: instant.getUTCMonth() + 1,
    day: instant.getUTCDate(),
    hour: instant.getUTCHours(),
    minute: instant.getUTCMinutes(),
    second: instant.getUTCSeconds(),
    millisecond: instant.getUTCMilliseconds(),
  };
}

function asUtcEpoch(wall: WallClock): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second, wall.millisecond);
}

/**
 * The instant at which `timeZone` shows `wall` — the operation the calendar
 * transform should have performed and did not.
 *
 * No dependency: Node ships the full IANA tz database behind `Intl`, so this is
 * a fixed-point solve rather than an offset table. Adding `luxon` or
 * `date-fns-tz` for four lines of arithmetic would put a second, separately
 * versioned copy of the tz database on the appliance.
 *
 * Two passes. The first guess uses the offset in force at the naive instant; if
 * that guess crosses a DST transition the second pass corrects it, because the
 * offset is then read at (very nearly) the true instant. A third pass can only
 * differ inside a SPRING-FORWARD GAP — a wall clock that does not exist, e.g.
 * 02:30 on a US spring-forward Sunday — where no answer is correct and this one
 * lands just after the transition. It never loops, which matters more than the
 * gap: this runs inside a slice.
 *
 * The AMBIGUOUS case (a fall-back hour that happens twice) resolves to the FIRST
 * occurrence, the conventional choice, and is one of the reasons an all-day
 * repair is recorded at `time_precision = 'day'` rather than `'second'`.
 */
export function zonedWallClockToUtc(wall: WallClock, timeZone: string): Date {
  const naive = asUtcEpoch(wall);

  const offsetAt = (epoch: number): number => asUtcEpoch(wallClockIn(new Date(epoch), timeZone)) - epoch;

  const firstGuess = naive - offsetAt(naive);

  return new Date(naive - offsetAt(firstGuess));
}

// ---------------------------------------------------------------------------
// Reading a retained source timestamp
// ---------------------------------------------------------------------------

/** A source timestamp string, parsed and characterised. */
export interface ParsedSourceTime {
  /** The raw string, verbatim, for the detail. */
  raw: string;
  /** Present only when the string carries an explicit offset or `Z`. */
  instant: Date | null;
  /** Present when the string is a floating wall clock (no offset). */
  wall: WallClock | null;
  precision: TimePrecision;
}

/** `…Z` or `…+05:30` / `…-0700`. */
const EXPLICIT_OFFSET = /(?:[Zz]|[+-]\d{2}:?\d{2})$/;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const FLOATING_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?$/;

/**
 * Characterise one retained source timestamp string.
 *
 * Deliberately narrow: ISO-8601-shaped strings only. A source whose timestamps
 * are not ISO-shaped needs a declared parser in its own generation, not a
 * `new Date(anything)` fallback — `new Date` accepts implementation-defined
 * garbage and silently produces host-local instants for exactly the inputs this
 * stage is trying to repair.
 */
export function parseSourceTime(raw: unknown): ParsedSourceTime | null {
  if (typeof raw !== 'string') {
    return null;
  }

  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return null;
  }

  const dateOnly = DATE_ONLY.exec(trimmed);

  if (dateOnly != null) {
    return {
      raw: trimmed,
      instant: null,
      wall: {
        year: Number(dateOnly[1]),
        month: Number(dateOnly[2]),
        day: Number(dateOnly[3]),
        hour: 0,
        minute: 0,
        second: 0,
        millisecond: 0,
      },
      precision: TIME_PRECISIONS.DAY,
    };
  }

  const floating = FLOATING_DATE_TIME.exec(trimmed);

  if (floating != null) {
    return {
      raw: trimmed,
      instant: null,
      wall: {
        year: Number(floating[1]),
        month: Number(floating[2]),
        day: Number(floating[3]),
        hour: Number(floating[4]),
        minute: Number(floating[5]),
        second: floating[6] == null ? 0 : Number(floating[6]),
        millisecond: floating[7] == null ? 0 : Number(floating[7].padEnd(3, '0')),
      },
      precision: floating[6] == null ? TIME_PRECISIONS.MINUTE : TIME_PRECISIONS.SECOND,
    };
  }

  if (EXPLICIT_OFFSET.test(trimmed)) {
    const instant = new Date(trimmed);

    // `new Date` answers `Invalid Date` rather than throwing, and NaN
    // propagates silently all the way into a timestamptz bind. Caught here.
    if (Number.isNaN(instant.getTime())) {
      return null;
    }

    return {
      raw: trimmed,
      instant,
      wall: null,
      precision: /:\d{2}(?:\.\d+)?(?:[Zz]|[+-])/.test(trimmed)
        ? TIME_PRECISIONS.SECOND
        : TIME_PRECISIONS.MINUTE,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// The classification — a pure function of one row
// ---------------------------------------------------------------------------

/** The slice row this stage reasons over. */
export interface TemporalRow {
  id: string;
  start_time: Date;
  end_time: Date | null;
  is_all_day: boolean | null;
  source_system: string | null;
  metadata: Record<string, unknown> | null;
  /** Set on a previous repair. Non-null means `start_time` has ALREADY moved. */
  start_time_original: Date | null;
}

/**
 * What a repaired row is written with, plus the ledger answer for it.
 *
 * `patch === null` means "record the outcome, write nothing".
 */
export interface TemporalDecision {
  result: StageResult;
  patch: TemporalPatch | null;
}

export interface TemporalPatch {
  /** The instant to store. Equal to the current one when only the label changes. */
  startTime: Date;
  endTime: Date | null;
  timeSource: TimeSource;
  timePrecision: TimePrecision;
  /** Which rule produced this, for the log line and the detail. */
  repairClass: string;
  /** Milliseconds the timeline entry moves. 0 for a label-only write. */
  shiftMs: number;
}

/**
 * How far a retained source instant may differ from the stored one before the
 * stored one is treated as WRONG rather than merely rounded.
 *
 * One second. Below that the difference is a transform truncating milliseconds;
 * above it, something re-interpreted the string.
 */
export const CONFIRMATION_TOLERANCE_MS = 1_000;

/**
 * Classify one row and decide what to write.
 *
 * Pure — no clock, no database, no config — so every class below is a table-driven
 * unit test rather than an integration fixture. That matters more here than for
 * most stages: the failure mode of a wrong rule is not an error, it is the
 * user's timeline quietly moving.
 *
 * `userZone` is `ci.users.timezone`, already validated by
 * {@link isKnownTimeZone}, or null when the user has not set a usable one.
 */
export function classifyEventTime(row: TemporalRow, userZone: string | null): TemporalDecision {
  if (row.start_time == null || Number.isNaN(row.start_time.getTime())) {
    // A NULL start_time is impossible (the column is NOT NULL) but a replayed
    // dead letter can carry ids whose rows have since been rewritten, and a NaN
    // date bound into a timestamptz parameter fails the whole slice.
    return { result: { outcome: 'skipped', reason: 'start_time_unreadable' }, patch: null };
  }

  const sourceSystem = row.source_system;

  if (sourceSystem == null || sourceSystem.trim().length === 0) {
    // Nothing imported this. A human typed it, so the instant is an assertion by
    // the only authority there is. Labelled, never moved.
    return {
      result: { outcome: 'done', detail: { repairClass: 'user_asserted', shiftMs: 0 } },
      patch: {
        startTime: row.start_time,
        endTime: row.end_time,
        timeSource: TIME_SOURCES.USER,
        timePrecision: TIME_PRECISIONS.MINUTE,
        repairClass: 'user_asserted',
        shiftMs: 0,
      },
    };
  }

  const sourceSpec = SOURCE_TIME_SPECS[sourceSystem];

  if (sourceSpec == null) {
    // Never guessed at. See UNSPECIFIED_SOURCE_REASON — this is a skip that a
    // version bump re-opens, which is the whole point of recording it as one.
    return {
      result: {
        outcome: 'skipped',
        reason: UNSPECIFIED_SOURCE_REASON,
        detail: { sourceSystem },
      },
      patch: null,
    };
  }

  const metadata = row.metadata ?? {};

  // ── Class 1: the record kind has no source date at all ───────────────────
  const kind = sourceSpec.kindKey == null ? null : stringAt(metadata, sourceSpec.kindKey);

  if (kind != null && sourceSpec.undatedKinds.includes(kind)) {
    // NOT repairable — there is no date to recover — but the marking IS the
    // repair the user needs: the UI can say "no date" instead of putting a
    // bookmark at the top of the timeline dated the day of the import.
    return {
      result: {
        outcome: 'done',
        detail: { repairClass: 'undated_ingest_stamp', kind, shiftMs: 0 },
      },
      patch: {
        startTime: row.start_time,
        endTime: row.end_time,
        timeSource: TIME_SOURCES.INGEST,
        timePrecision: TIME_PRECISIONS.UNKNOWN,
        repairClass: 'undated_ingest_stamp',
        shiftMs: 0,
      },
    };
  }

  // ── Class 2: the source's own string was retained ────────────────────────
  const retained = firstParsed(metadata, sourceSpec.timestampKeys);

  if (retained != null && retained.instant != null) {
    const shiftMs = retained.instant.getTime() - row.start_time.getTime();

    if (Math.abs(shiftMs) <= CONFIRMATION_TOLERANCE_MS) {
      // The strongest answer this stage can give: the source said so, and the
      // stored instant agrees. Nothing moves.
      return {
        result: { outcome: 'done', detail: { repairClass: 'source_confirmed', shiftMs: 0 } },
        patch: {
          startTime: row.start_time,
          endTime: row.end_time,
          timeSource: TIME_SOURCES.SOURCE,
          timePrecision: retained.precision,
          repairClass: 'source_confirmed',
          shiftMs: 0,
        },
      };
    }

    // The source's own unambiguous instant disagrees with what was stored.
    // Adopt the source. This is the safest repair in the file — no zone
    // inference, no heuristic, just the string the source sent.
    return {
      result: {
        outcome: 'done',
        detail: { repairClass: 'source_disagreed', shiftMs, raw: retained.raw },
      },
      patch: {
        startTime: retained.instant,
        endTime: shiftEnd(row, shiftMs),
        timeSource: TIME_SOURCES.REPAIRED,
        timePrecision: retained.precision,
        repairClass: 'source_disagreed',
        shiftMs,
      },
    };
  }

  // ── Class 3: a floating wall clock, reconstructed ────────────────────────
  //
  // Either the retained string is floating, or the transform is known to build
  // instants by reading floating strings as UTC and the row is all-day (which
  // is how `TransformGoogleCalendar.isAllDayEvent` decides: no `T` in the
  // string, i.e. a bare date).
  const floatingWall =
    retained?.wall ??
    (sourceSpec.floatingAsUtc && row.is_all_day === true && isUtcMidnight(row.start_time)
      ? wallClockInUtc(row.start_time)
      : null);

  if (floatingWall != null) {
    const zone = firstString(metadata, sourceSpec.zoneKeys) ?? userZone;

    if (!isKnownTimeZone(zone)) {
      // The wall clock is known and the zone is not, so the instant cannot be
      // reconstructed. LABELLED rather than moved: `ambiguous` tells the UI the
      // time of day is not trustworthy, and the row stays a candidate for a
      // generation that can resolve the zone (§6.6's "resolve against the
      // sender's other messages" rule, which needs the retained payload).
      return {
        result: {
          outcome: 'done',
          detail: { repairClass: 'floating_no_zone', shiftMs: 0 },
        },
        patch: {
          startTime: row.start_time,
          endTime: row.end_time,
          timeSource: TIME_SOURCES.INGEST,
          timePrecision: TIME_PRECISIONS.AMBIGUOUS,
          repairClass: 'floating_no_zone',
          shiftMs: 0,
        },
      };
    }

    const repaired = zonedWallClockToUtc(floatingWall, zone);
    const shiftMs = repaired.getTime() - row.start_time.getTime();
    const precision =
      retained?.precision ?? (row.is_all_day === true ? TIME_PRECISIONS.DAY : TIME_PRECISIONS.MINUTE);

    if (shiftMs === 0) {
      // The zone is UTC, or its offset is zero on that date. The instant was
      // already right; the PRECISION was not, and that is what makes an all-day
      // event render as a day instead of as midnight.
      return {
        result: { outcome: 'done', detail: { repairClass: 'floating_zone_agrees', shiftMs: 0 } },
        patch: {
          startTime: row.start_time,
          endTime: row.end_time,
          timeSource: TIME_SOURCES.SOURCE,
          timePrecision: precision,
          repairClass: 'floating_zone_agrees',
          shiftMs: 0,
        },
      };
    }

    return {
      result: {
        outcome: 'done',
        detail: { repairClass: 'floating_local_reconstructed', shiftMs, zone },
      },
      patch: {
        startTime: repaired,
        endTime: shiftEnd(row, shiftMs),
        timeSource: TIME_SOURCES.REPAIRED,
        timePrecision: precision,
        repairClass: 'floating_local_reconstructed',
        shiftMs,
      },
    };
  }

  // ── Class 4: a declared source with nothing to check against ─────────────
  //
  // The source has a spec, this row is not an undated kind, and no retained
  // string was found. The instant is the transform's and is probably right —
  // `place_review` rows are the corpus case — but nothing here can confirm it.
  // Labelled `source`, at second precision, and NOT moved.
  return {
    result: { outcome: 'done', detail: { repairClass: 'source_unverified', shiftMs: 0 } },
    patch: {
      startTime: row.start_time,
      endTime: row.end_time,
      timeSource: TIME_SOURCES.SOURCE,
      timePrecision: TIME_PRECISIONS.SECOND,
      repairClass: 'source_unverified',
      shiftMs: 0,
    },
  };
}

/** A stored instant that is exactly 00:00:00.000 UTC — the `new Date("YYYY-MM-DD")` signature. */
function isUtcMidnight(instant: Date): boolean {
  return (
    instant.getUTCHours() === 0 &&
    instant.getUTCMinutes() === 0 &&
    instant.getUTCSeconds() === 0 &&
    instant.getUTCMilliseconds() === 0
  );
}

/**
 * Move `end_time` by the same amount as `start_time`.
 *
 * Preserves the DURATION, which is the property a repair must not damage: an
 * hour-long meeting stays an hour long wherever it lands. Google's all-day
 * `end.date` is exclusive and was parsed by the same broken path as the start,
 * so it needs the same shift.
 */
function shiftEnd(row: TemporalRow, shiftMs: number): Date | null {
  if (row.end_time == null || Number.isNaN(row.end_time.getTime())) {
    return null;
  }

  return new Date(row.end_time.getTime() + shiftMs);
}

function stringAt(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];

  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function firstString(metadata: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = stringAt(metadata, key);

    if (value != null) {
      return value;
    }
  }

  return null;
}

function firstParsed(metadata: Record<string, unknown>, keys: readonly string[]): ParsedSourceTime | null {
  for (const key of keys) {
    const parsed = parseSourceTime(metadata[key]);

    if (parsed != null) {
      return parsed;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

/**
 * Repairs `ci.events.start_time` where it can be repaired, and LABELS it where
 * it cannot.
 *
 * ── The two bugs, as they stand in the repo ────────────────────────────────
 *
 *  1. **The TZID is parsed and discarded.**
 *     `TransformGoogleCalendar` declares `start.timeZone` on its `CalendarEvent`
 *     interface, never reads it, and hands `start.dateTime || start.date` to
 *     `new Date(...)`. A bare date is UTC midnight per ECMA-262, so a
 *     US-Pacific user's all-day June 15 is stored at `2020-06-15T00:00:00Z` and
 *     shows as June 14, 17:00. A floating date-time constructs HOST-LOCAL,
 *     which is worse: the answer depends on the appliance's `TZ`.
 *  2. **Undated rows are pinned to import time with no marker.** All five Google
 *     Maps saved places on this appliance carry the identical
 *     `start_time = 2026-08-08T23:42:37Z` — one wall clock from the import run —
 *     so "Home", "Work" and "Gym" sit at the top of the timeline dated today.
 *
 * ── What "distinguishable" means here, concretely ──────────────────────────
 *
 * Four columns, and the pair at the end is what makes this a CORRECTION rather
 * than a rewrite:
 *
 * | Column | Meaning |
 * | --- | --- |
 * | `time_source` | {@link TIME_SOURCES}. `repaired` is the affordance the UI hangs "corrected" off. |
 * | `time_precision` | {@link TIME_PRECISIONS}. `day` stops an all-day event rendering a time. |
 * | `start_time_original` | The instant that was there before this stage first touched the row. NULL ⇒ never moved. |
 * | `end_time_original` | Ditto, so the pair stays consistent. |
 *
 * **Nothing is destroyed.** `start_time_original` is written
 * `COALESCE(start_time_original, start_time)` — set once, on the first repair,
 * and never overwritten by a later generation — so `UPDATE ci.events SET
 * start_time = start_time_original WHERE start_time_original IS NOT NULL` undoes
 * every repair this stage has ever made, at any version, in one statement. That
 * `COALESCE` is the whole safety property: without it, a v2 repair would
 * overwrite the true original with v1's answer and the undo would restore a
 * wrong date.
 *
 * ── Outcomes ───────────────────────────────────────────────────────────────
 *
 * Almost everything is `done`, because LABELLING IS WORK: an unlabelled
 * timestamp is one the UI has to present as fact. The exceptions carry reasons:
 *
 *  - `source_time_spec_missing` — skipped. No human has read this source's
 *    payload yet, so nothing is guessed. Countable, and a bump re-opens it.
 *  - `start_time_unreadable` — skipped. A replayed dead letter over a rewritten
 *    row.
 *  - `source_row_missing` — skipped. Deleted or re-owned between sweep and slice.
 *  - `temporal_write_failed` — FAILED, so the retry gate applies.
 *
 * ── Blast radius ───────────────────────────────────────────────────────────
 *
 * A bump re-examines every live event and can MOVE DATES THE USER HAS ALREADY
 * SEEN. Get the shift histogram before you get the phone call — every repair
 * this stage has made is `WHERE start_time_original IS NOT NULL`, and the
 * distance is `start_time - start_time_original`.
 */
@Injectable()
export class TemporalRepairStage implements Stage {
  readonly id = CLEAN_TEMPORAL_REPAIR_STAGE_ID;

  /**
   * Resolved ONCE, at construction, like every other stage: a getter would let
   * the version move under a slice that is mid-flight, so ids claimed at v1 and
   * completed at v2 would never be re-processed by the improvement the bump was
   * for.
   */
  readonly version = temporalRepairStageVersion();

  /**
   * `pipeline-index`: pure CPU and one bulk UPDATE per slice. No provider, no
   * object storage, no Ollama. The plan's `pipeline-clean` queue does not exist
   * — `constants.ts` declares three queues, one per RESOURCE CLASS, and a
   * Postgres-bound stage belongs on the Postgres-bound one.
   */
  readonly queue = PIPELINE_QUEUES.INDEX;

  readonly entityTypes = [ENTITY_TYPE] as const;

  readonly source = TEMPORAL_REPAIR_SOURCE;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(TemporalRepairStage.name);
  }

  /**
   * Repair one slice of events.
   *
   * Idempotent by construction: {@link classifyEventTime} is a pure function of
   * the row's INPUT columns (`source_system`, `metadata`, `is_all_day`) and of
   * `start_time` — and for every class that MOVES `start_time` the classifier
   * derives the answer from the retained source string rather than from the
   * current value, except for the all-day class, whose repair is idempotent for
   * a different reason: after the first pass the instant is no longer UTC
   * midnight, so `isUtcMidnight` is false and the row falls through to
   * `source_unverified` and is not moved again.
   */
  async run(ctx: UserServiceContext, ids: string[]): Promise<Map<string, StageResult>> {
    const results = new Map<string, StageResult>();

    if (ids.length === 0) {
      return results;
    }

    const userZone = await this.resolveUserZone(ctx.userId);
    const rows = await this.loadRows(ctx.userId, ids);
    const byId = new Map(rows.map((row) => [row.id, row]));

    // Answer for the ids that came back with no row FIRST, so the map is
    // complete even if the work below throws in a way this does not model.
    for (const id of ids) {
      if (!byId.has(id)) {
        results.set(id, { outcome: 'skipped', reason: 'source_row_missing' });
      }
    }

    const patches = new Map<string, TemporalPatch>();

    for (const row of rows) {
      const decision = classifyEventTime(row, userZone);

      if (decision.patch == null) {
        results.set(row.id, decision.result);

        continue;
      }

      patches.set(row.id, decision.patch);
    }

    if (patches.size === 0) {
      return results;
    }

    try {
      await this.writeTimes(ctx.userId, patches);

      let moved = 0;

      for (const [id, patch] of patches) {
        if (patch.shiftMs !== 0) {
          moved += 1;
        }

        results.set(id, {
          outcome: 'done',
          detail: {
            repairClass: patch.repairClass,
            timeSource: patch.timeSource,
            timePrecision: patch.timePrecision,
            shiftMs: patch.shiftMs,
          },
        });
      }

      if (moved > 0) {
        // The run summary §6.6 requires: how many rows moved, and by how much.
        // Logged rather than returned because `StageResult.detail` is validated
        // and then dropped — `ci.derived_facts` does not exist.
        this.logger.log('Temporal repair moved timeline entries', {
          moved,
          examined: patches.size,
          maxShiftMs: Math.max(...[...patches.values()].map((patch) => Math.abs(patch.shiftMs))),
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      // One statement means one outcome: it committed or it did not, so every
      // row in it shares the verdict. FAILED rather than skipped, because a
      // write failure is transient and the retry gate is the right response.
      for (const id of patches.keys()) {
        results.set(id, { outcome: 'failed', reason: 'temporal_write_failed', detail: { message } });
      }

      this.logger.error(
        `Temporal repair write failed for ${patches.size} events`,
        err instanceof Error ? err : new Error(message),
      );
    }

    return results;
  }

  /**
   * The user's IANA zone, validated, or null.
   *
   * `ci.users.timezone` is free text with no constraint — the value on this
   * appliance is `'UTC'` — so it is checked against the platform's tz database
   * before any arithmetic uses it. One query per slice, not per row.
   *
   * Null is not a failure: it makes the floating classes resolve to
   * `time_precision = 'ambiguous'` rather than inventing an offset. A stage that
   * guessed the zone would move 324,044 dates on the strength of a default.
   */
  private async resolveUserZone(userId: string): Promise<string | null> {
    const rows = await this.dataSource.query<Array<{ timezone: string | null }>>(
      `SELECT u.timezone FROM ci.users u WHERE u.id = $1::uuid`,
      [userId],
    );

    // Trimmed here so the string that is validated is the string that is used —
    // `isKnownTimeZone` refuses a value with surrounding whitespace rather than
    // silently accepting one shape and formatting another.
    const declared = (rows[0]?.timezone ?? '').trim() || null;
    // Read BEFORE the narrowing below: `isKnownTimeZone` is a type predicate, so
    // in its negative branch `declared` is narrowed to `null` and any further
    // test on it is `never`.
    const stated = declared != null;

    if (isKnownTimeZone(declared)) {
      return declared;
    }

    if (stated) {
      // A non-empty value that the tz database does not recognise is a
      // misconfiguration worth one line, not a silent fallback.
      this.logger.warn('User timezone is not a known IANA zone; floating times stay ambiguous', {
        timezone: rows[0]?.timezone,
      });
    }

    return null;
  }

  /**
   * The slice's events, in one statement.
   *
   * Raw SQL rather than the memory domain's `EventService`, for the reason
   * `GeocodeStage` gives: a `ci.events` row carries ~40 columns including jsonb
   * blobs at 200 rows a slice, the projection wanted is seven of them, and
   * reaching through another domain's barrel for a projection couples the
   * pipeline's module graph to it.
   *
   * `start_time_original` is read but NOT used as a candidate predicate — see
   * {@link TEMPORAL_REPAIR_SOURCE}. It is projected so a future generation can
   * reason about how far a row has already been moved; today it is the visible
   * proof, in the same row, that the sweep did not consult it.
   *
   * User-scoped even though the sweep already was: a slice can arrive from a
   * dead letter replayed weeks later, and re-scoping is the difference between
   * "this id is not yours" and moving a date on someone else's timeline.
   */
  private loadRows(userId: string, ids: string[]): Promise<TemporalRow[]> {
    return this.dataSource.query<TemporalRow[]>(
      `SELECT e.event_id AS id,
              e.start_time,
              e.end_time,
              e.is_all_day,
              e.source_system,
              e.metadata,
              e.start_time_original
         FROM ci.events e
        WHERE e.event_id = ANY($1::uuid[])
          AND e.user_id = $2::uuid`,
      [ids, userId],
    );
  }

  /**
   * Write every decided event in ONE statement.
   *
   * `unnest()` over parallel arrays, one round trip per slice — the pattern
   * `PipelineStateService` uses for the ledger and for the same reason: the
   * per-row form is why the communication-link backfill never finished over a
   * 22-year history.
   *
   * ── The `COALESCE` is the safety property ─────────────────────────────────
   *
   * ```sql
   * start_time_original = COALESCE(e.start_time_original, e.start_time)
   * ```
   *
   * Set on the FIRST repair and never again. Without the `COALESCE`, a v2 run
   * would stamp v1's already-repaired instant as "the original", and the undo
   * (`SET start_time = start_time_original`) would restore a wrong date while
   * looking like it had restored the right one. That is the difference between
   * a cleaner that can be reversed and one that only appears to be.
   *
   * The pair is written together and only when something actually moves, so a
   * label-only pass (`shiftMs = 0`, the overwhelming majority) never claims the
   * row was corrected. `u.shift_ms <> 0` is evaluated per row inside the one
   * statement rather than splitting the slice into two.
   *
   * No `RETURNING`: the statement commits for the whole slice or throws, and
   * which ids it touched is already known.
   */
  private async writeTimes(userId: string, patches: Map<string, TemporalPatch>): Promise<void> {
    const entries = [...patches.entries()];

    await this.dataSource.query(
      `UPDATE ci.events e
          SET start_time          = u.start_time,
              end_time            = u.end_time,
              time_source         = u.time_source,
              time_precision      = u.time_precision,
              start_time_original = CASE WHEN u.shift_ms <> 0
                                         THEN COALESCE(e.start_time_original, e.start_time)
                                         ELSE e.start_time_original END,
              end_time_original   = CASE WHEN u.shift_ms <> 0
                                         THEN COALESCE(e.end_time_original, e.end_time)
                                         ELSE e.end_time_original END,
              updated_at          = now()
         FROM unnest($1::uuid[], $2::timestamptz[], $3::timestamptz[], $4::text[], $5::text[], $6::bigint[])
              AS u(entity_id, start_time, end_time, time_source, time_precision, shift_ms)
        WHERE e.event_id = u.entity_id
          AND e.user_id = $7::uuid`,
      [
        entries.map(([id]) => id),
        entries.map(([, patch]) => patch.startTime),
        entries.map(([, patch]) => patch.endTime),
        entries.map(([, patch]) => patch.timeSource),
        entries.map(([, patch]) => patch.timePrecision),
        entries.map(([, patch]) => String(patch.shiftMs)),
        userId,
      ],
    );
  }
}

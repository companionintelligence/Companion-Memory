/* Calendar (.ics) datasource (basic TypeScript port) */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { normalizeIcsRecurrenceId } from '@ci/domains/memory';

import { htmlToText } from './htmlToText';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportedEventStatus, ImportParams } from './timeline';
import { timeframeContains } from './timeline';

interface CalendarOptions {
  ownerEntityId?: number;
}

/** One parsed VEVENT, with the same stable id as the importer would assign. */
export interface ParsedIcsEvent {
  /**
   * items.id — the VEVENT's own UID when present, otherwise
   * `ics:<basename>:<sig>`; suffixed `#<RECURRENCE-ID>` when the block is a
   * modified instance of a series rather than its master (RFC 5545 §3.8.4.4,
   * where UID alone does NOT identify such a block).
   */
  id: string;
  summary: string;
  description: string;
  location?: string;
  dtStart?: Date;
  dtEnd?: Date;
  /** `DTSTART;VALUE=DATE` (or a bare `YYYYMMDD` value). */
  isAllDay: boolean;
  /** `RRULE` present and non-empty (the VEVENT is a series master). */
  isRecurring: boolean;
  /**
   * The block's own `STATUS`, as the `ci.events.status` it means (see
   * {@link icsEventStatus}). Absent when the block states none.
   */
  status?: ImportedEventStatus;
  /**
   * MIME Content-IDs of inline images referenced from the description as
   * `[cid:...]` (Exchange/Outlook exports). The .ics carries no attachment
   * bytes, so these are dangling pointers — recorded here (and stripped from
   * `description`) as the only surviving evidence the event had inline media.
   */
  inlineCids?: string[];
}

/**
 * Unescape an RFC 5545 §3.3.11 TEXT value (also used, near-identically, by
 * RFC 6350 §3.4 for vCard TEXT properties — see vcard.ts's re-export).
 *
 * Both specs define the same backslash escapes for a TEXT-valued property:
 *   \\  -> \        \;  -> ;        \,  -> ,        \n or \N -> newline
 * Real Apple Calendar/Contacts exports rely on this: any LOCATION/SUMMARY/
 * DESCRIPTION (or vCard NOTE) containing a literal `,` or `;` — e.g. a
 * street address "Foo Ave\, Springfield\, IL" — carries it escaped, and
 * until this was applied at parse time the raw `\,`/`\;`/`\n` sequences were
 * stored verbatim in items.metadata instead of being decoded to the real
 * punctuation/newline.
 *
 * A single left-to-right, non-overlapping regex pass naturally handles the
 * tricky case of an escaped backslash followed by a literal character (e.g.
 * `\\n` — an escaped backslash then a bare "n" — correctly stays "\" + "n"
 * rather than becoming a newline, because matching `\\` consumes both
 * characters before the scan reaches the "n"). An unrecognized escape (a
 * backslash followed by some other character) is treated leniently: the
 * backslash is dropped and the character kept as-is.
 */
export function unescapeIcsText(value: string): string {
  return value.replace(/\\(.)/g, (_, ch: string) => {
    switch (ch) {
      case 'n':
      case 'N':
        return '\n';
      case '\\':
      case ';':
      case ',':
        return ch;
      default:
        return ch;
    }
  });
}

/**
 * A tag only HTML would write. Deliberately a closed list, not `<[a-z]…>`: a
 * plain-text DESCRIPTION may hold `Bob <bob@example.com>`, and an HTML parser
 * handed that would delete the address as an unknown element.
 *
 * Migration 20260930021227_convert_ics_html_descriptions_to_text selects the
 * rows it repairs with this same list — change the two together.
 */
const ICS_HTML_TAG =
  /<\/?(?:a|b|body|br|div|em|font|h[1-6]|hr|html|i|img|li|ol|p|span|strong|table|tbody|td|th|thead|tr|u|ul)\b[^>]*>/i;

/**
 * An .ics DESCRIPTION as plain text.
 *
 * RFC 5545 §3.8.1.5 makes DESCRIPTION plain TEXT, but Google Calendar writes
 * the event's rich-text body into it as HTML — `<b>Booked by</b>`, `<br>`,
 * `<a href>`, lists, tables — and mixes real newlines in with the markup. 194 of
 * the 1,260 descriptions in the reference Apple + Takeout exports carry tags,
 * and they reached the Memory UI, the search index and the embeddings as raw
 * markup.
 *
 * Only a description with a real HTML tag is converted: a plain one keeps its
 * `<`, `&` and `<address@host>` exactly as written. Newlines survive
 * (`<b>Booked by</b>\nName` is two lines, not one) and a link keeps its
 * destination (`here (https://…)`) — in an invitation the link is often the
 * one thing worth keeping.
 */
export function icsDescriptionText(description: string): string {
  return ICS_HTML_TAG.test(description)
    ? htmlToText(description, { preserveNewlines: true, keepLinkUrls: true })
    : description;
}

/**
 * A VEVENT's `STATUS` value as the `ci.events.status` it means.
 *
 * RFC 5545 §3.8.1.11 gives a VEVENT three: TENTATIVE, CONFIRMED and CANCELLED,
 * the same three `TransformGoogleCalendar.normalizeStatus` maps for the API copy
 * of the same event. The two pipelines converge on one row
 * (`calendarEventIdentity`), and whichever arrives first keeps it, so they must
 * agree on what they write. Case-insensitive, because §3.2 makes every
 * enumerated property value so.
 *
 * Anything else (no STATUS, or a VTODO/VJOURNAL value such as NEEDS-ACTION)
 * states nothing about the event and returns undefined, leaving the column
 * DEFAULT, 'confirmed'.
 *
 * This matters most for a cancelled occurrence of a series: a block with
 * RECURRENCE-ID and STATUS:CANCELLED. It has to land as `cancelled`, not be
 * dropped. `dropExistingOverrides` (memory/recurrence/queries.ts) reads the
 * stored override as the reason not to synthesize that occurrence, and
 * `LIVE_EVENT_SQL` keeps the row itself out of every reader that applies it.
 */
export function icsEventStatus(value: string | undefined): ImportedEventStatus | undefined {
  switch (value?.trim().toUpperCase()) {
    case 'CANCELLED':
      return 'cancelled';
    case 'TENTATIVE':
      return 'tentative';
    case 'CONFIRMED':
      return 'confirmed';
    default:
      return undefined;
  }
}

/**
 * Parse one .ics file's VEVENT blocks. Shared between the live importer
 * (processICS) and the backfill (backfillCalendarMetadata), so an item id
 * produced by either path matches the row in items.
 */
export function parseIcsEvents(raw: string, fpath: string): ParsedIcsEvent[] {
  const unfolded = raw.replace(/\r?\n[ \t]/g, '');
  const blocks = unfolded.split(/BEGIN:VEVENT/).slice(1);
  const out: ParsedIcsEvent[] = [];
  for (const blockRaw of blocks) {
    const block = blockRaw.split(/END:VEVENT/)[0];
    const lines = block.split(/\r?\n/);
    const map: Record<string, string> = {};
    // Property params (the `;KEY=VAL;…` segment between name and `:`). Kept so
    // we can detect DTSTART's `VALUE=DATE` (all-day) — the value-only `map`
    // can't distinguish midnight-UTC from a date-only event after parsing.
    const paramsMap: Record<string, string> = {};
    // RFC 5545 §3.6.1 nests sub-components INSIDE the VEVENT — today only
    // VALARM (§3.6.6) is legal there — and every Apple/Google export emits the
    // alarm AFTER the event's own properties. Folding the whole block into one
    // flat last-wins map therefore handed the ALARM every property name it
    // shares with its parent, and it always wins because it comes last:
    //
    //   DESCRIPTION  the alarm's `This is an event reminder` boilerplate
    //                replaced the event's real body,
    //   UID          the alarm's UID became the event's `items.id`, so the
    //                event was stored under its reminder's identity (and an
    //                event with two alarms took whichever came last),
    //   SUMMARY /    legal on an ACTION:EMAIL alarm (§3.6.6) and equally
    //   ATTENDEE /   clashing — not present in the reference corpus, but the
    //   ATTACH       same bug waiting for a different exporter.
    //
    // On the reference Apple export — 1,143 VEVENTs, 1,136 carrying a VALARM —
    // that destroyed 996 real event descriptions and re-keyed 1,136 events onto
    // their reminder's UID.
    //
    // The depth counter is deliberately generic rather than a VALARM special
    // case: it costs the same, and a sub-component this parser has never seen
    // must not be able to reintroduce the bug. BEGIN/END lines themselves are
    // dropped (they used to land in the map as `BEGIN`/`END`, unread by anyone).
    let depth = 0;
    for (const ln of lines) {
      if (/^BEGIN:/i.test(ln)) {
        depth += 1;

        continue;
      }

      if (/^END:/i.test(ln)) {
        // Clamped: a truncated export missing a BEGIN must not push the depth
        // negative and start folding the rest of the alarm into the event.
        depth = Math.max(0, depth - 1);

        continue;
      }

      if (depth > 0) {
        continue;
      }

      const m = ln.match(/^([^:;]+)(;[^:]*)?:(.*)$/);
      if (!m) {
        continue;
      }

      const name = m[1].toUpperCase();
      map[name] = m[3];
      if (m[2]) {
        paramsMap[name] = m[2].slice(1);
      } // drop leading `;`
    }

    const uid = map['UID'];
    // Keep the raw (still RFC 5545 §3.3.11-escaped) values around for the id
    // `sig` below — the hash must stay byte-for-byte what it was before this
    // unescaping was added, or every UID-less event's id would change and
    // `INSERT OR IGNORE`/backfill idempotency would treat re-imports as new
    // rows. The *stored* summary/description/location are unescaped so
    // consumers (CLI, exports, CI-Server) see real punctuation, not `\,`/`\;`.
    const rawSummary = map['SUMMARY'] || '';
    const rawDescription = map['DESCRIPTION'] || '';
    const inlineCids = [...rawDescription.matchAll(/\[cid:([^\]\s]+)\]/gi)].map((m) => m[1]);
    const descriptionNoCid = inlineCids.length
      ? rawDescription.replace(/\s*\[cid:[^\]\s]+\]/gi, '').trim()
      : rawDescription;
    const rawLocation = map['LOCATION'];
    const summary = unescapeIcsText(rawSummary);
    // Unescaped FIRST: `\n` is an RFC 5545 escape, and htmlToText only keeps a
    // newline it can see.
    const description = icsDescriptionText(unescapeIcsText(descriptionNoCid));
    const location = rawLocation !== undefined ? unescapeIcsText(rawLocation) : undefined;
    const dtStart = parseICSDate(map['DTSTART'], paramsMap['DTSTART']);
    const dtEnd = parseICSDate(map['DTEND'], paramsMap['DTEND']);
    // VALUE=DATE on DTSTART is the iCal signal for an all-day event (vs the
    // DATE-TIME default). Numeric YYYYMMDD without the param is also accepted
    // since real calendars sometimes omit it.
    const isAllDay =
      /(?:^|;)VALUE=DATE(?:;|$)/i.test(paramsMap['DTSTART'] || '') ||
      /^\d{8}$/.test((map['DTSTART'] || '').trim());
    // RRULE presence => recurring event. (We don't expand instances here; the
    // canonical row represents the series master, same as before.)
    const isRecurring = !!(map['RRULE'] && map['RRULE'].trim());
    // sig hashes the RAW (still-escaped) summary/location/description (cid
    // markers included) so ids of rows imported before the cid extraction —
    // and before TEXT-unescaping — existed stay stable across re-imports.
    // "Raw" means un-unescaped, NOT un-stripped: these now read the event's own
    // properties, because `map` no longer carries its VALARM's. See the re-key
    // note under the id below. Keeping the pre-strip values here — hashing the
    // alarm boilerplate purely to preserve the old ids — was the alternative,
    // and it would have kept a real collision alive: two UID-less events on the
    // same DTSTART whose only difference WAS their description hash to the same
    // sig once the identical boilerplate replaces both, and one is dropped.
    const sig = crypto
      .createHash('sha1')
      .update(
        [map['DTSTART'] || '', map['DTEND'] || '', rawSummary, rawLocation || '', rawDescription].join('\0'),
      )
      .digest('hex');
    // Both halves of the id changed with the nested-component fix above, and
    // both are RE-KEYS for any calendar already imported by the old parser:
    //
    //   `uid` is now the VEVENT's own UID rather than its last VALARM's, and
    //   `sig` now hashes the event's own SUMMARY/LOCATION/DESCRIPTION rather
    //   than the alarm boilerplate that overwrote them.
    //
    // Accepted deliberately. The old ids were the reminder's identity, not the
    // event's: they change every time the calendar app regenerates an alarm,
    // and two UID-less events whose real descriptions differed collapsed to one
    // `sig` once the identical boilerplate replaced both. A re-import after
    // this fix lands the events under their true ids; the pre-fix rows keep the
    // alarm ids and are what migration
    // 20260821024635_clear_ics_valarm_boilerplate_descriptions repairs.
    const baseId = uid && uid.trim() ? uid : `ics:${path.basename(fpath)}:${sig}`;
    // RFC 5545 §3.8.4.4: a modified instance of a recurring series REPEATS the
    // master's UID and is distinguished only by RECURRENCE-ID. Keying on UID
    // alone would collapse a series onto one row — 12 blocks across 2 series in
    // the reference export, of which 10 would be lost to
    // `events_source_identity_uniq`. The old parser hid this because each block
    // was keyed on its own alarm's UID. The master keeps the bare UID, so a
    // calendar that never had an override is not re-keyed a second time.
    // Normalized to the canonical UTC-basic suffix so a TZID-local override
    // (`RECURRENCE-ID;TZID=America/Los_Angeles:20221006T010000`) converges
    // with the API-synced copy of the same override, which keys on the UTC
    // instant — docs/design/cross-pipeline-identity.md §3.5.
    const rawRecurrenceId = (map['RECURRENCE-ID'] || '').trim();
    const recurrenceTzid = (paramsMap['RECURRENCE-ID'] || '').match(/(?:^|;)TZID=([^;]+)/)?.[1];
    const recurrenceId = rawRecurrenceId
      ? normalizeIcsRecurrenceId(rawRecurrenceId, recurrenceTzid ?? null)
      : '';
    const id = recurrenceId ? `${baseId}#${recurrenceId}` : baseId;
    // Read from the depth-0 `map`, so a nested component's STATUS cannot stand
    // in for the event's own (see the depth counter above).
    const status = icsEventStatus(map['STATUS']);
    out.push({
      id,
      summary,
      description,
      location,
      dtStart,
      dtEnd,
      isAllDay,
      isRecurring,
      ...(status ? { status } : {}),
      ...(inlineCids.length ? { inlineCids } : {}),
    });
  }

  return out;
}

export class CalendarFileImporter implements FileImporter {
  async recognize(_ctx: unknown, entry: DirEntry): Promise<Recognition> {
    const full = entry.fullPath || entry.fsRoot || entry.filename;
    if (!full) {
      return { confidence: 0 };
    }

    let st: fs.Stats;
    try {
      st = await stat(full);
    } catch {
      return { confidence: 0 };
    }

    if (st.isFile() && path.extname(full).toLowerCase() === '.ics') {
      return { confidence: 1.0 };
    }

    if (st.isDirectory()) {
      return { confidence: 0, dir_threshold: 0.9 };
    }

    return { confidence: 0 };
  }

  async fileImport(_ctx: unknown, entry: DirEntry, params: ImportParams): Promise<void> {
    const start = entry.fullPath || entry.fsRoot || entry.filename;
    if (!start) {
      return;
    }

    const stat = fs.statSync(start);
    if (stat.isDirectory()) {
      for await (const f of this.walkDir(start)) {
        if (f.toLowerCase().endsWith('.ics')) {
          await this.processICS(f, params);
        }
      }
    } else if (start.toLowerCase().endsWith('.ics')) {
      await this.processICS(start, params);
    }
  }

  private async *walkDir(root: string): AsyncGenerator<string> {
    const ents = await fs.promises.readdir(root, { withFileTypes: true });
    for (const e of ents) {
      const full = path.join(root, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('.')) {
          continue;
        }

        yield* this.walkDir(full);
      } else if (e.isFile()) {
        yield full;
      }
    }
  }

  private async processICS(fpath: string, params: ImportParams): Promise<void> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', 'read ics failed', { file: path.basename(fpath), error: (e as Error).message });
      // A file we cannot read is a whole export lost; the ledger has to say
      // so (same convention as vcard.ts/applecontacts.ts/google_my_activity.ts).
      params.pipeline.drop?.('unreadable_file', path.basename(fpath));

      return;
    }

    for (const ev of parseIcsEvents(raw, fpath)) {
      if (!timeframeContains(params.timeframe, ev.dtStart)) {
        continue;
      }

      const content = [ev.summary, ev.description].filter(Boolean).join('\n');
      const item = {
        id: ev.id,
        classification: 'event',
        timestamp: ev.dtStart,
        timespanEnd: ev.dtEnd,
        intermediateLocation: fpath,
        content: {
          filename: path.basename(fpath),
          mediaType: 'text/plain',
          data: async () => Buffer.from(content),
        },
        metadata: {
          Source: 'ICS',
          Summary: ev.summary || undefined,
          Description: ev.description || undefined,
          Location: ev.location,
          isAllDay: ev.isAllDay,
          isRecurring: ev.isRecurring,
          // Lifted to ci.events.status by the push (see icsEventStatus).
          eventStatus: ev.status,
          // Inline images the export dropped (see ParsedIcsEvent.inlineCids).
          InlineAttachmentCids: ev.inlineCids?.join(', '),
        },
      };
      params.pipeline.push({ item });
    }
  }
}

// NOT PORTED, AND NOT COMING BACK: `backfillCalendarMetadata` and its
// `CalendarBackfillResult` lived here — a ~115-line repair pass that re-read
// each calendar item out of the standalone importer's SQLite `items` table and
// rewrote its stringified metadata in place.
//
// The earlier note here said it would return with the Postgres staging layer.
// That was written before staging was settled as RUN-SCOPED, and the two do not
// fit together: it repaired a cohort of rows written by an OLDER importer, and
// `ci_import.staged_*` is deleted with its run, so there is never a stale cohort
// there to repair. The durable side (`ci.*`) has never held calendar rows from
// an older parser either — rows arrive through the push carrying whatever the
// current parser produced. Its only caller was the standalone CLI, which is
// also not being ported.
//
// Its parser-side tests ARE restored, in `__tests__/calendar.test.ts`; only the
// backfill describe block stayed behind.

/**
 * Parse one DATE / DATE-TIME property value. `params` is the property's own
 * `;KEY=VAL;…` segment (the `paramsMap` entry), which is where RFC 5545 §3.2.19
 * spells the zone a local date-time is written in.
 */
function parseICSDate(val?: string, params?: string): Date | undefined {
  if (!val) {
    return undefined;
  }

  const raw = val.trim();
  // Resolve the property's `;TZID=...` BEFORE the shape branches below, so a
  // zoned local date-time reaches them already spelled as a UTC instant.
  //
  // An earlier note in the floating branch claimed the line parser strips the
  // params — it does not (`paramsMap`, read two lines from this call for
  // VALUE=DATE), and on that false premise every TZID-bearing DTSTART was read
  // as SERVER-local. On the appliance's UTC container
  // `DTSTART;TZID=America/Los_Angeles:20221006T010000` landed seven hours early,
  // and permanently: the .ics and the Google ETL converge on one identity
  // (`calendarEventIdentity`), and the find-or-create on that identity never
  // revisits start_time, so whichever pipeline runs first owns the wrong value.
  //
  // `normalizeIcsRecurrenceId` is the conversion this repo already uses for the
  // same input shape on RECURRENCE-ID — same IANA lookup, and the same
  // deliberate non-guesses: a DATE-only value, an already-`Z` value, a floating
  // value with no TZID, or a TZID the runtime does not recognize all come back
  // untouched and fall through to the branches below unchanged.
  const tzid = params?.match(/(?:^|;)TZID=([^;]+)/)?.[1];
  const v = tzid ? normalizeIcsRecurrenceId(raw, tzid) : raw;
  // All-day DATE: YYYYMMDD
  if (/^\d{8}$/.test(v)) {
    const y = +v.slice(0, 4);
    const m = +v.slice(4, 6) - 1;
    const d = +v.slice(6, 8);

    return new Date(Date.UTC(y, m, d));
  }

  // UTC date-time: YYYYMMDDTHHMMSSZ
  if (/^\d{8}T\d{6}Z$/.test(v)) {
    const y = +v.slice(0, 4);
    const m = +v.slice(4, 6) - 1;
    const d = +v.slice(6, 8);
    const hh = +v.slice(9, 11);
    const mm = +v.slice(11, 13);
    const ss = +v.slice(13, 15);

    return new Date(Date.UTC(y, m, d, hh, mm, ss));
  }

  // Genuinely floating date-time: YYYYMMDDTHHMMSS that still has no zone after
  // the TZID resolution above — either the property carried no TZID (RFC 5545
  // floating time, which by definition names no instant) or it named a zone the
  // runtime does not know. The wall clock is read as server-local, the same
  // non-guess `normalizeIcsRecurrenceId` makes for those two cases.
  //
  // Matching this shape at all is what stopped such events (e.g.
  // `DTSTART;TZID=America/Grand_Turk:20091130T140000`, which the old two-pattern
  // parser failed to match) from falling back to ingest-time `now` — which
  // collapsed every one of them onto a single instant and broke timeline order.
  if (/^\d{8}T\d{6}$/.test(v)) {
    const y = +v.slice(0, 4);
    const m = +v.slice(4, 6) - 1;
    const d = +v.slice(6, 8);
    const hh = +v.slice(9, 11);
    const mm = +v.slice(11, 13);
    const ss = +v.slice(13, 15);

    return new Date(y, m, d, hh, mm, ss);
  }

  // Anything else already in a Date-parseable form (e.g. RFC 3339 with offset).
  const d = new Date(v);

  return isNaN(d.getTime()) ? undefined : d;
}

registerDataSource({
  name: 'calendar',
  title: 'Calendar',
  icon: 'calendar.svg',
  description: '.ics calendar files (naive parser)',
  newOptions: () => ({ ownerEntityId: undefined }) as CalendarOptions,
  newFileImporter: () => new CalendarFileImporter(),
});

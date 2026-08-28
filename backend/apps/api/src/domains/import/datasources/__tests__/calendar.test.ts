import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'path';

import { CalendarFileImporter, parseIcsEvents } from '../calendar';
import type { ImportParams } from '../timeline';

import { metaText, type EmittedGraph } from './support/emitted';

/**
 * The calendar parser, restored from CI-Import-Tools.
 *
 * Upstream this file also exercised `backfillCalendarMetadata`, a repair pass
 * that rewrote stale rows in the standalone app's long-lived SQLite `items`
 * table. That block is NOT restored, and the function is not coming back: it
 * repaired a cohort of rows written by an older importer, and no such cohort
 * exists here. Staging is run-scoped and deleted with its run, so a backfill
 * over `ci_import.staged_items` would have nothing to repair, and the durable
 * side (`ci.*`) has never held calendar rows from an older parser. Its only
 * caller was the standalone CLI, which is not being ported either.
 */

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

/** Write an .ics into a throwaway directory and hand back its path. */
function icsFile(prefix: string, name: string, lines: string[], newline = '\r\n'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));

  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, lines.join(newline));

  return filePath;
}

async function importIcs(filePath: string): Promise<EmittedGraph[]> {
  const pipeline: EmittedGraph[] = [];

  await new CalendarFileImporter().fileImport({}, { filename: path.basename(filePath), fullPath: filePath }, {
    pipeline,
    timeframe: {},
    log: () => {},
  } as unknown as ImportParams);

  return pipeline;
}

describe('Calendar datasource', () => {
  it('recognizes .ics file', async () => {
    const icsPath = path.join(FIXTURES_DIR, 'sample.ics');
    const rec = await new CalendarFileImporter().recognize({}, { filename: 'sample.ics', fullPath: icsPath });

    expect(rec.confidence).toBe(1.0);
  });

  it('imports calendar events', async () => {
    const pipeline = await importIcs(path.join(FIXTURES_DIR, 'sample.ics'));
    const items = pipeline.filter((graph) => graph.item);

    expect(items.length).toBe(2);
    expect(items[0].item.classification).toBe('event');
    expect(items[0].item.metadata.Source).toBe('ICS');
    // A title-bearing key derived from SUMMARY, not the bare .ics filename.
    expect(items[0].item.metadata.Summary).toBe('Team Meeting');
    expect(items[0].item.metadata.Summary).not.toBe(items[0].item.content.filename);
    expect(items[0].item.metadata.Description).toBe('Discuss Q1 planning and objectives');
    // DTSTART=YYYYMMDDTHHMMSSZ → timed event, no DTSTART params, no RRULE.
    expect(items[0].item.metadata.isAllDay).toBe(false);
    expect(items[0].item.metadata.isRecurring).toBe(false);
    // The fixture's second event is a bare-date DTSTART (all-day), no RRULE.
    expect(items[1].item.metadata.isAllDay).toBe(true);
    expect(items[1].item.metadata.isRecurring).toBe(false);
  });

  it('extracts dangling [cid:...] inline-image refs and strips them from the description', async () => {
    // Exchange/Outlook .ics exports keep the MIME Content-ID pointer for an
    // inline image but drop the attachment itself (no ATTACH property).
    const icsPath = icsFile('ci-ics-cid-', 'invite.ics', [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:Microsoft Exchange Server 2010',
      'BEGIN:VEVENT',
      'UID:cid-test-1',
      'SUMMARY:Party',
      'DESCRIPTION:Celebrate...something.[cid:664698a6-f8ea-474e-890b-b40eb7577839]\\nSee you there',
      'DTSTART:20260704T150000Z',
      'DTEND:20260705T000000Z',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:cid-test-2',
      'SUMMARY:Plain event',
      'DESCRIPTION:No images here',
      'DTSTART:20260706T150000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ]);

    try {
      const [withCid, plain] = await importIcs(icsPath);

      expect(withCid.item.metadata.InlineAttachmentCids).toBe('664698a6-f8ea-474e-890b-b40eb7577839');
      // The DESCRIPTION carries a real RFC 5545 `\n` escape, decoded to a
      // newline like every other TEXT field (see the unescape test below).
      expect(withCid.item.metadata.Description).toBe('Celebrate...something.\nSee you there');
      expect(metaText(withCid.item.metadata.Description)).not.toContain('[cid:');
      // Events without markers are untouched and carry no cid key.
      expect(plain.item.metadata.InlineAttachmentCids).toBeUndefined();
      expect(plain.item.metadata.Description).toBe('No images here');
    } finally {
      fs.rmSync(path.dirname(icsPath), { recursive: true, force: true });
    }
  });

  it('unescapes RFC 5545 TEXT backslash sequences in SUMMARY/DESCRIPTION/LOCATION', async () => {
    // Real Apple Calendar exports: 63% of Location values and ~9% of Summary
    // values carried a literal backslash before `,`/`;` (a street address
    // "Foo Ave\, Springfield\, IL") that was stored verbatim rather than
    // decoded to real punctuation.
    const icsPath = icsFile('ci-ics-unescape-', 'escaped.ics', [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Test//EN',
      'BEGIN:VEVENT',
      'UID:escaped-1@x',
      'DTSTART:20260704T150000Z',
      'DTEND:20260704T160000Z',
      'SUMMARY:Woodbury\\, Fletcher Jones Auditorium',
      'DESCRIPTION:Line one\\nLine two\\; still line two\\\\literal backslash',
      'LOCATION:7500 N Glenoaks Blvd\\, Burbank\\, CA 91504',
      'END:VEVENT',
      'END:VCALENDAR',
    ]);

    try {
      const [event] = await importIcs(icsPath);

      expect(event.item.metadata.Summary).toBe('Woodbury, Fletcher Jones Auditorium');
      expect(event.item.metadata.Description).toBe('Line one\nLine two; still line two\\literal backslash');
      expect(event.item.metadata.Location).toBe('7500 N Glenoaks Blvd, Burbank, CA 91504');
    } finally {
      fs.rmSync(path.dirname(icsPath), { recursive: true, force: true });
    }
  });

  it('keeps the UID-less event id (sig) stable across the unescape fix', () => {
    // The sig hash seeding the id for UID-less events is computed from the RAW
    // (still-escaped) text, not the unescaped display text. Otherwise every
    // previously-imported UID-less event gets a new id on re-import, and the
    // dedup index silently duplicates rows instead of collapsing them.
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Test//EN',
      'BEGIN:VEVENT',
      'DTSTART:20260101T090000Z',
      'SUMMARY:Foo\\, Bar',
      'LOCATION:Baz\\; Qux',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\n');

    const [event] = parseIcsEvents(ics, 'noUidEscaped.ics');

    // Display fields are unescaped…
    expect(event.summary).toBe('Foo, Bar');
    expect(event.location).toBe('Baz; Qux');

    // …but the id is exactly what the raw-text sig computation produces.
    const expectedSig = crypto
      .createHash('sha1')
      .update(['20260101T090000Z', '', 'Foo\\, Bar', 'Baz\\; Qux', ''].join('\0'))
      .digest('hex');

    expect(event.id).toBe(`ics:noUidEscaped.ics:${expectedSig}`);
  });

  it('detects DTSTART;VALUE=DATE all-day and RRULE recurring from iCal params', async () => {
    // These populate is_all_day / is_recurring downstream, so they must survive
    // the line-param parse — an earlier `^([^:;]+)(?:;[^:]*)?:` regex stripped
    // the params and left both false for every imported event.
    const icsPath = icsFile(
      'ci-ics-rrule-',
      'rrule.ics',
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Test//EN',
        'BEGIN:VEVENT',
        'UID:weekly-1@x',
        'DTSTART;VALUE=DATE:20260117',
        'SUMMARY:All-day series',
        'RRULE:FREQ=WEEKLY;BYDAY=MO',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:once@x',
        'DTSTART;TZID=America/Los_Angeles:20260120T140000',
        'SUMMARY:Timed one-off',
        'END:VEVENT',
        'END:VCALENDAR',
      ],
      '\n',
    );

    try {
      const items = (await importIcs(icsPath)).filter((graph) => graph.item).map((graph) => graph.item);

      expect(items.length).toBe(2);

      const series = items.find((item) => item.id === 'weekly-1@x');
      const once = items.find((item) => item.id === 'once@x');

      expect(series?.metadata.isAllDay).toBe(true);
      expect(series?.metadata.isRecurring).toBe(true);
      expect(once?.metadata.isAllDay).toBe(false);
      expect(once?.metadata.isRecurring).toBe(false);
    } finally {
      fs.rmSync(path.dirname(icsPath), { recursive: true, force: true });
    }
  });

  it("keeps the event's own properties when a nested VALARM repeats them", async () => {
    // RFC 5545 §3.6.6 nests VALARM INSIDE the VEVENT, and every Apple/Google
    // export emits it AFTER the event's own properties. The parser used to fold
    // every line of the block into one flat last-wins map, so the alarm won
    // every property name it shares with its parent:
    //
    //   DESCRIPTION -> "This is an event reminder" replaced the real body
    //   UID         -> the alarm's UID became the event's items.id
    //   SUMMARY     -> an EMAIL alarm's "Alarm notification" replaced the title
    //
    // On the reference Apple export (1,143 VEVENTs, 1,136 with a VALARM) that
    // destroyed 996 real event descriptions outright and re-keyed 1,136 events
    // onto their reminder's UID.
    const pipeline = await importIcs(path.join(FIXTURES_DIR, 'apple-calendar-valarm.ics'));
    const items = pipeline.filter((graph) => graph.item).map((graph) => graph.item);

    const booked = items.find((item) => item.id === 'bgf7vr91iphqjomlis74k0udgg@example.com');

    // The id is the VEVENT's UID, not the VALARM's.
    expect(booked).toBeDefined();
    expect(items.map((item) => item.id)).not.toContain('04AACD36-CF84-4420-AA2A-D25CB8B9C662');

    // The body is the event's, not the reminder boilerplate. `\n` is a real
    // RFC 5545 TEXT escape, decoded like everywhere else.
    expect(booked?.metadata.Description).toBe(
      '<b>Booked by</b>\nAva Booker\nava@example.com\n\nJoin with Google Meet: https://meet.example.com/fby-pwgg-pff',
    );
    expect(metaText(booked?.metadata.Description)).not.toContain('This is an event reminder');
    expect(booked?.metadata.Summary).toBe('Meet w/ Liam (Ava Booker)');
    expect(booked?.metadata.Location).toBe('Conference Room A');

    // No item anywhere in the file carries the reminder text as its body — the
    // series master's alarm is an ACTION:EMAIL one that also repeats SUMMARY
    // and ATTENDEE, the latent half of the same clash.
    expect(items.every((item) => item.metadata.Description !== 'This is an event reminder')).toBe(true);

    const master = items.find(
      (item) => item.id === '0vkr94uvv688d4grk3cns7g3aq_R20210326T210000@example.com',
    );

    expect(master?.metadata.Summary).toBe('XR3 Check-In');
    expect(master?.metadata.Description).toBe('Weekly XR sync.\nAgenda in the shared doc.');
    // RRULE lives on the VEVENT; the VALARM's TRIGGER must not be mistaken for it.
    expect(master?.metadata.isRecurring).toBe(true);
  });

  it('keys a recurrence override on UID + RECURRENCE-ID, not UID alone', async () => {
    // RFC 5545 §3.8.4.4: a modified instance of a series REPEATS the master's
    // UID and is told apart only by RECURRENCE-ID. Until the nested-component
    // fix the ids happened to differ because each block was keyed on its own
    // alarm's UID; keying on the (now correct) VEVENT UID alone would collapse
    // the master and both overrides onto one id, and `events_source_triple_uniq`
    // would let the last push overwrite the other two. The reference Apple
    // export carries 10 such overrides across 2 series.
    const pipeline = await importIcs(path.join(FIXTURES_DIR, 'apple-calendar-valarm.ics'));
    const items = pipeline.filter((graph) => graph.item).map((graph) => graph.item);

    const seriesUid = '0vkr94uvv688d4grk3cns7g3aq_R20210326T210000@example.com';
    const series = items.filter((item) => (item.id ?? '').startsWith(seriesUid));

    expect(series.length).toBe(3);
    expect(new Set(series.map((item) => item.id)).size).toBe(3);
    expect(series.map((item) => item.metadata.Summary).sort()).toEqual([
      'XR3 Check-In',
      'XR3 Check-In (XRGolf)',
      'XR3 Check-In (moved)',
    ]);

    // The master keeps the bare UID; only an override carries the suffix, so
    // ids minted before overrides existed in a calendar stay stable.
    expect(series.map((item) => item.id)).toContain(seriesUid);
    expect(series.map((item) => item.id)).toContain(`${seriesUid}#20210330T140000`);
  });

  it('keeps UID-less same-date events distinct and idempotent', async () => {
    // Two all-day events on the same DATE with no UID: before the fix both
    // hashed to sha1(… ISO(midnight) …) and one was dropped on insert.
    const icsPath = icsFile(
      'ci-ics-nouid-',
      'nouid.ics',
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Test//EN',
        'BEGIN:VEVENT',
        'DTSTART:20250120',
        'SUMMARY:Holiday A',
        'DESCRIPTION:First',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'DTSTART:20250120',
        'SUMMARY:Holiday B',
        'DESCRIPTION:Second',
        'END:VEVENT',
        'END:VCALENDAR',
      ],
      '\n',
    );

    try {
      const idsOf = async () =>
        (await importIcs(icsPath)).filter((graph) => graph.item).map((graph) => graph.item.id);

      const ids = await idsOf();

      expect(ids.length).toBe(2);
      expect(ids.every((id) => !!id)).toBe(true);
      expect(new Set(ids).size).toBe(2);

      // Re-importing the same file yields identical ids, which is what makes
      // the staged-item dedup collapse a re-import instead of doubling it.
      expect(await idsOf()).toEqual(ids);
    } finally {
      fs.rmSync(path.dirname(icsPath), { recursive: true, force: true });
    }
  });
});

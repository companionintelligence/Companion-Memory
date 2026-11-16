import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'path';

import { serverTimezone, wallClockInTZ } from '@ci/common/time/zoned';
import { expandSeries, parseRecurrence } from '@ci/domains/memory';

import { CalendarFileImporter, icsEventStatus, parseIcsEvents } from '../calendar';
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

  it('imports a Google Calendar HTML description as text, keeping its lines and links', async () => {
    // The shape Google writes into DESCRIPTION (RFC 5545 says plain TEXT): its
    // appointment-booking body, with markup and real `\n` escapes mixed. 194 of
    // the 1,260 descriptions in the reference exports carried tags, and they
    // were displayed, indexed and embedded as raw markup.
    const icsPath = icsFile('ci-ics-html-', 'google.ics', [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
      'BEGIN:VEVENT',
      'UID:html-1@google.com',
      'DTSTART:20260704T150000Z',
      'DTEND:20260704T160000Z',
      'SUMMARY:Intro call',
      'DESCRIPTION:<b>Booked by</b>\\nAda Lovelace\\nada@example.com\\n\\nQuestions? Answers <a href="https://exam',
      ' ple.com/faq">here</a>&nbsp\\;&amp\\; more.<br><br>Join with Google Meet: https://meet.example/abc',
      'END:VEVENT',
      'END:VCALENDAR',
    ]);

    try {
      const [event] = await importIcs(icsPath);
      const text =
        'Booked by\nAda Lovelace\nada@example.com\n\nQuestions? Answers here (https://example.com/faq) & more.\n\n' +
        'Join with Google Meet: https://meet.example/abc';

      // Metadata `Description` is what the push stores as the event's
      // description: shown in Memory, indexed for search, and embedded.
      expect(event.item.metadata.Description).toBe(text);
    } finally {
      fs.rmSync(path.dirname(icsPath), { recursive: true, force: true });
    }
  });

  it('leaves a plain-text description exactly as written, angle brackets and all', () => {
    // No HTML tag, so no HTML parser: one would delete `<ada@example.com>` as
    // an unknown element and decode a literal `&amp;`.
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:plain-1@x',
      'DTSTART:20260101T090000Z',
      'SUMMARY:Sync',
      'DESCRIPTION:Organizer: Ada <ada@example.com>\\nQ&amp\\;A if 2 < 3',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const [event] = parseIcsEvents(ics, 'plain.ics');

    expect(event.description).toBe('Organizer: Ada <ada@example.com>\nQ&amp;A if 2 < 3');
  });

  it('keeps the UID-less event id stable: the sig hashes the raw HTML, not the text', () => {
    const rawDescription = '<b>Booked by</b>\\nAda';
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'DTSTART:20260101T090000Z',
      'SUMMARY:Call',
      `DESCRIPTION:${rawDescription}`,
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\n');

    const [event] = parseIcsEvents(ics, 'noUidHtml.ics');
    const expectedSig = crypto
      .createHash('sha1')
      .update(['20260101T090000Z', '', 'Call', '', rawDescription].join('\0'))
      .digest('hex');

    expect(event.description).toBe('Booked by\nAda');
    expect(event.id).toBe(`ics:noUidHtml.ics:${expectedSig}`);
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

  it('reads all-day, recurring and the event zone from iCal params', async () => {
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
        'DTEND;TZID=America/Los_Angeles:20260120T150000',
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

      // The TZID is part of the value, not decoration: 14:00 America/Los_Angeles
      // on 2026-01-20 (PST, UTC-8) is 22:00Z. The parser used to drop the param
      // and read the wall clock as SERVER-local, so on the appliance's UTC
      // container this event was stored eight hours early — and permanently,
      // since the .ics and the Google ETL converge on one identity whose
      // find-or-create never revisits start_time.
      //
      // Asserted as absolute instants (`toISOString`), so the expectation holds
      // whatever TZ the machine running the suite is in.
      expect(once?.timestamp?.toISOString()).toBe('2026-01-20T22:00:00.000Z');
      expect(once?.timespanEnd?.toISOString()).toBe('2026-01-20T23:00:00.000Z');

      // The DATE-only series master is unaffected: no TZID to resolve, so it
      // stays the UTC midnight of its date.
      expect(series?.timestamp?.toISOString()).toBe('2026-01-17T00:00:00.000Z');
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
    // RFC 5545 TEXT escape, decoded like everywhere else, and Google's `<b>` is
    // converted to text (see icsDescriptionText).
    expect(booked?.metadata.Description).toBe(
      'Booked by\nAva Booker\nava@example.com\n\nJoin with Google Meet: https://meet.example.com/fby-pwgg-pff',
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
    // the master and both overrides onto one id, and `events_source_identity_uniq`
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
    // ids minted before overrides existed in a calendar stay stable. The
    // suffix is the TZID-local RECURRENCE-ID normalized to UTC basic
    // (identity/calendar.ts normalizeIcsRecurrenceId), matching what the
    // Calendar connection derives for the same override — this fixture's
    // 14:00 America/Los_Angeles override is the 21:00Z instant.
    expect(series.map((item) => item.id)).toContain(seriesUid);
    expect(series.map((item) => item.id)).toContain(`${seriesUid}#20210330T210000Z`);
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

  /**
   * A series' rule. The importer used to keep only whether a VEVENT had an
   * RRULE, and the calendar expands a series only from the rule itself, so an
   * imported weekly meeting showed on its first date and never again.
   */
  describe('recurrence', () => {
    const PACIFIC = 'America/Los_Angeles';
    const WEEKLY = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Test//EN',
      'BEGIN:VEVENT',
      'UID:weekly-team-sync@example.com',
      'DTSTART;TZID=America/Los_Angeles:20261005T100000',
      'DTEND;TZID=America/Los_Angeles:20261005T103000',
      'RRULE:FREQ=WEEKLY;BYDAY=MO',
      'EXDATE;TZID=America/Los_Angeles:20261026T100000',
      'EXDATE;TZID=America/Los_Angeles:20261109T100000',
      'RDATE;TZID=America/Los_Angeles:20261125T100000',
      'SUMMARY:Weekly team sync',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:kickoff@example.com',
      'DTSTART;TZID=America/Los_Angeles:20261118T140000',
      'SUMMARY:Project kickoff',
      'END:VEVENT',
      'END:VCALENDAR',
    ];

    it('carries the RRULE, every EXDATE and RDATE line and the start zone, as Google sync stores them', async () => {
      const icsPath = icsFile('ci-ics-series-', 'work.ics', WEEKLY);

      try {
        const items = (await importIcs(icsPath)).map((graph) => graph.item);
        const series = items.find((item) => item.id === 'weekly-team-sync@example.com');
        const once = items.find((item) => item.id === 'kickoff@example.com');

        // Both EXDATE lines: the property map keeps one value per name.
        expect(series?.metadata.recurrenceRule).toEqual([
          'RRULE:FREQ=WEEKLY;BYDAY=MO',
          'EXDATE;TZID=America/Los_Angeles:20261026T100000',
          'EXDATE;TZID=America/Los_Angeles:20261109T100000',
          'RDATE;TZID=America/Los_Angeles:20261125T100000',
        ]);
        expect(series?.metadata.recurrenceTimeZone).toBe(PACIFIC);
        expect(once?.metadata.recurrenceRule).toBeUndefined();
        expect(once?.metadata.recurrenceTimeZone).toBeUndefined();
      } finally {
        fs.rmSync(path.dirname(icsPath), { recursive: true, force: true });
      }
    });

    it('expands on the calendar: every Monday at 10:00, without the excluded dates, with the added one', async () => {
      const icsPath = icsFile('ci-ics-expand-', 'work.ics', WEEKLY);

      try {
        const [series] = (await importIcs(icsPath)).map((graph) => graph.item);
        const spec = parseRecurrence(
          {
            id: 'series',
            startTime: series.timestamp as Date,
            endTime: series.timespanEnd ?? null,
            isAllDay: series.metadata.isAllDay as boolean,
            metadata: series.metadata,
            recurrencePattern: null,
            sourceSystem: 'calendar',
            sourceId: series.id as string,
          },
          { fallbackTimeZone: 'UTC' },
        );

        expect(spec?.timeZone).toBe(PACIFIC);

        const { starts } = expandSeries(spec!, {
          from: new Date('2026-10-01T00:00:00Z'),
          to: new Date('2026-12-01T00:00:00Z'),
        });
        const local = starts.map((start) => {
          const wall = wallClockInTZ(start, PACIFIC);

          return `${wall.month}/${wall.day} ${wall.hour}:${String(wall.minute).padStart(2, '0')}`;
        });

        // October 26 and November 9 are excluded, November 25 (a Wednesday)
        // is added, and the series stays at 10:00 after the clocks change on
        // November 1.
        expect(local).toEqual([
          '10/5 10:00',
          '10/12 10:00',
          '10/19 10:00',
          '11/2 10:00',
          '11/16 10:00',
          '11/23 10:00',
          '11/25 10:00',
          '11/30 10:00',
        ]);
      } finally {
        fs.rmSync(path.dirname(icsPath), { recursive: true, force: true });
      }
    });

    it.each([
      ['a UTC start', 'DTSTART:20261005T170000Z', 'UTC'],
      // The zone the parser read the wall clock in (see seriesTimeZone).
      ['a floating start', 'DTSTART:20261005T100000', serverTimezone()],
      ['a zone the runtime does not know', 'DTSTART;TZID=Not/AZone:20261005T100000', serverTimezone()],
    ])('sets the series zone for %s', (_, dtstart, zone) => {
      const [event] = parseIcsEvents(
        [
          'BEGIN:VCALENDAR',
          'BEGIN:VEVENT',
          'UID:s@x',
          dtstart,
          'RRULE:FREQ=WEEKLY',
          'END:VEVENT',
          'END:VCALENDAR',
        ].join('\r\n'),
        'zones.ics',
      );

      expect(event.recurrence).toEqual(['RRULE:FREQ=WEEKLY']);
      expect(event.recurrenceTimeZone).toBe(zone);
    });

    it('skips a floating EXDATE even when the owner lives in another zone', () => {
      const [event] = parseIcsEvents(
        [
          'BEGIN:VCALENDAR',
          'BEGIN:VEVENT',
          'UID:floating@x',
          'DTSTART:20261005T100000',
          'RRULE:FREQ=WEEKLY;COUNT=4',
          'EXDATE:20261019T100000',
          'END:VEVENT',
          'END:VCALENDAR',
        ].join('\r\n'),
        'floating.ics',
      );
      const serverZone = serverTimezone();
      // Any zone but the server's, so the owner's zone cannot paper over a
      // series walked from the wrong wall clock.
      const ownerZone = serverZone === 'Asia/Tokyo' ? 'America/Los_Angeles' : 'Asia/Tokyo';
      const spec = parseRecurrence(
        {
          id: 'series',
          startTime: event.dtStart as Date,
          endTime: null,
          isAllDay: false,
          metadata: { recurrenceRule: event.recurrence, recurrenceTimeZone: event.recurrenceTimeZone },
          recurrencePattern: null,
          sourceSystem: 'calendar',
          sourceId: 'floating@x',
        },
        { fallbackTimeZone: ownerZone },
      );
      const { starts } = expandSeries(spec!, {
        from: new Date('2026-09-01T00:00:00Z'),
        to: new Date('2026-12-01T00:00:00Z'),
      });

      expect(
        starts.map((start) => {
          const wall = wallClockInTZ(start, serverZone);

          return `${wall.month}/${wall.day} ${wall.hour}:${String(wall.minute).padStart(2, '0')}`;
        }),
      ).toEqual(['10/5 10:00', '10/12 10:00', '10/26 10:00']);
    });

    it('leaves the rule off an all-day series, which the nightly time repair moves off UTC midnight', () => {
      const [event] = parseIcsEvents(
        [
          'BEGIN:VCALENDAR',
          'BEGIN:VEVENT',
          'UID:all-day@x',
          'DTSTART;VALUE=DATE:20261005',
          'RRULE:FREQ=WEEKLY;BYDAY=MO',
          'EXDATE;VALUE=DATE:20261019',
          'END:VEVENT',
          'END:VCALENDAR',
        ].join('\r\n'),
        'all-day.ics',
      );

      expect(event.isAllDay).toBe(true);
      expect(event.isRecurring).toBe(true);
      expect(event.recurrence).toBeUndefined();
      expect(event.recurrenceTimeZone).toBeUndefined();
    });

    it('leaves the rule off a series whose DTSTART does not parse', () => {
      const [event] = parseIcsEvents(
        [
          'BEGIN:VCALENDAR',
          'BEGIN:VEVENT',
          'UID:undated@x',
          'DTSTART;TZID="(UTC-05:00) Eastern Time (US & Canada)":20261005T100000',
          'RRULE:FREQ=DAILY',
          'END:VEVENT',
          'END:VCALENDAR',
        ].join('\r\n'),
        'undated.ics',
      );

      expect(event.dtStart).toBeUndefined();
      expect(event.isRecurring).toBe(true);
      expect(event.recurrence).toBeUndefined();
      expect(event.recurrenceTimeZone).toBeUndefined();
    });

    it('leaves the rule off an override, which is one occurrence and not a series', async () => {
      const pipeline = await importIcs(path.join(FIXTURES_DIR, 'apple-calendar-valarm.ics'));
      const seriesUid = '0vkr94uvv688d4grk3cns7g3aq_R20210326T210000@example.com';
      const series = pipeline
        .map((graph) => graph.item)
        .filter((item) => (item.id ?? '').startsWith(seriesUid));

      expect(series.find((item) => item.id === seriesUid)?.metadata.recurrenceRule).toEqual([
        'RRULE:FREQ=WEEKLY;BYDAY=FR',
      ]);
      expect(
        series.filter((item) => item.id !== seriesUid).map((item) => item.metadata.recurrenceRule),
      ).toEqual([undefined, undefined]);
    });
  });

  /**
   * STATUS, RFC 5545 §3.8.1.11.
   *
   * The parser read STATUS into its property map and then never used it, so a
   * cancelled event was stored as `confirmed`, and every reader of
   * `ci.events.status` took it for something that happened.
   */
  describe('STATUS', () => {
    it('maps the three VEVENT statuses, in any case, and nothing else', () => {
      expect(icsEventStatus('CANCELLED')).toBe('cancelled');
      expect(icsEventStatus('TENTATIVE')).toBe('tentative');
      expect(icsEventStatus('CONFIRMED')).toBe('confirmed');
      // §3.2: enumerated property values are case-insensitive.
      expect(icsEventStatus('Cancelled')).toBe('cancelled');
      expect(icsEventStatus(' tentative ')).toBe('tentative');

      // VTODO and VJOURNAL values say nothing about an event, and no STATUS at
      // all leaves the column DEFAULT.
      expect(icsEventStatus('NEEDS-ACTION')).toBeUndefined();
      expect(icsEventStatus('COMPLETED')).toBeUndefined();
      expect(icsEventStatus('')).toBeUndefined();
      expect(icsEventStatus(undefined)).toBeUndefined();
    });

    it('states a cancelled occurrence of a series as cancelled, under its override id', async () => {
      // How Google Takeout writes "delete just this one": the series master,
      // then a block repeating its UID with the occurrence's RECURRENCE-ID and
      // STATUS:CANCELLED. The override has to arrive cancelled. The stored row
      // is what stops the calendar synthesizing that occurrence
      // (`dropExistingOverrides`), so dropping the block instead would bring
      // the meeting back.
      const icsPath = icsFile('ci-ics-status-', 'status.ics', [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
        'BEGIN:VEVENT',
        'DTSTART;TZID=America/Los_Angeles:20221006T010000',
        'DTEND;TZID=America/Los_Angeles:20221006T020000',
        'RRULE:FREQ=WEEKLY;BYDAY=TH',
        'UID:weekly-sync@google.com',
        'STATUS:CONFIRMED',
        'SUMMARY:Weekly sync',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'DTSTART;TZID=America/Los_Angeles:20221013T010000',
        'DTEND;TZID=America/Los_Angeles:20221013T020000',
        'UID:weekly-sync@google.com',
        'RECURRENCE-ID;TZID=America/Los_Angeles:20221013T010000',
        'STATUS:CANCELLED',
        'SUMMARY:Weekly sync',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'DTSTART:20221014T170000Z',
        'UID:maybe-lunch@google.com',
        'STATUS:TENTATIVE',
        'SUMMARY:Lunch?',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'DTSTART:20221015T170000Z',
        'UID:no-status@example.com',
        'SUMMARY:A calendar that writes no STATUS',
        'END:VEVENT',
        'END:VCALENDAR',
      ]);

      try {
        const items = (await importIcs(icsPath)).filter((graph) => graph.item).map((graph) => graph.item);
        const statusOf = (id: string) => items.find((item) => item.id === id)?.metadata.eventStatus;

        // 01:00 America/Los_Angeles on 2022-10-13 (PDT, UTC-7) is 08:00Z.
        expect(items.map((item) => item.id)).toContain('weekly-sync@google.com#20221013T080000Z');
        expect(statusOf('weekly-sync@google.com#20221013T080000Z')).toBe('cancelled');
        expect(statusOf('weekly-sync@google.com')).toBe('confirmed');
        expect(statusOf('maybe-lunch@google.com')).toBe('tentative');
        expect(statusOf('no-status@example.com')).toBeUndefined();
      } finally {
        fs.rmSync(path.dirname(icsPath), { recursive: true, force: true });
      }
    });

    it("reads the event's own STATUS, never a nested component's", () => {
      // RFC 5545 gives VALARM no STATUS, but the parser must not rely on that:
      // a stray one inside the block cannot cancel the event around it.
      const block = (own: string[]) =>
        [
          'BEGIN:VCALENDAR',
          'BEGIN:VEVENT',
          'UID:nested@x',
          'DTSTART:20260101T090000Z',
          ...own,
          'BEGIN:VALARM',
          'ACTION:DISPLAY',
          'TRIGGER:-PT10M',
          'STATUS:CANCELLED',
          'END:VALARM',
          'END:VEVENT',
          'END:VCALENDAR',
        ].join('\r\n');

      expect(parseIcsEvents(block([]), 'nested.ics')[0].status).toBeUndefined();
      expect(parseIcsEvents(block(['STATUS:CONFIRMED']), 'nested.ics')[0].status).toBe('confirmed');
    });
  });
});

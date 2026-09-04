import {
  CHROMIUM_EPOCH_OFFSET_MS,
  browserBookmarkIdentity,
  browserDownloadIdentity,
  browserVisitIdentity,
  unixMsFromApiMillis,
  unixMsFromChromiumMicros,
  unixMsFromMicros,
} from '../browser';
import { calendarEventIdentity, icsRecurrenceInstant, normalizeIcsRecurrenceId } from '../calendar';
import {
  emailAttachmentIdentity,
  emailFallbackIdentity,
  emailIdentity,
  emailThreadKey,
  gmailThreadKeyFromApi,
  gmailThreadKeyFromImap,
  messageIdFromHeaders,
  normalizeMessageId,
} from '../email';
import { facebookPostIdentity } from '../facebook';
import { fileIdentity } from '../file';
import { isRedditCommentFullname, redditBareId, redditIdentity, redditRecordId } from '../reddit';
import {
  FEDERATED_SYSTEMS,
  PLATFORM_SYSTEMS,
  SYSTEM_ALIASES,
  attachmentIdentity,
  canonicalSystem,
  isFederatedSystem,
  ledgerPlatform,
  fallbackId,
  isRegisteredSystem,
  platformIdentity,
} from '../registry';
import { youtubeLikeIdentity, youtubeSubscriptionIdentity, youtubeVideoIdFromUrl } from '../youtube';

describe('identity registry', () => {
  it('registers every federated kind', () => {
    for (const system of Object.values(FEDERATED_SYSTEMS)) {
      expect(isRegisteredSystem(system)).toBe(true);
    }
  });

  it('resolves every alias to a registered canonical name', () => {
    for (const [alias, canonical] of Object.entries(SYSTEM_ALIASES)) {
      expect(isRegisteredSystem(canonical)).toBe(true);
      expect(canonicalSystem(alias)).toBe(canonical);
    }
  });

  it('canonicalizes the historically drifted spellings', () => {
    expect(canonicalSystem('github_events')).toBe('github');
    expect(canonicalSystem('reddit_comments')).toBe('reddit');
    expect(canonicalSystem('reddit_posts')).toBe('reddit');
    expect(canonicalSystem('ics')).toBe('calendar');
  });

  it('passes unknown systems through unchanged (runtime never rejects data)', () => {
    expect(canonicalSystem('some_future_platform')).toBe('some_future_platform');
  });

  it('platformIdentity joins parts with ":" and canonicalizes the system', () => {
    const identity = platformIdentity('github_events', 'push', '12345');
    expect(identity.system).toBe('github');
    expect(identity.id).toBe('push:12345');
  });

  it('platformIdentity with one part is byte-identical to the input', () => {
    expect(platformIdentity('spotify', 'spotify:track:abc').id).toBe('spotify:track:abc');
  });

  it('marks fallback ids so the non-converging population stays queryable', () => {
    expect(fallbackId('deadbeef')).toBe('fallback:deadbeef');
  });

  it('has no duplicate platform registrations', () => {
    expect(new Set(PLATFORM_SYSTEMS).size).toBe(PLATFORM_SYSTEMS.length);
  });
});

describe('ledger platform (record_sources.platform)', () => {
  it('a platform kind is its own platform', () => {
    expect(ledgerPlatform('reddit')).toBe('reddit');
    expect(ledgerPlatform('google_chrome')).toBe('chromium'); // canonicalized
  });

  it('a federated kind has no platform unless the producer says', () => {
    expect(isFederatedSystem('email')).toBe(true);
    expect(ledgerPlatform('email')).toBeNull();
    expect(ledgerPlatform('calendar')).toBeNull();
    expect(ledgerPlatform('file')).toBeNull();
    expect(ledgerPlatform('email', 'gmail')).toBe('gmail');
    expect(ledgerPlatform('email', 'outlook_mail')).toBe('outlook_mail');
  });

  it('never lets a federated kind pose as a platform, even when passed explicitly', () => {
    // A generic mbox reader's datasource name is `email`: that is not a mailbox.
    expect(ledgerPlatform('email', 'email')).toBeNull();
    expect(ledgerPlatform('calendar', 'ics')).toBeNull(); // alias of the federated kind
    expect(ledgerPlatform(undefined)).toBeNull();
  });
});

describe('email identity (federated on RFC Message-ID)', () => {
  it('normalizes angle brackets and whitespace, preserving case', () => {
    expect(normalizeMessageId(' <CAF+QMz-AbC@mail.gmail.com> ')).toBe('CAF+QMz-AbC@mail.gmail.com');
  });

  it('finds Message-ID case-insensitively across producer spellings', () => {
    expect(messageIdFromHeaders({ 'Message-Id': '<x@y>' })).toBe('<x@y>');
    expect(messageIdFromHeaders({ 'message-id': '<x@y>' })).toBe('<x@y>');
    expect(messageIdFromHeaders({ Subject: 'hi' })).toBeUndefined();
  });

  it('returns null (never a bogus federated id) when the header is missing', () => {
    expect(emailIdentity(undefined)).toBeNull();
    expect(emailIdentity('  ')).toBeNull();
    expect(emailIdentity('<>')).toBeNull();
  });

  // THE conformance property: the Gmail API path, the Graph API path, and the
  // mbox/eml path all reduce the same message to the same identity pair.
  it('CONFORMANCE: API headers and MIME headers yield identical identity', () => {
    // Shape 1: Gmail API payload.headers (name/value array, mixed case).
    const apiHeaders = { 'Message-ID': '<CAF+QMz-AbC@mail.gmail.com>' };
    // Shape 2: mbox headers map (raw MIME, same message).
    const mimeHeaders = { 'Message-ID': '<CAF+QMz-AbC@mail.gmail.com>' };
    // Shape 3: Graph internetMessageId (string, angle brackets included).
    const graphInternetMessageId = '<CAF+QMz-AbC@mail.gmail.com>';

    const fromApi = emailIdentity(messageIdFromHeaders(apiHeaders));
    const fromMime = emailIdentity(messageIdFromHeaders(mimeHeaders));
    const fromGraph = emailIdentity(graphInternetMessageId);

    expect(fromApi).not.toBeNull();
    expect(fromApi!.system).toBe('email');
    expect(fromApi!.id).toBe('CAF+QMz-AbC@mail.gmail.com');
    expect(fromMime).toEqual(fromApi);
    expect(fromGraph).toEqual(fromApi);
  });

  it('scopes fallbacks to the delivering platform and keeps them deterministic', () => {
    const a = emailFallbackIdentity('gmail', 'gmail-api:12345');
    const b = emailFallbackIdentity('gmail', 'gmail-api:12345');
    expect(a).toEqual(b);
    expect(a.system).toBe('gmail');
    expect(a.id).toMatch(/^fallback:[0-9a-f]{64}$/);
    // A different platform's fallback for "the same" material must not collide
    // into a shared namespace.
    expect(emailFallbackIdentity('outlook_mail', 'gmail-api:12345').system).toBe('outlook_mail');
  });

  it('keys attachments on parent identity plus bytes hash, not index', () => {
    const parent = emailIdentity('<m@x>')!;
    expect(emailAttachmentIdentity(parent, 'abc123').id).toBe('attachment:m@x:abc123');
    expect(emailAttachmentIdentity(parent, 'abc123').system).toBe('email');
  });

  it('the generic attachment builder is the same format under any parent, hash lowercased', () => {
    const chat = platformIdentity('twitter', 'dm', '9');
    expect(attachmentIdentity(chat, 'ABCDEF')).toEqual({ system: 'twitter', id: 'attachment:dm:9:abcdef' });
    expect(attachmentIdentity(emailIdentity('<m@x>')!, 'abc')).toEqual(
      emailAttachmentIdentity(emailIdentity('<m@x>')!, 'abc'),
    );
  });
});

describe('email thread key (Gmail hex threadId vs mbox X-GM-THRID)', () => {
  it('CONFORMANCE: the API hex and the IMAP decimal of one thread yield one key', () => {
    expect(gmailThreadKeyFromApi('18c1a2b3c4d5e6f7')).toBe('18c1a2b3c4d5e6f7');
    expect(gmailThreadKeyFromImap('1783885820400625399')).toBe('18c1a2b3c4d5e6f7');
    expect(emailThreadKey({ 'X-GM-THRID': '1783885820400625399' })).toBe(
      gmailThreadKeyFromApi('18c1a2b3c4d5e6f7'),
    );
  });

  it('normalizes case, whitespace and leading zeros to the one spelling', () => {
    expect(gmailThreadKeyFromApi(' 18C1A2B3C4D5E6F7 ')).toBe('18c1a2b3c4d5e6f7');
    expect(gmailThreadKeyFromApi('0018c1a2b3c4d5e6f7')).toBe('18c1a2b3c4d5e6f7');
    expect(gmailThreadKeyFromImap(' 01783885820400625399 ')).toBe('18c1a2b3c4d5e6f7');
  });

  it('refuses a value that is not in the base the caller claimed', () => {
    expect(gmailThreadKeyFromApi('thread-1')).toBeUndefined();
    expect(gmailThreadKeyFromApi('')).toBeUndefined();
    expect(gmailThreadKeyFromApi(undefined)).toBeUndefined();
    expect(gmailThreadKeyFromImap('18c1a2b3c4d5e6f7')).toBeUndefined(); // hex digits are not decimal
    expect(gmailThreadKeyFromImap(null)).toBeUndefined();
  });

  it('prefers the Gmail thread id over the References chain when the mbox carries both', () => {
    expect(
      emailThreadKey({
        'x-gm-thrid': '1783885820400625399',
        References: '<root@mx.example.com> <parent@mx.example.com>',
        'Message-ID': '<reply@mx.example.com>',
      }),
    ).toBe('18c1a2b3c4d5e6f7');
  });

  it('falls back to References root, then In-Reply-To, then the own Message-ID', () => {
    expect(
      emailThreadKey({
        References: '<root@x> <parent@x>',
        'In-Reply-To': '<parent@x>',
        'Message-ID': '<me@x>',
      }),
    ).toBe('root@x');
    expect(emailThreadKey({ 'In-Reply-To': '<parent@x>', 'Message-ID': '<me@x>' })).toBe('parent@x');
    expect(emailThreadKey({ 'Message-ID': '<me@x>' })).toBe('me@x');
    expect(emailThreadKey({ Subject: 'none' })).toBeUndefined();
    expect(emailThreadKey(undefined)).toBeUndefined();
  });
});

describe('calendar identity (federated on iCalUID)', () => {
  it('keys a series master on the bare UID', () => {
    const identity = calendarEventIdentity('abc123@google.com');
    expect(identity).toEqual({ system: 'calendar', id: 'abc123@google.com' });
  });

  it('keys an override as uid#recurrence-id — the ICS importer format', () => {
    const identity = calendarEventIdentity('abc123@google.com', '20260901T170000Z');
    expect(identity!.id).toBe('abc123@google.com#20260901T170000Z');
  });

  it('returns null for a missing UID', () => {
    expect(calendarEventIdentity(undefined)).toBeNull();
    expect(calendarEventIdentity('  ')).toBeNull();
  });

  // CONFORMANCE: a Google API instance (originalStartTime.dateTime) and the
  // Takeout .ics of the same override (RECURRENCE-ID in UTC basic format)
  // reduce to the same id.
  it('CONFORMANCE: API originalStartTime matches a UTC .ics RECURRENCE-ID', () => {
    const fromApi = calendarEventIdentity(
      'abc123@google.com',
      icsRecurrenceInstant(new Date('2026-09-01T17:00:00.000Z')),
    );
    const icsUid = 'abc123@google.com';
    const icsRecurrenceId = '20260901T170000Z';
    const fromIcs = { system: 'calendar', id: `${icsUid}#${icsRecurrenceId}` };
    expect(fromApi).toEqual(fromIcs);
  });

  it('formats instants as ICS UTC basic', () => {
    expect(icsRecurrenceInstant(new Date('2026-09-01T17:00:00.000Z'))).toBe('20260901T170000Z');
  });

  // Real pairs off a Takeout + connection run: the .ics wrote local-with-TZID,
  // the API wrote UTC, and 42 overrides duplicated. One fixture per DST phase.
  it('CONFORMANCE: normalizes a TZID-local RECURRENCE-ID to the UTC spelling (PDT)', () => {
    expect(normalizeIcsRecurrenceId('20221006T010000', 'America/Los_Angeles')).toBe('20221006T080000Z');
  });

  it('CONFORMANCE: normalizes across the DST boundary (PST)', () => {
    expect(normalizeIcsRecurrenceId('20251114T130000', 'America/Los_Angeles')).toBe('20251114T210000Z');
  });

  it('the normalized suffix keys the same identity the ETL derives', () => {
    const fromIcs = calendarEventIdentity(
      'abc@google.com',
      normalizeIcsRecurrenceId('20221006T010000', 'America/Los_Angeles'),
    );
    const fromApi = calendarEventIdentity(
      'abc@google.com',
      icsRecurrenceInstant(new Date('2022-10-06T08:00:00.000Z')),
    );

    expect(fromIcs).toEqual(fromApi);
  });

  it('leaves already-UTC, date-only, floating, and unknown-TZID values untouched', () => {
    expect(normalizeIcsRecurrenceId('20221006T080000Z', 'America/Los_Angeles')).toBe('20221006T080000Z');
    expect(normalizeIcsRecurrenceId('20221006', 'America/Los_Angeles')).toBe('20221006');
    // Floating time: RFC 5545 gives it no zone; converting would be a guess.
    expect(normalizeIcsRecurrenceId('20221006T010000', null)).toBe('20221006T010000');
    // A custom VTIMEZONE id the runtime cannot resolve: local beats wrong.
    expect(normalizeIcsRecurrenceId('20221006T010000', 'Custom/Office_Zone')).toBe('20221006T010000');
  });
});

describe('youtube identity (platform kind)', () => {
  it('extracts the video id from every URL shape YouTube uses', () => {
    expect(youtubeVideoIdFromUrl('https://www.youtube.com/watch?v=dRt-DNXCti8')).toBe('dRt-DNXCti8');
    expect(youtubeVideoIdFromUrl('https://music.youtube.com/watch?v=abc123DEF45&list=x')).toBe('abc123DEF45');
    expect(youtubeVideoIdFromUrl('https://youtu.be/u5ozNRUW7Kw')).toBe('u5ozNRUW7Kw');
    expect(youtubeVideoIdFromUrl('https://www.youtube.com/shorts/TibXnvtziRI')).toBe('TibXnvtziRI');
    expect(youtubeVideoIdFromUrl('https://www.youtube.com/results?search_query=x')).toBeNull();
    expect(youtubeVideoIdFromUrl(undefined)).toBeNull();
  });

  // CONFORMANCE: the exact duplication observed on a real Takeout +
  // connection run — ETL minted `like:<videoId>` / `subscription:<id>` while
  // the importer hashed the URL / spelled `youtube:sub:`. One constructor
  // now serves both pipelines.
  it('CONFORMANCE: like and subscription identities are the connection formats', () => {
    expect(youtubeLikeIdentity('u5ozNRUW7Kw')).toEqual({ system: 'youtube', id: 'like:u5ozNRUW7Kw' });
    expect(youtubeSubscriptionIdentity('UC6IxnFzHofFJ5X2PycSMsww')).toEqual({
      system: 'youtube',
      id: 'subscription:UC6IxnFzHofFJ5X2PycSMsww',
    });
  });
});

describe('facebook post identity (fallback-tier tuple)', () => {
  const at = new Date('2018-07-06T17:30:00Z');

  it('keys on posting second + normalized text hash, deterministically', () => {
    const a = facebookPostIdentity(at, 'Check this feed out.');
    const b = facebookPostIdentity(new Date(at), '  Check   this\nfeed out. ');

    expect(a.system).toBe('facebook');
    expect(a.id).toMatch(/^post:1530898200:[0-9a-f]{16}$/);
    // Whitespace differences between the API's and the export's rendering of
    // one post must not split the identity.
    expect(b).toEqual(a);
  });

  it('keeps same-second posts with different text distinct', () => {
    expect(facebookPostIdentity(at, 'one').id).not.toBe(facebookPostIdentity(at, 'two').id);
  });
});

describe('file identity (federated on content hash)', () => {
  it('keys on lowercased sha256', () => {
    expect(fileIdentity('ABCDEF')).toEqual({ system: 'file', id: 'sha256:abcdef' });
  });
});

describe("browser identity (platform-scoped on the browser's own visit instant)", () => {
  // One Chrome visit, three arrival shapes. The fixture is deliberately NOT on
  // a whole millisecond: the sub-ms fraction is where the producers differ, and
  // the key has to truncate it identically on every side.
  //
  //   Takeout History.json   time_usec   = Unix microseconds
  //   History SQLite         visit_time  = microseconds since 1601-01-01
  //   chrome.history API     visitTime   = double of Unix milliseconds
  //
  // The extension's test suite (CI-Browser-Extension,
  // src/services/browserActivity.test.ts) pins these SAME fixtures — that is
  // the conformance contract across the repo boundary.
  const URL = 'https://example.com/path?q=1#frag';
  const UNIX_MS = 1749556800123; // 2025-06-10T12:00:00.123Z
  const TAKEOUT_USEC = UNIX_MS * 1000 + 456;
  const WEBKIT_USEC = TAKEOUT_USEC + CHROMIUM_EPOCH_OFFSET_MS * 1000;
  const API_MS = UNIX_MS + 0.456;

  it('CONFORMANCE: Takeout, History SQLite and the extension yield identical visit identity', () => {
    const fromTakeout = browserVisitIdentity('chromium', URL, unixMsFromMicros(TAKEOUT_USEC));
    const fromSqlite = browserVisitIdentity('chromium', URL, unixMsFromChromiumMicros(WEBKIT_USEC));
    const fromExtension = browserVisitIdentity('chromium', URL, unixMsFromApiMillis(API_MS));

    expect(fromTakeout).toEqual({ system: 'chromium', id: `visit:${UNIX_MS}:${URL}` });
    expect(fromSqlite).toEqual(fromTakeout);
    expect(fromExtension).toEqual(fromTakeout);
  });

  it('truncates, never rounds, so a .9995 instant agrees on every side', () => {
    const ms = 1749556800999;
    expect(unixMsFromMicros(ms * 1000 + 999)).toBe(ms);
    expect(
      unixMsFromChromiumMicros(BigInt(ms) * 1000n + 999n + BigInt(CHROMIUM_EPOCH_OFFSET_MS) * 1000n),
    ).toBe(ms);
    expect(unixMsFromApiMillis(ms + 0.999)).toBe(ms);
  });

  // Chromium stamps are above 2^53. As a JS number the `...999999` below has
  // already become `...000000` — one millisecond late, a different key. The
  // exact forms (BigInt from safeIntegers, the Bookmarks JSON's string) hold.
  it('reads a Chromium stamp exactly from a BigInt or decimal string, where a Number cannot', () => {
    const exact = 13394030400999999n; // 2025-06-10T12:00:00.999999Z in 1601-epoch µs
    expect(exact > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(unixMsFromChromiumMicros(exact)).toBe(1749556800999);
    expect(unixMsFromChromiumMicros('13394030400999999')).toBe(1749556800999);
    expect(unixMsFromChromiumMicros(' 13394030400999999 ')).toBe(1749556800999);
    // The lossy path, documented rather than hidden: the Number is already off.
    expect(unixMsFromChromiumMicros(Number(exact))).toBe(1749556801000);
    expect(unixMsFromChromiumMicros('not-a-stamp')).toBeUndefined();
    expect(unixMsFromChromiumMicros('')).toBeUndefined();
  });

  it("keys bookmarks on whole seconds — Takeout's Bookmarks.html only has ADD_DATE seconds", () => {
    const takeoutAddDateSeconds = 1749556800;
    const fromTakeout = browserBookmarkIdentity('chromium', URL, takeoutAddDateSeconds * 1000);
    const fromSqlite = browserBookmarkIdentity('chromium', URL, unixMsFromChromiumMicros(WEBKIT_USEC));
    const fromExtension = browserBookmarkIdentity('chromium', URL, unixMsFromApiMillis(API_MS));

    expect(fromTakeout.id).toBe(`bookmark:${takeoutAddDateSeconds}:${URL}`);
    expect(fromSqlite).toEqual(fromTakeout);
    expect(fromExtension).toEqual(fromTakeout);
  });

  it('keys downloads on (start ms, final url)', () => {
    expect(browserDownloadIdentity('chromium', URL, UNIX_MS).id).toBe(`download:${UNIX_MS}:${URL}`);
  });

  it('keeps undated records unique per url instead of inventing an instant', () => {
    expect(browserVisitIdentity('firefox', URL, undefined).id).toBe(`visit:0:${URL}`);
    expect(browserBookmarkIdentity('firefox', URL, undefined).id).toBe(`bookmark:0:${URL}`);
    expect(unixMsFromMicros(0)).toBeUndefined();
    expect(unixMsFromChromiumMicros(0)).toBeUndefined();
    expect(unixMsFromApiMillis(NaN)).toBeUndefined();
  });

  it('folds every Chromium-family brand into one system, and Firefox stays its own', () => {
    for (const brand of ['chrome', 'google_chrome', 'brave', 'edge', 'arc', 'opera']) {
      expect(canonicalSystem(brand)).toBe('chromium');
    }

    expect(canonicalSystem('firefox')).toBe('firefox');
    expect(browserVisitIdentity('firefox', URL, UNIX_MS).system).toBe('firefox');
    expect(isRegisteredSystem('safari')).toBe(true);
  });
});

describe('reddit identities', () => {
  it('strips the fullname prefix so the API (t3_xfkamy) and the CSV (xfkamy) agree', () => {
    expect(redditBareId('t3_xfkamy')).toBe('xfkamy');
    expect(redditBareId('t1_iomlcrs')).toBe('iomlcrs');
    expect(redditBareId('xfkamy')).toBe('xfkamy');
    // A permalink (the importer's fallback key when a CSV row has no id) passes through.
    expect(redditBareId('/r/x/comments/abc/t/')).toBe('/r/x/comments/abc/t/');
  });

  it("mints the importer's staged-id spelling, verbatim, as the source_id", () => {
    expect(redditRecordId('post', 'xfkamy')).toBe('reddit:post:xfkamy');
    expect(redditIdentity('post', 't3_xfkamy')).toEqual({ system: 'reddit', id: 'reddit:post:xfkamy' });
    expect(redditIdentity('comment', 't1_iomlcrs')).toEqual({
      system: 'reddit',
      id: 'reddit:comment:iomlcrs',
    });
  });

  it('keeps authored and saved copies of the same thing distinct, as both exports do', () => {
    expect(redditIdentity('saved_post', 't3_xfkamy').id).toBe('reddit:saved_post:xfkamy');
    expect(redditIdentity('saved_post', 't3_xfkamy').id).not.toBe(redditIdentity('post', 't3_xfkamy').id);
  });

  it('tells a saved comment from a saved post by the fullname prefix', () => {
    expect(isRedditCommentFullname('t1_abc')).toBe(true);
    expect(isRedditCommentFullname('t3_abc')).toBe(false);
  });
});

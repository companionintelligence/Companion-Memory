import { calendarEventIdentity, icsRecurrenceInstant, normalizeIcsRecurrenceId } from '../calendar';
import { emailAttachmentIdentity, emailFallbackIdentity, emailIdentity, messageIdFromHeaders, normalizeMessageId } from '../email';
import { facebookPostIdentity } from '../facebook';
import { fileIdentity } from '../file';
import {
  FEDERATED_SYSTEMS,
  PLATFORM_SYSTEMS,
  SYSTEM_ALIASES,
  canonicalSystem,
  fallbackId,
  isRegisteredSystem,
  platformIdentity,
} from '../registry';
import {
  youtubeLikeIdentity,
  youtubeSubscriptionIdentity,
  youtubeVideoIdFromUrl,
} from '../youtube';

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

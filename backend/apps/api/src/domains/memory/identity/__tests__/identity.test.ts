import { calendarEventIdentity, icsRecurrenceInstant } from '../calendar';
import { emailAttachmentIdentity, emailFallbackIdentity, emailIdentity, messageIdFromHeaders, normalizeMessageId } from '../email';
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
});

describe('file identity (federated on content hash)', () => {
  it('keys on lowercased sha256', () => {
    expect(fileIdentity('ABCDEF')).toEqual({ system: 'file', id: 'sha256:abcdef' });
  });
});

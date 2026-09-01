import { emailIdentity, messageIdFromHeaders } from '@ci/domains/memory';

import { headersFromGmailApi } from '../../datasources/human_correspondence';
import type { StagedItem } from '../../entities/StagedItemEntity';
import { toCanonical, type CanonicalRecord } from '../canonical';
import { toCommunicationInput, toEventInput } from '../inputs';

/**
 * Cross-pipeline conformance (docs/design/cross-pipeline-identity.md §7): the
 * same real-world datum arriving through the import pipeline and through the
 * connection ETL must produce byte-identical (source_system, source_id) — that
 * pair IS the unique index now, so equality here is what makes the two
 * arrivals converge on one row instead of duplicating.
 *
 * The fixtures hold the same datum in both arrival shapes. A new connection
 * with an importer counterpart adds its pair here; this suite is the
 * definition of "converges".
 */

function recordFor(overrides: Partial<StagedItem> = {}): CanonicalRecord {
  return toCanonical({
    id: '11111111-1111-4111-8111-111111111111',
    runId: '22222222-2222-4222-8222-222222222222',
    userId: '33333333-3333-4333-8333-333333333333',
    dataSource: 'gmail',
    classification: 'email',
    contentHash: 'hash-1',
    occurredAt: new Date('2024-03-02T10:00:00Z'),
    timespanEnd: null,
    latitude: null,
    longitude: null,
    filename: null,
    mediaType: null,
    originalLocation: null,
    intermediateLocation: null,
    metadata: {},
    createdAt: new Date('2026-08-12T00:00:00Z'),
    ...overrides,
  } as StagedItem);
}

describe('email: Takeout mbox import vs Gmail API connection', () => {
  // One message, two arrival shapes.
  const RFC_MESSAGE_ID = '<CAF+QMz-AbC123@mail.gmail.com>';

  it('the import path keys the communication on (email, <normalized Message-ID>)', () => {
    // The mbox datasource stores the normalized Message-ID in metadata
    // (datasources/gmail.ts stamps MessageID via normalizeMessageId).
    const record = recordFor({
      metadata: { MessageID: 'CAF+QMz-AbC123@mail.gmail.com' },
    });

    const input = toCommunicationInput(record);
    expect(input.source_system).toBe('email');
    expect(input.source_id).toBe('CAF+QMz-AbC123@mail.gmail.com');
  });

  it('the ETL path derives the identical pair from the API headers', () => {
    // TransformGmail: payload.headers -> Message-ID header -> emailIdentity.
    const apiHeaders = headersFromGmailApi({
      headers: [
        { name: 'Subject', value: 'Dinner?' },
        { name: 'Message-ID', value: RFC_MESSAGE_ID },
      ],
      labelIds: ['INBOX'],
    });

    const identity = emailIdentity(messageIdFromHeaders(apiHeaders));
    expect(identity).not.toBeNull();
    expect(identity!.system).toBe('email');
    expect(identity!.id).toBe('CAF+QMz-AbC123@mail.gmail.com');
  });

  it('CONVERGES: both pipelines produce byte-identical identity for one message', () => {
    const importInput = toCommunicationInput(
      recordFor({ metadata: { MessageID: 'CAF+QMz-AbC123@mail.gmail.com' } }),
    );
    const etlIdentity = emailIdentity(
      messageIdFromHeaders(
        headersFromGmailApi({ headers: [{ name: 'Message-Id', value: RFC_MESSAGE_ID }] }),
      ),
    )!;

    expect(importInput.source_system).toBe(etlIdentity.system);
    expect(importInput.source_id).toBe(etlIdentity.id);
  });

  it('Message-ID-less mail stays in the per-pipeline namespace (no false federation)', () => {
    const input = toCommunicationInput(recordFor({ metadata: {} }));
    expect(input.source_system).toBe('gmail');
    expect(input.source_id).not.toMatch(/^email/);
  });
});

describe('calendar: .ics import vs Google Calendar API connection', () => {
  // The ICS importer keys events on the VEVENT UID (datasources/calendar.ts:
  // items.id = UID, `#<RECURRENCE-ID>`-suffixed for overrides), and the
  // datasource name 'calendar' IS the federated system name — so the import
  // path lands on (calendar, <uid>) with no remapping. The ETL side
  // (TransformGoogleCalendar) mints the same pair via calendarEventIdentity;
  // the builder-level equality is asserted in
  // domains/memory/identity/__tests__/identity.test.ts. Here: the import
  // mapping preserves the UID bytes end-to-end.
  it('the import path keys the event on (calendar, <uid>)', () => {
    const record = recordFor({
      dataSource: 'calendar',
      classification: 'calendar_event',
      // sourceIdFor keys on content_hash, which for the ICS importer is the
      // parser's own id — the VEVENT UID.
      contentHash: 'abc123@google.com',
      metadata: { Summary: 'Dentist' },
    });

    const input = toEventInput(record);
    expect(input.source_system).toBe('calendar');
    expect(input.source_id).toBe('abc123@google.com');
  });
});

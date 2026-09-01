import {
  emailIdentity,
  facebookPostIdentity,
  messageIdFromHeaders,
  youtubeLikeIdentity,
  youtubeSubscriptionIdentity,
} from '@ci/domains/memory';

import { headersFromGmailApi } from '../../datasources/human_correspondence';
import type { StagedItem } from '../../entities/StagedItemEntity';
import { toCanonical, type CanonicalRecord } from '../canonical';
import { destinationsFor } from '../canonical';
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

describe('youtube: Takeout import vs Data API connection', () => {
  // The importer datasources mint canonical ids at stage time (the video id
  // off the watch URL, the channel id off subscriptions.csv), so the push
  // mapping passes them through verbatim; the ETL transforms mint the same
  // ids from the API's native ids via the shared builders.
  it('a liked video converges on (youtube, like:<videoId>)', () => {
    const record = recordFor({
      dataSource: 'youtube',
      classification: 'like',
      contentHash: 'like:u5ozNRUW7Kw', // datasources/_youtube_activity.ts, from watch?v=
      metadata: { URL: 'https://www.youtube.com/watch?v=u5ozNRUW7Kw', Kind: 'like' },
    });

    const input = toEventInput(record);
    const etl = youtubeLikeIdentity('u5ozNRUW7Kw');

    expect(input.source_system).toBe(etl.system);
    expect(input.source_id).toBe(etl.id);
  });

  it('a subscription converges on (youtube, subscription:<channelId>)', () => {
    const record = recordFor({
      dataSource: 'youtube',
      classification: 'subscription',
      contentHash: 'subscription:UC6IxnFzHofFJ5X2PycSMsww', // datasources/youtube.ts, from Channel Id
      metadata: { Channel: 'Some Channel' },
    });

    const input = toEventInput(record);
    const etl = youtubeSubscriptionIdentity('UC6IxnFzHofFJ5X2PycSMsww');

    expect(input.source_system).toBe(etl.system);
    expect(input.source_id).toBe(etl.id);
  });
});

describe('facebook posts: Meta archive import vs Graph connection', () => {
  const postRecord = () =>
    recordFor({
      dataSource: 'facebook',
      classification: 'social',
      occurredAt: new Date('2018-07-06T17:30:00Z'),
      metadata: { Text: 'Check this feed out.', Source: 'Facebook' },
    });

  it('routes an archived post to /communications — the connection\'s table', () => {
    expect(destinationsFor(postRecord())).toEqual(['communications']);
  });

  it('CONVERGES on the tuple identity the connection mints for the same post', () => {
    const input = toCommunicationInput(postRecord());
    const etl = facebookPostIdentity(new Date('2018-07-06T17:30:00Z'), 'Check this feed out.');

    expect(input.communication_type).toBe('post');
    expect(input.direction).toBe('outbound');
    expect(input.source_system).toBe(etl.system);
    expect(input.source_id).toBe(etl.id);
  });

  it('an undated post stays content-only (communications.time is NOT NULL)', () => {
    const undated = recordFor({
      dataSource: 'facebook',
      classification: 'social',
      occurredAt: null as unknown as Date,
      metadata: { Text: 'no date on this one', Source: 'Facebook' },
    });

    expect(destinationsFor(undated)).toEqual(['content']);
  });
});

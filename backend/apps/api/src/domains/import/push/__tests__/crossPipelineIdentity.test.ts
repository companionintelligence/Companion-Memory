import {
  adoptIngestIdentity,
  browserBookmarkIdentity,
  browserVisitIdentity,
  emailIdentity,
  emailThreadKey,
  facebookPageLikeIdentity,
  facebookPostIdentity,
  fileIdentity,
  gmailThreadKeyFromApi,
  messageIdFromHeaders,
  redditIdentity,
  redditRecordId,
  unixMsFromApiMillis,
  youtubeLikeIdentity,
  youtubeSubscriptionIdentity,
} from '@ci/domains/memory';

import { headersFromGmailApi } from '../../datasources/human_correspondence';
import type { StagedItem } from '../../entities/StagedItemEntity';
import { toCanonical, withOrigin, type CanonicalRecord } from '../canonical';
import { destinationsFor } from '../canonical';
import { toBrowserActivityInput, toCommunicationInput, toContentInput, toEventInput } from '../inputs';

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
      messageIdFromHeaders(headersFromGmailApi({ headers: [{ name: 'Message-Id', value: RFC_MESSAGE_ID }] })),
    )!;

    expect(importInput.source_system).toBe(etlIdentity.system);
    expect(importInput.source_id).toBe(etlIdentity.id);
  });

  it('ledgers a Takeout mbox arrival under the gmail platform, and a generic mbox under none', () => {
    // record_sources.platform is what lets the doctor pair this archive with
    // the Google connection (which stamps `gmail` too) and NOT pair a
    // Thunderbird export of some other mailbox with it.
    const takeout = toCommunicationInput(recordFor({ dataSource: 'gmail', metadata: { MessageID: 'a@x' } }));
    expect(takeout.source_system).toBe('email');
    expect(takeout.source_platform).toBe('gmail');

    const generic = toCommunicationInput(recordFor({ dataSource: 'email', metadata: { MessageID: 'a@x' } }));
    expect(generic.source_system).toBe('email');
    expect(generic.source_platform).toBeUndefined();
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
    // A bare .ics says nothing about which calendar platform exported it.
    expect(input.source_platform).toBeUndefined();
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

  it("routes an archived post to /communications — the connection's table", () => {
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

  it('carries the photos and videos the media stage stored on the post', () => {
    const withMedia = recordFor({
      dataSource: 'facebook',
      classification: 'social',
      occurredAt: new Date('2026-10-05T17:52:54Z'),
      metadata: {
        Text: 'Post with photo and video',
        Source: 'Facebook',
        AttachmentContent: true,
        AttachmentFileIds: ['file-1', 'file-2'],
        AttachmentContentIds: ['content-1', 'content-2'],
      },
    });

    expect(toCommunicationInput(withMedia).attachments).toEqual([
      { type: 'file', id: 'file-1' },
      { type: 'file', id: 'file-2' },
      { type: 'content', id: 'content-1' },
      { type: 'content', id: 'content-2' },
    ]);
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

describe('facebook liked Pages: Meta archive import vs Graph connection', () => {
  // datasources/facebook.ts reads the Page id off the Page's link in
  // pages_you've_liked.json and stamps facebookPageLikeId as the item id;
  // TransformFacebookLikes mints facebookPageLikeIdentity from /me/likes `id`.
  const likeRecord = () =>
    recordFor({
      dataSource: 'facebook',
      classification: 'like',
      contentHash: 'like:170342537143457',
      occurredAt: new Date('2022-08-29T15:37:56Z'),
      metadata: { Title: 'Liked Facebook page LifeScope', Kind: 'page_like', Source: 'Facebook' },
    });

  it('routes a liked Page to the timeline alone, as the connection does', () => {
    expect(destinationsFor(likeRecord())).toEqual(['events']);
  });

  it('CONVERGES on (facebook, like:<page id>)', () => {
    const input = toEventInput(likeRecord());
    const etl = facebookPageLikeIdentity('170342537143457');

    expect(input.source_system).toBe(etl.system);
    expect(input.source_id).toBe(etl.id);
  });
});

describe('reddit posts/comments: GDPR CSV import vs OAuth listing connection', () => {
  // One post, two arrival shapes. posts.csv carries the bare id (`xfkamy`) and
  // datasources/reddit.ts stamps redditRecordId(kind, id) as the item id, which
  // becomes the staged content_hash and so the source_id. The API carries the
  // same id bare as `id` and prefixed as `name` (`t3_xfkamy`); the connection's
  // RedditRecordWriter mints redditIdentity(kind, name).
  const postRecord = () =>
    recordFor({
      dataSource: 'reddit',
      classification: 'social',
      contentHash: redditRecordId('post', 'xfkamy'),
      occurredAt: new Date('2022-09-15T20:11:00Z'),
      metadata: {
        Title: 'Made a shopping district experience',
        Body: 'the body',
        Subreddit: 'ecommerce',
        Permalink: 'https://www.reddit.com/r/ecommerce/comments/xfkamy/made_a_shopping_district_experience/',
        Kind: 'post',
        Source: 'Reddit',
      },
    });

  it("routes an archived post to /communications — the connection's table — with no content row", () => {
    expect(destinationsFor(postRecord())).toEqual(['communications']);
  });

  it('CONVERGES: both pipelines key the post on (reddit, reddit:post:<bare id>)', () => {
    const input = toCommunicationInput(postRecord());
    const etl = redditIdentity('post', 't3_xfkamy');

    expect(input.communication_type).toBe('post');
    expect(input.direction).toBe('outbound');
    expect(input.thread_id).toBe('r/ecommerce');
    expect(input.source_system).toBe(etl.system);
    expect(input.source_id).toBe(etl.id);
    expect(input.source_id).toBe('reddit:post:xfkamy');
  });

  it('a comment converges the same way, and a SAVED one keys separately and reads inbound', () => {
    const comment = recordFor({
      dataSource: 'reddit',
      classification: 'social',
      contentHash: redditRecordId('comment', 'iomlcrs'),
      metadata: { Body: 'nice', Subreddit: 'ecommerce', Kind: 'comment', Source: 'Reddit' },
    });
    expect(toCommunicationInput(comment).source_id).toBe(redditIdentity('comment', 't1_iomlcrs').id);

    const saved = recordFor({
      dataSource: 'reddit',
      classification: 'social',
      contentHash: redditRecordId('saved_post', 'xfkamy'),
      metadata: {
        Permalink: 'https://www.reddit.com/r/x/comments/xfkamy/s/',
        Kind: 'saved_post',
        Source: 'Reddit',
      },
    });
    const savedInput = toCommunicationInput(saved);
    expect(savedInput.direction).toBe('inbound');
    expect(savedInput.source_id).toBe(redditIdentity('saved_post', 't3_xfkamy').id);
    expect(savedInput.source_id).not.toBe(redditIdentity('post', 't3_xfkamy').id);
  });

  it('a link post pointing at media adds a content row under the SAME key (both pipelines)', () => {
    const record = recordFor({
      dataSource: 'reddit',
      classification: 'social',
      contentHash: redditRecordId('post', 'abc'),
      metadata: {
        Title: 'Cat',
        URL: 'https://i.redd.it/cat.png',
        Subreddit: 'pics',
        Kind: 'post',
        Source: 'Reddit',
      },
    });

    expect(destinationsFor(record)).toEqual(['communications', 'content']);
    const content = toContentInput(record);
    expect(content.type).toBe('image');
    expect(content.url).toBe('https://i.redd.it/cat.png');
    expect(content.source_id).toBe(redditIdentity('post', 't3_abc').id);
  });

  it('an undated saved post stays content-only (communications.time is NOT NULL)', () => {
    const undated = recordFor({
      dataSource: 'reddit',
      classification: 'social',
      contentHash: redditRecordId('saved_post', 'xfkamy'),
      occurredAt: null as unknown as Date,
      metadata: {
        Permalink: 'https://www.reddit.com/r/x/comments/xfkamy/s/',
        Kind: 'saved_post',
        Source: 'Reddit',
      },
    });

    expect(destinationsFor(undated)).toEqual(['content']);
    expect(toContentInput(undated).source_id).toBe(redditIdentity('saved_post', 't3_xfkamy').id);
  });
});

describe('browser: Takeout Chrome / History SQLite import vs the browser extension', () => {
  // One visit, three producers. The importer datasources (google_chrome.ts,
  // chromium.ts) stamp the builder's id as the item id, which becomes the
  // staged content_hash and so the source_id; the datasource NAME is the
  // system, aliased to `chromium`. The extension POSTs the pair it computed
  // itself to /v1/browser-activity, where adoptIngestIdentity takes it as is.
  const URL = 'https://example.com/article';
  const VISIT_MS = Date.parse('2026-06-10T12:00:00.123Z');
  const importerId = browserVisitIdentity('chromium', URL, VISIT_MS).id;

  const visitRecord = (dataSource: 'google_chrome' | 'chromium') =>
    recordFor({
      dataSource,
      classification: 'page_view',
      contentHash: importerId,
      occurredAt: new Date(VISIT_MS),
      metadata: {
        URL,
        Title: 'An article',
        Source: dataSource === 'chromium' ? 'Chromium' : 'Google Chrome',
      },
    });

  it('both importers land the visit in ci.browser_activity under (chromium, visit:<ms>:<url>)', () => {
    for (const dataSource of ['google_chrome', 'chromium'] as const) {
      const record = visitRecord(dataSource);
      expect(destinationsFor(record)).toEqual(['browser_activity']);

      const input = toBrowserActivityInput(record);
      expect(input.source_system).toBe('chromium');
      expect(input.source_id).toBe(`visit:${VISIT_MS}:${URL}`);
      expect(input.action_type).toBe('visit');
    }
  });

  it('CONVERGES with the pair the extension sends from chrome.history (a double of ms)', () => {
    // What CI-Browser-Extension's toBrowserActivityRecord puts on the wire for
    // this visit: system from the browser engine, id from the truncated ms.
    const wire = {
      source_system: 'chromium',
      source_id: `visit:${unixMsFromApiMillis(VISIT_MS + 0.7)}:${URL}`,
    };
    const adopted = adoptIngestIdentity(wire.source_system, wire.source_id);

    const imported = toBrowserActivityInput(visitRecord('google_chrome'));
    expect(adopted.system).toBe(imported.source_system);
    expect(adopted.id).toBe(imported.source_id);
  });

  it('a Brave/Edge/Arc extension build naming its brand still converges on chromium', () => {
    for (const brand of ['brave', 'edge', 'arc', 'chrome']) {
      expect(adoptIngestIdentity(brand, importerId).system).toBe('chromium');
    }
  });

  it('bookmarks converge on (chromium, bookmark:<s>:<url>) in ci.content', () => {
    const ADDED_S = 1749556800;
    const id = browserBookmarkIdentity('chromium', URL, ADDED_S * 1000).id;
    const record = recordFor({
      dataSource: 'google_chrome',
      classification: 'bookmark',
      contentHash: id,
      occurredAt: new Date(ADDED_S * 1000),
      metadata: { URL, Title: 'Saved', Source: 'Google Chrome' },
    });

    expect(destinationsFor(record)).toEqual(['content']);
    const input = toContentInput(record);
    expect(input.source_system).toBe('chromium');
    expect(input.source_id).toBe(`bookmark:${ADDED_S}:${URL}`);
    // The extension's bookmarks API gives dateAdded in ms; same second, same key.
    expect(
      adoptIngestIdentity('chromium', `bookmark:${Math.floor((ADDED_S * 1000 + 999) / 1000)}:${URL}`).id,
    ).toBe(input.source_id);
  });
});

describe('email threads: Takeout mbox X-GM-THRID vs Gmail API threadId', () => {
  // Not an identity pair — thread_id is a column, not the index — but the same
  // convergence problem: the API spells the 64-bit thread id in hex, the mbox
  // in decimal. datasources/gmail.ts stamps ThreadId via emailThreadId (the
  // registry's emailThreadKey); TransformGmail via gmailThreadKeyFromApi.
  const HEX = '18c1a2b3c4d5e6f7';
  const DECIMAL = '1783885820400625399';

  it('CONVERGES: the mbox header and the API field yield the same thread_id', () => {
    expect(emailThreadKey({ 'X-GM-THRID': DECIMAL, 'Message-ID': '<m@x>' })).toBe(gmailThreadKeyFromApi(HEX));
  });

  it('a non-Gmail mailbox keeps the RFC References root — the honest fallback, no false key', () => {
    expect(emailThreadKey({ References: '<root@x>', 'Message-ID': '<m@x>' })).toBe('root@x');
  });
});

describe('files: archive upload vs OneDrive Graph listing', () => {
  // The `file` federated kind: MediaStage stamps the object store's SHA-256
  // (FileSha256) beside FileId; toContentInput promotes it to
  // (file, sha256:<hash>). TransformOneDrive mints the same pair from the
  // Graph item's file.hashes.sha256Hash via fileIdentity.
  const SHA256 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  it('the import path keys a bytes-bearing content row on (file, sha256:<hash>)', () => {
    const record = recordFor({
      dataSource: 'microsoft_account',
      classification: 'document',
      mediaType: 'application/pdf',
      metadata: { FileId: 'file-uuid-1', FileSha256: SHA256, Title: 'report.pdf' },
    });

    const input = toContentInput(record);
    expect(input.source_system).toBe('file');
    expect(input.source_id).toBe(`sha256:${SHA256}`);
    expect(input.external_id).toBe('file-uuid-1'); // the stored bytes, unchanged
    expect(input.source_type).toBe('ci-import-tools'); // provenance, unchanged
  });

  it('CONVERGES with the pair the OneDrive connection mints from the Graph sha256Hash', () => {
    const importInput = toContentInput(
      recordFor({
        dataSource: 'microsoft_account',
        metadata: { FileId: 'f', FileSha256: SHA256.toUpperCase() },
      }),
    );
    const etlIdentity = fileIdentity(SHA256.toUpperCase());

    expect(importInput.source_system).toBe(etlIdentity.system);
    expect(importInput.source_id).toBe(etlIdentity.id);
  });

  it('a row with a stored file but no hash keeps its staged triple (no false federation)', () => {
    const input = toContentInput(recordFor({ dataSource: 'google_photos', metadata: { FileId: 'f' } }));
    expect(input.source_system).toBe('google_photos');
    expect(input.source_id).toBe('hash-1');
  });

  it('a malformed hash is ignored rather than becoming a file identity', () => {
    const input = toContentInput(recordFor({ metadata: { FileId: 'f', FileSha256: 'not-a-hash' } }));
    expect(input.source_system).toBe('gmail');
  });
});

describe('a file a cloud-drive connection fetched is attributed to that drive and that connection', () => {
  // The catch-all importer reads any loose file; its name says nothing about
  // where the file lived. The run knows (import_runs.origin_*).
  const photo = () =>
    recordFor({
      dataSource: 'generic',
      classification: 'media',
      mediaType: 'image/jpeg',
      contentHash: 'hash-photo',
      metadata: { filename: '2012-07-15 14.50.57.jpg' },
    });
  const CONNECTION = '01a10e04-069d-728e-a41f-0f606d95dea6';

  it('stamps the drive as platform, and the connection as owner, of what the catch-all importer produced', () => {
    const fromDropbox = withOrigin(photo(), { platform: 'dropbox', connectionId: CONNECTION });

    expect(toContentInput(fromDropbox).source_platform).toBe('dropbox');
    expect(toContentInput(fromDropbox).connection_id).toBe(CONNECTION);
    expect(toEventInput(fromDropbox).source_platform).toBe('dropbox');
    expect(toEventInput(fromDropbox).connection_id).toBe(CONNECTION);
    // The identity is untouched: the same bytes from an upload still converge.
    expect(toContentInput(fromDropbox).source_id).toBe(toContentInput(photo()).source_id);
    expect(toContentInput(fromDropbox).source_system).toBe(toContentInput(photo()).source_system);
  });

  it('leaves a run with no origin exactly as it was', () => {
    const untouched = photo();

    expect(withOrigin(untouched, null)).toBe(untouched);
    expect(withOrigin(untouched, { platform: null, connectionId: null })).toBe(untouched);
    expect(toContentInput(photo()).source_platform).toBe('generic');
    expect(toContentInput(photo()).connection_id).toBeUndefined();
  });

  it("does not relabel the platform of a record a specific importer claimed, but it is still the connection's", () => {
    // A Facebook export stored in Dropbox is Facebook data that Dropbox delivered.
    const like = recordFor({
      dataSource: 'facebook',
      classification: 'like',
      contentHash: 'facebook:reaction:1518135105',
      metadata: { Title: "Liked Alice's post", URL: 'https://www.facebook.com/x/posts/1' },
    });
    const viaDropbox = withOrigin(like, { platform: 'dropbox', connectionId: CONNECTION });

    expect(toEventInput(viaDropbox).source_platform).toBe('facebook');
    expect(toEventInput(viaDropbox).connection_id).toBe(CONNECTION);
  });
});

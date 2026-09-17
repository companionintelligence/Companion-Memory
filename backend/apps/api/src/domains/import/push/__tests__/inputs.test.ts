import path from 'node:path';

import { CommunicationType } from '@ci/domains/memory';

import { KindleFileImporter } from '../../datasources/kindle';
import type { ImportParams } from '../../datasources/timeline';
import type { StagedItem } from '../../entities/StagedItemEntity';
import { toCanonical, type CanonicalRecord } from '../canonical';
import {
  communicationTypeFor,
  discordAttachmentContentInputs,
  isCoordinateText,
  isMediaFilename,
  isNotAPlaceName,
  isTitleText,
  toBrowserActivityInput,
  toCommunicationInput,
  toContentInput,
  toEventInput,
  toThingInput,
  toPositionInput,
} from '../inputs';

/**
 * Where the port actually CHANGED something.
 *
 * The routing rules came across unmodified (see canonical.test.ts); these
 * builders did not, because ci-server's DTOs are not the `/v1` HTTP shapes
 * upstream emitted. Each case below is a place the two disagree, and getting one
 * wrong is silent: the record still lands, with a field empty, mistyped, or —
 * worst — plausibly wrong.
 */

function recordFor(overrides: Partial<StagedItem> = {}): CanonicalRecord {
  return toCanonical({
    id: '11111111-1111-4111-8111-111111111111',
    runId: '22222222-2222-4222-8222-222222222222',
    userId: '33333333-3333-4333-8333-333333333333',
    dataSource: 'gmail',
    classification: null,
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

describe('the provenance triple', () => {
  it('rides snake_case on every destination but things', () => {
    const record = recordFor({ classification: 'email' });

    expect(toCommunicationInput(record)).toMatchObject({
      source_type: 'ci-import-tools',
      source_system: 'gmail',
      source_id: 'hash-1',
    });
  });

  it('rides camelCase on things, which is the one camelCase ingest DTO', () => {
    const record = recordFor({ classification: 'purchase', metadata: { Product: 'Kettle' } });

    expect(toThingInput(record)).toMatchObject({
      sourceType: 'ci-import-tools',
      sourceSystem: 'gmail',
      sourceId: 'hash-1',
    });
  });
});

describe('toContentInput', () => {
  it('takes the content bucket from contentTypeFor, not the kind string directly', () => {
    // classification 'play' -> kind 'media.play' -> bucket 'media'.
    const play = recordFor({ classification: 'play', dataSource: 'spotify' });

    expect(toContentInput(play).type).toBe('media');
  });

  it('replaces the per-item sourceId with a source URI, so every play of one track dedups to one row', () => {
    // The exact bug in the file's own comment: without this, keying content on
    // the per-play item id produced 7,339 rows for an archive that should have
    // produced 2,354 — one per track/episode, not one per play.
    const play = recordFor({
      classification: 'play',
      dataSource: 'spotify',
      contentHash: 'play-event-1',
      metadata: { URI: 'spotify:track:123', Track: 'Song Name' },
    });

    const input = toContentInput(play);

    expect(input.external_id).toBe('spotify:track:123');
    expect(input.source_id).toBe('spotify:track:123');
    expect(input.source_id).not.toBe('play-event-1');
  });

  it('keeps the per-item sourceId when the record carries no URI', () => {
    const purchase = recordFor({ classification: 'purchase', contentHash: 'order-line-9' });

    expect(toContentInput(purchase).source_id).toBe('order-line-9');
  });

  it('points external_id at the uploaded file when the record reached content with no URI', () => {
    // An undated photo, or any drive-walk document with no source URI — the
    // upload leg (withContentMedia) stamps FileId just before the send.
    const orphanPhoto = recordFor({
      classification: 'photo',
      occurredAt: null,
      mediaType: 'image/jpeg',
      metadata: { FileId: 'file-uuid-1', FileUrl: 'https://files.example/file-uuid-1' },
    });

    const input = toContentInput(orphanPhoto);

    expect(input.external_id).toBe('file-uuid-1');
    expect(input.url).toBe('https://files.example/file-uuid-1');
    expect(input.mimetype).toBe('image/jpeg');
  });

  it('keys the row on its bytes when the upload leg stamped the store’s SHA-256 beside the file id', () => {
    // The `file` federated kind (docs/design/cross-pipeline-identity.md §3.2):
    // the same photo from two archives, or a document the OneDrive connection
    // listed by sha256Hash, is one row. Replaces the per-item staged triple
    // the way a URI does; provenance (source_type) is untouched.
    const sha256 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const photo = recordFor({
      classification: 'photo',
      dataSource: 'google_photos',
      mediaType: 'image/jpeg',
      metadata: { FileId: 'file-uuid-1', FileSha256: sha256 },
    });

    const input = toContentInput(photo);

    expect(input).toMatchObject({
      external_id: 'file-uuid-1',
      external_id_kind: 'file',
      source_type: 'ci-import-tools',
      source_system: 'file',
      source_id: `sha256:${sha256}`,
    });
  });

  it('keeps the staged triple when the upload leg stamped a file id but no hash', () => {
    const input = toContentInput(recordFor({ classification: 'photo', metadata: { FileId: 'file-uuid-1' } }));

    expect(input.source_system).toBe('gmail');
    expect(input.source_id).toBe('hash-1');
  });

  it('lets the file id win over a source URI when a record somehow carries both', () => {
    // "The file id wins over a source URI: it identifies these bytes in
    // CI-Server, which is what a consumer of this row needs." — the URI still
    // wins on source_id (the dedup key stays keyed on the track), only
    // external_id (what a consumer follows to the bytes) is overridden.
    const play = recordFor({
      classification: 'play',
      dataSource: 'spotify',
      metadata: { URI: 'spotify:track:123', FileId: 'file-uuid-2' },
    });

    const input = toContentInput(play);

    expect(input.external_id).toBe('file-uuid-2');
    expect(input.source_id).toBe('spotify:track:123');
  });

  it('does not let a stored file’s url clobber a url the source already gave', () => {
    const bookmark = recordFor({
      classification: 'saved_media',
      metadata: { URL: 'https://example.com/article', FileUrl: 'https://files.example/should-not-win' },
    });

    expect(toContentInput(bookmark).url).toBe('https://example.com/article');
  });

  it('types an Android app-store package as app, not media — even though it is a digital purchase', () => {
    // The exact live-DB bug: Amazon Appstore entitlements (mimetype
    // application/vnd.android.package-archive, stamped by amazon.ts
    // RESOURCE_TYPE_MIME/appAsins) are digital purchases and so reach the same
    // commerce.purchase content lane as an ebook or a movie, but they are
    // software, not media.
    const app = recordFor({
      classification: 'purchase',
      dataSource: 'amazon',
      mediaType: 'application/vnd.android.package-archive',
      metadata: { Product: 'SHADOWGUN', Digital: true },
    });

    expect(toContentInput(app).type).toBe('app');
  });

  it('still types a non-app digital purchase (an ebook, a movie) as media', () => {
    const ebook = recordFor({
      classification: 'purchase',
      dataSource: 'amazon',
      mediaType: 'application/vnd.amazon.ebook',
      metadata: { Product: 'Some Novel', Digital: true },
    });

    expect(toContentInput(ebook).type).toBe('media');
  });

  it('stamps external_id_kind file for an uploaded file, external_uri for a source URI', () => {
    const orphanPhoto = recordFor({
      classification: 'photo',
      occurredAt: null,
      mediaType: 'image/jpeg',
      metadata: { FileId: 'file-uuid-1' },
    });
    expect(toContentInput(orphanPhoto).external_id_kind).toBe('file');

    const play = recordFor({
      classification: 'play',
      dataSource: 'spotify',
      metadata: { URI: 'spotify:track:123' },
    });
    expect(toContentInput(play).external_id_kind).toBe('external_uri');
  });

  it('flips external_id_kind to file alongside external_id when a record carries both a URI and a FileId', () => {
    const play = recordFor({
      classification: 'play',
      dataSource: 'spotify',
      metadata: { URI: 'spotify:track:123', FileId: 'file-uuid-2' },
    });

    const input = toContentInput(play);

    expect(input.external_id).toBe('file-uuid-2');
    expect(input.external_id_kind).toBe('file');
  });

  it('leaves external_id_kind unset when the record carries neither a URI nor a FileId', () => {
    const purchase = recordFor({ classification: 'purchase', contentHash: 'order-line-9' });

    expect(toContentInput(purchase).external_id_kind).toBeUndefined();
  });

  // Defect F22: migration 20260818215331 backfilled the column with
  // `source_system IS DISTINCT FROM 'spotify' -> 'file'`, which mislabelled
  // every OTHER datasource that stamps metadata.URI. Spotify is not special —
  // toContentInput reads metadata.URI, not the source system — so pin each of
  // the four sources the old rule got wrong.
  it.each([
    ['amazon_music', 'amazonmusic:track:B07JQZ1KMP'],
    ['amazon_music', 'amazonmusic:album:B08XYZ1234'],
    ['audible', 'audible:asin:B002V0QK4C'],
    ['kindle', 'kindle:asin:B00X4WHP55'],
    ['kindle', 'kindle:doc:B00X4WHP55'],
    ['prime_video', 'primevideo:title:9f2c1b0a4d3e5f60'],
  ])('stamps external_uri for %s URI %s, not just spotify', (dataSource, uri) => {
    const rec = recordFor({ classification: 'play', dataSource, metadata: { URI: uri } });
    const input = toContentInput(rec);

    expect(input.external_id).toBe(uri);
    expect(input.external_id_kind).toBe('external_uri');
  });
});

/**
 * SRC-01 — the body contract for the two kinds that route to `content` ALONE.
 *
 * `note` and `reading.annotation` are the only two destinations a Notion page,
 * an Evernote note, a Kindle clipping or a Goodreads review ever reaches
 * (`destinationsFor`), so the content row's `text` is the sole home for the
 * body. That `text` is filled from METADATA (`descriptionFor` reads
 * Text/Body/Message/…/Highlight); `item.content.data()` is a parser-side blob
 * loader that nothing on the push path ever calls. A parser that attaches its
 * body only to the loader therefore lands an empty row and the words are gone.
 *
 * These assertions guard the contract itself rather than any one parser — a new
 * note-shaped importer that forgets the metadata key is the same bug again.
 */
describe('toContentInput — bodies for content-only kinds (SRC-01)', () => {
  it('carries a note body into content.text', () => {
    const note = recordFor({
      classification: 'note',
      dataSource: 'notion',
      metadata: { Title: 'Weekly Review', Source: 'Notion', Text: '# Weekly Review\n\nShipped the parser.' },
    });

    const input = toContentInput(note);

    expect(input.type).toBe('note');
    expect(input.text).toBe('# Weekly Review\n\nShipped the parser.');
  });

  it('carries a reading annotation body into content.text', () => {
    const clipping = recordFor({
      classification: 'annotation',
      dataSource: 'kindle',
      metadata: { Book: 'Thinking, Fast and Slow', Highlight: 'Nothing in life is as important…' },
    });

    expect(toContentInput(clipping).text).toBe('Nothing in life is as important…');
  });

  it('keeps two clippings from one book apart by appending the excerpt to the title', () => {
    // titleFor's `reading.annotation` branch. Without the excerpt both rows are
    // titled "Sapiens" and a reader cannot tell which highlight they are
    // looking at.
    const clip = (highlight: string) =>
      toContentInput(
        recordFor({
          classification: 'annotation',
          dataSource: 'kindle',
          metadata: { Book: 'Sapiens', Highlight: highlight },
        }),
      );

    const first = clip('First idea about the cognitive revolution.');
    const second = clip('Second idea about the agricultural revolution.');

    expect(first.title).toBe('Sapiens — First idea about the cognitive revolution.');
    expect(second.title).toBe('Sapiens — Second idea about the agricultural revolution.');
    expect(first.title).not.toBe(second.title);
  });

  it('holds end to end: the real Kindle parser’s metadata lands as content text', async () => {
    // The contract cases above are written against literal metadata, so they
    // pass whether or not any parser actually populates the keys. This one runs
    // the shipped importer over its fixture and pushes what it emitted through
    // the same builder — it is what goes red when a parser stops carrying the
    // body. StagedWriter persists `item.metadata` verbatim (`StagedWriter.ts`
    // `JSON.stringify(item.metadata ?? {})`), so the hand-off is faithful.
    const fixture = path.join(__dirname, '..', '..', 'datasources', '__tests__', 'fixtures', 'kindle-export');
    const importer = new KindleFileImporter();
    const emitted: Array<{ item: { classification?: string; metadata?: Record<string, unknown> } }> = [];
    await importer.fileImport({}, { filename: 'kindle-export', fullPath: fixture }, {
      pipeline: { push: (g: unknown) => emitted.push(g as (typeof emitted)[number]) },
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    expect(emitted.length).toBeGreaterThan(0);

    const inputs = emitted.map((g) =>
      toContentInput(
        recordFor({
          classification: g.item.classification ?? null,
          dataSource: 'kindle',
          metadata: (g.item.metadata ?? {}) as StagedItem['metadata'],
        }),
      ),
    );

    for (const input of inputs) {
      expect(input.text).toBeTruthy();
    }

    // And every clipping is distinguishable in a list view.
    expect(new Set(inputs.map((i) => i.title)).size).toBe(inputs.length);
  });

  it('leaves a shelved-but-unreviewed book titled with the bare book name', () => {
    // Goodreads only sets Text when 'My Review' is non-empty, so the title must
    // not degrade into "Dune — " for the majority of a library export.
    const shelved = recordFor({
      classification: 'annotation',
      dataSource: 'goodreads',
      metadata: { Title: 'Dune', Author: 'Frank Herbert' },
    });

    const input = toContentInput(shelved);

    expect(input.title).toBe('Dune');
    expect(input.text).toBeUndefined();
  });
});

describe('toContentInput — Reddit media', () => {
  // Reddit posts/comments reach the content lane ONLY for their media (see
  // canonical.test.ts's destinationsFor coverage); this is the row's shape.

  it('gives a link post’s image the post’s own title as both title and text', () => {
    // A link post carries no self-text (Body), so `postText` (rec.description
    // || rec.title) falls back to the post's own title — which is why the
    // row's title and text end up identical here. A self-post's Body would
    // take priority over the title instead (see the next test).
    const post = recordFor({
      classification: 'social',
      dataSource: 'reddit',
      metadata: {
        Title: 'Check out this sunset',
        URL: 'https://i.redd.it/abc123.jpg',
        Subreddit: 'pics',
        Kind: 'post',
      },
    });

    const input = toContentInput(post);

    expect(input.type).toBe('image');
    expect(input.url).toBe('https://i.redd.it/abc123.jpg');
    expect(input.title).toBe('Check out this sunset');
    expect(input.text).toBe('Check out this sunset');
    expect(input.mimetype).toBe('image/jpeg');
    expect(input.source_system).toBe('reddit');
  });

  it('gives a comment’s inline media text but no title — the body already carries it', () => {
    const comment = recordFor({
      classification: 'social',
      dataSource: 'reddit',
      metadata: {
        Body: 'Same spot, here is mine: https://i.redd.it/xyz789.png',
        Subreddit: 'pics',
        Kind: 'comment',
      },
    });

    const input = toContentInput(comment);

    expect(input.type).toBe('image');
    expect(input.url).toBe('https://i.redd.it/xyz789.png');
    expect(input.title).toBeUndefined();
    expect(input.text).toContain('Same spot');
  });

  it('routes a v.redd.it link as video, not image', () => {
    const post = recordFor({
      classification: 'social',
      dataSource: 'reddit',
      metadata: { Title: 'Clip', URL: 'https://v.redd.it/abcde12345', Kind: 'post' },
    });

    expect(toContentInput(post).type).toBe('video');
  });
});

describe('toCommunicationInput', () => {
  it('passes time as a Date, which the DTO requires', () => {
    // Upstream left this an ISO string for its HTTP sender to normalise.
    expect(toCommunicationInput(recordFor({ classification: 'email' })).time).toBeInstanceOf(Date);
  });

  it('defaults direction to inbound when the source states none', () => {
    // `direction` is required here where upstream left it optional. An archived
    // message that never says the user sent it is far more often one they
    // received, and mislabelling a received message as sent misattributes
    // authorship.
    expect(toCommunicationInput(recordFor({ classification: 'message' })).direction).toBe('inbound');
  });

  it('honours a direction the source does state', () => {
    const outbound = recordFor({ classification: 'message', metadata: { Direction: 'sent' } });

    expect(toCommunicationInput(outbound).direction).toBe('outbound');
  });

  // ci.communications had no metadata column at all, so a field a parser set
  // that has no dedicated one was silently dropped at push — a tweet's
  // permalink, likes, retweets, language and reply-parent, concretely.
  it('carries fields with no dedicated column through metadata', () => {
    const tweet = recordFor({
      classification: 'social',
      dataSource: 'twitter',
      metadata: {
        URL: 'https://x.com/user/status/123',
        Retweets: 5,
        Likes: 12,
        Lang: 'en',
        ReplyTo: '999',
      },
    });

    expect(toCommunicationInput(tweet).metadata).toMatchObject({
      URL: 'https://x.com/user/status/123',
      Retweets: 5,
      Likes: 12,
      Lang: 'en',
      ReplyTo: '999',
    });
  });

  it('keeps a field ALSO promoted to a dedicated column inside metadata too', () => {
    // Same round-trip-completeness reason toEventInput keeps Duration (minutes)
    // in metadata even after promoting it to duration_seconds.
    const call = recordFor({ classification: 'call', metadata: { Duration: 90, Subject: 'Weekly sync' } });
    const input = toCommunicationInput(call);

    expect(input.duration_seconds).toBe(90);
    expect(input.subject).toBe('Weekly sync');
    expect(input.metadata).toMatchObject({ Duration: 90, Subject: 'Weekly sync' });
  });

  describe('Reddit posts and comments', () => {
    it('files an authored post as outbound, subject = title, thread = subreddit', () => {
      const post = recordFor({
        classification: 'social',
        dataSource: 'reddit',
        metadata: { Title: 'My post', Body: 'body text', Subreddit: 'aww', Kind: 'post' },
      });

      const input = toCommunicationInput(post);

      expect(input.communication_type).toBe(CommunicationType.POST);
      expect(input.direction).toBe('outbound');
      expect(input.subject).toBe('My post');
      expect(input.thread_id).toBe('r/aww');
    });

    it('files a SAVED post as inbound — it was written by someone else', () => {
      const saved = recordFor({
        classification: 'social',
        dataSource: 'reddit',
        metadata: { Title: 'Someone else’s post', Subreddit: 'aww', Kind: 'saved_post' },
      });

      expect(toCommunicationInput(saved).direction).toBe('inbound');
    });

    it('leaves a comment’s subject blank — its body already carries the text in full', () => {
      const comment = recordFor({
        classification: 'social',
        dataSource: 'reddit',
        metadata: { Body: 'a reply', Subreddit: 'aww', Kind: 'comment' },
      });

      const input = toCommunicationInput(comment);

      expect(input.subject).toBeUndefined();
      expect(input.content).toBe('a reply');
    });
  });

  describe('Discord attachment-only messages', () => {
    it('leaves content blank rather than synthesizing a "Message — sender" label', () => {
      const attachmentOnly = recordFor({
        classification: 'message',
        dataSource: 'discord',
        metadata: { Attachments: 'https://cdn.discordapp.com/a/1/pic.png?ex=1', Sender: 'alice' },
      });

      expect(toCommunicationInput(attachmentOnly).content).toBe('');
    });

    it('keeps real caption text for a message that has both text and an attachment', () => {
      const captioned = recordFor({
        classification: 'message',
        dataSource: 'discord',
        metadata: {
          Text: 'look at this',
          Attachments: 'https://cdn.discordapp.com/a/1/pic.png?ex=1',
        },
      });

      expect(toCommunicationInput(captioned).content).toBe('look at this');
    });
  });

  // macOS puts U+FFFC OBJECT REPLACEMENT CHARACTER in `message.text` where an
  // inline attachment sits, so an uncaptioned photo arrives with a body of
  // exactly that one glyph. Storing it verbatim is what left 21,781 iMessage
  // rows in a live appliance database whose entire content was a control
  // character; falling through to the title fallbacks instead would be worse,
  // because titleFor synthesizes "Message — <sender>" — words the user never
  // wrote, presented as their message.
  describe('iMessage attachment placeholders', () => {
    it('blanks a body that is only the U+FFFC placeholder, and sets no preview', () => {
      const attachmentOnly = recordFor({
        classification: 'message',
        dataSource: 'imessage',
        metadata: { Text: '\uFFFC', Sender: '+15551234567' },
      });

      const input = toCommunicationInput(attachmentOnly);

      expect(input.content).toBe('');
      expect(input.preview).toBeUndefined();
    });

    it('does not fall back to the synthesized "Message — sender" label', () => {
      const attachmentOnly = recordFor({
        classification: 'message',
        dataSource: 'imessage',
        metadata: { Text: '\uFFFC', Sender: '+15551234567' },
      });

      expect(toCommunicationInput(attachmentOnly).content).not.toContain('Message —');
    });

    it('blanks a body that is only U+FFFD mojibake', () => {
      const mojibake = recordFor({
        classification: 'message',
        dataSource: 'imessage',
        metadata: { Text: '\uFFFD\uFFFD', Sender: '+15551234567' },
      });

      expect(toCommunicationInput(mojibake).content).toBe('');
    });

    it('keeps the CAPTION of a captioned attachment, minus the placeholder', () => {
      const captioned = recordFor({
        classification: 'message',
        dataSource: 'imessage',
        metadata: { Text: '\uFFFC look at this', Sender: '+15551234567' },
      });

      expect(toCommunicationInput(captioned).content).toBe('look at this');
    });

    it('strips a placeholder that sits INSIDE an otherwise real message', () => {
      const trailing = recordFor({
        classification: 'message',
        dataSource: 'imessage',
        metadata: { Text: 'Also, what is this thing called?\uFFFC\uFFFC' },
      });

      expect(toCommunicationInput(trailing).content).toBe('Also, what is this thing called?');
    });
  });
});

describe('discordAttachmentContentInputs', () => {
  it('builds one content row per attachment, decoding the filename out of the signed URL', () => {
    const message = recordFor({
      classification: 'message',
      dataSource: 'discord',
      contentHash: 'msg-1',
      metadata: {
        Attachments:
          'https://cdn.discordapp.com/attachments/1/2/Screenshot%20from%202020.png?ex=1&is=2&hm=3 ' +
          'https://cdn.discordapp.com/attachments/1/2/config?ex=1',
      },
    });

    const inputs = discordAttachmentContentInputs(message);

    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toMatchObject({
      type: 'media',
      title: 'Screenshot from 2020.png',
      mimetype: 'image/png',
      source_system: 'discord',
      source_id: 'msg-1:attachment:0',
    });
    // A bare extension-less file (Discord uploads include env/config files) —
    // mime-db can't type it at all, so it stays 'file' with no mimetype
    // guess. No type beats a wrong one.
    expect(inputs[1]).toMatchObject({ type: 'file', title: 'config', source_id: 'msg-1:attachment:1' });
    expect(inputs[1].mimetype).toBeUndefined();
  });

  it('is empty for a message with no attachments, and for a non-Discord source', () => {
    expect(discordAttachmentContentInputs(recordFor({ classification: 'message' }))).toEqual([]);

    const twitterDm = recordFor({
      classification: 'message',
      dataSource: 'twitter',
      metadata: { Attachments: 'https://cdn.discordapp.com/attachments/1/2/x.png' },
    });

    expect(discordAttachmentContentInputs(twitterDm)).toEqual([]);
  });
});

describe('communicationTypeFor', () => {
  it('maps a kind onto the enum rather than a bare string', () => {
    expect(communicationTypeFor('communication.email')).toBe(CommunicationType.EMAIL);
    expect(communicationTypeFor('communication.call')).toBe(CommunicationType.CALL);
  });

  it('lets one source declare several types under a single kind', () => {
    // A Twitter/X archive holds public POSTS alongside one-to-one DMs, and every
    // one of them is classified 'message'.
    expect(communicationTypeFor('communication.message', { CommunicationType: 'post' })).toBe(
      CommunicationType.POST,
    );
  });

  it('ignores a declared type outside the set a source may claim', () => {
    // Widening this to the whole enum would let a typo in one export's metadata
    // pick `video_call` for every message in it.
    expect(communicationTypeFor('communication.message', { CommunicationType: 'video_call' })).toBe(
      CommunicationType.CHAT,
    );
  });
});

describe('toThingInput', () => {
  const purchase = (condition: string) =>
    toThingInput(
      recordFor({ classification: 'purchase', metadata: { Product: 'Kettle', Condition: condition } }),
    );

  it('lowercases the condition vocabulary the column actually stores', () => {
    // Upstream returned the GraphQL enum's uppercase spellings and let the
    // transport lowercase them. That transport is gone.
    expect(purchase('Used - Like New').condition).toBe('like_new');
    expect(purchase('New').condition).toBe('new');
    expect(purchase('Used - Very Good').condition).toBe('good');
  });

  it('answers "no grade here" rather than inventing one', () => {
    // A bare "Used" states no grade and the enum has no ungraded-used bucket.
    expect(purchase('Used').condition).toBe('n/a');
    expect(purchase('Not Available').condition).toBe('n/a');
  });

  it('passes acquiredAt as a Date', () => {
    expect(purchase('New').acquiredAt).toBeInstanceOf(Date);
  });
});

describe('toPositionInput', () => {
  it('puts longitude in x and latitude in y, the order PostGIS uses', () => {
    // The reverse of how coordinates are spoken, and invisible if swapped —
    // every fix would simply be somewhere else.
    const fix = toPositionInput(
      recordFor({ classification: 'location', latitude: 37.7936, longitude: -122.3965 }),
    );

    expect(fix?.location).toEqual({ x: -122.3965, y: 37.7936 });
  });

  it('returns null for a record with no fix rather than throwing', () => {
    expect(toPositionInput(recordFor({ classification: 'message' }))).toBeNull();
  });

  it('keeps time as a string, which this DTO takes', () => {
    const fix = toPositionInput(recordFor({ classification: 'location', latitude: 1, longitude: 2 }));

    expect(typeof fix?.time).toBe('string');
  });

  it.each([
    ['google_location', 'location.txt'],
    ['kmlgx', 'Takeout Timeline.kml'],
    ['nmea', 'drive-2024-03-02.nmea'],
    ['gpx', 'track.gpx'],
  ])('refuses %s\u2019s own staged filename as a place name', (dataSource, filename) => {
    // The trap that made the source-side half of this fix a regression: these
    // importers used to manufacture "Location <lat>, <lon>" as a title. Removing
    // that does NOT leave the name empty — `titleFor` falls through to
    // `basename(row.filename)` (canonical.ts), so the file's own name slides into
    // the slot the pseudo-name vacated, and `ci.position.name` reads
    // "location.txt" instead of "Location 33.51469, -117.72169". Strictly worse:
    // it is not even recognisable as a coordinate any more.
    //
    // An extension allowlist cannot catch this class — .txt/.kml/.nmea/.gpx are
    // not media extensions, and widening the list to "anything with a dot" eats
    // "St. Louis". Comparing against the staged filename is what makes it
    // structural.
    const fix = toPositionInput(
      recordFor({
        dataSource,
        classification: 'location',
        latitude: 33.51469,
        longitude: -117.72169,
        filename,
        metadata: {},
      }),
    );

    expect(fix).not.toBeNull();
    expect(fix?.name).toBeUndefined();
  });

  it('still keeps a real place name on a record that also has a filename', () => {
    // The other side of the same rule: rejecting the filename must not reject a
    // genuine waypoint name that happens to ride in the same record.
    const fix = toPositionInput(
      recordFor({
        dataSource: 'kmlgx',
        classification: 'location',
        latitude: 33.51469,
        longitude: -117.72169,
        filename: 'Takeout Timeline.kml',
        metadata: { Name: 'Las Vegas Convention Center' },
      }),
    );

    expect(fix?.name).toBe('Las Vegas Convention Center');
  });

  it('refuses a coordinate pair as a place name', () => {
    // google_fit titles a trackpoint with its own coordinates when it has no
    // waypoint name. Stored as `name`, that makes the row look already-named to
    // the reverse-geocode candidate filter ("coordinates present, name
    // missing"), so it is never offered to the geocoder — 62,832 of 62,833
    // positions on a real Takeout, and a Places view holding one entry.
    const fix = toPositionInput(
      recordFor({
        classification: 'location',
        latitude: 33.51469,
        longitude: -117.72169,
        // The shape google_fit emits: `Title` falls back to the fix's own
        // coordinates when the trackpoint has no waypoint name.
        metadata: { Title: '33.51469, -117.72169' },
      }),
    );

    expect(fix?.name).toBeUndefined();
    // The geometry is still stored — only the fake name is dropped.
    expect(fix?.location).toEqual({ x: -117.72169, y: 33.51469 });
  });

  it('refuses a LABELLED coordinate pair as a place name', () => {
    // The original predicate was anchored `^\s*[-+]?\d`, so a coordinate pair
    // carrying a label sailed straight through. google_location, kmlgx and nmea
    // each emitted exactly that shape. They no longer mint it (fixed at the
    // source), but the guard is the backstop for producers we do not own.
    for (const label of [
      'Location 33.51469, -117.72169',
      'Location 33.51469,-117.72169',
      'position: 33.51469, -117.72169',
      'GPS 33.51469, -117.72169',
      'Waypoint 33.51469, -117.72169',
      'Coordinates 33.51469, -117.72169',
    ]) {
      const fix = toPositionInput(
        recordFor({
          classification: 'location',
          latitude: 33.51469,
          longitude: -117.72169,
          metadata: { Name: label },
        }),
      );

      expect(fix?.name).toBeUndefined();
      expect(fix?.location).toEqual({ x: -117.72169, y: 33.51469 });
    }
  });

  it('refuses a media filename as a place name', () => {
    // Every GPS-bearing photo donates a position row, and a capture item's
    // display title is its filename — right for a title, wrong for a place.
    // 2,085 rows on a real appliance read "IMG_0139.JPG" where the place goes.
    const photo = toPositionInput(
      recordFor({
        classification: 'photo',
        latitude: 33.51469,
        longitude: -117.72169,
        filename: 'IMG_0139.JPG',
      }),
    );

    expect(photo?.name).toBeUndefined();
    expect(photo?.location).toEqual({ x: -117.72169, y: 33.51469 });
  });

  it('refuses a URI as a place name', () => {
    const link = toPositionInput(
      recordFor({
        classification: 'location',
        latitude: 1,
        longitude: 2,
        metadata: { Name: 'https://us02web.zoom.us/j/8842952968' },
      }),
    );

    expect(link?.name).toBeUndefined();
  });

  it('keeps a real place name, including one that contains numbers', () => {
    const named = toPositionInput(
      recordFor({
        classification: 'location',
        latitude: 1,
        longitude: 2,
        metadata: { Title: 'Cafe 40.7, 74.0' },
      }),
    );

    expect(named?.name).toBe('Cafe 40.7, 74.0');

    const waypoint = toPositionInput(
      recordFor({ classification: 'location', latitude: 1, longitude: 2, metadata: { Name: 'Summit' } }),
    );

    expect(waypoint?.name).toBe('Summit');
  });

  it('refuses a ride narration as a place name', () => {
    // The shape uber.ts used to mint for a leg with no recorded address. 37
    // positions on the corpus carried it, and promote.place_position turned 7
    // into Location entities the Places list rendered as venues.
    const leg = toPositionInput(
      recordFor({
        dataSource: 'uber',
        classification: 'location',
        latitude: 37.7901,
        longitude: -122.3901,
        metadata: {
          Title:
            'Uber ride from 110 E 30th St, Austin, TX 78705, US to 101 Red River St, Austin, TX 78701, US (request)',
        },
      }),
    );

    expect(leg?.name).toBeUndefined();
    expect(leg?.location).toEqual({ x: -122.3901, y: 37.7901 });
  });

  it('refuses a geotagged social post its own body as a place name', () => {
    // A tweet posted with coordinates is a GPS donor, not a venue. Two ways this
    // is caught, and the test asserts the outcome both share: `social.post` is
    // not a place-naming kind, and the body is clipped prose besides.
    const tweet = toPositionInput(
      recordFor({
        dataSource: 'twitter',
        classification: 'post',
        latitude: 34.05,
        longitude: -118.24,
        metadata: {
          Text: `Showtime! BitScoop Labs will be going Live on FB Thursday 1/26 @ 1PM PST. ${'x'.repeat(80)}`,
        },
      }),
    );

    expect(tweet?.name).toBeUndefined();
    expect(tweet?.location).toEqual({ x: -118.24, y: 34.05 });
  });

  it('reads a place name only off a record that is ABOUT a place', () => {
    // The provenance half of the fix, and the arm that does not depend on
    // guessing prose from a string. `titleFor` gives every record a display
    // label; a geotagged message's label is its SUBJECT, which is a fine title
    // and a terrible place name — and short, unpunctuated and untruncated, so no
    // shape rule would ever catch it.
    const message = toPositionInput(
      recordFor({
        dataSource: 'gmail',
        classification: 'email',
        latitude: 1,
        longitude: 2,
        metadata: { Subject: 'Lunch tomorrow' },
      }),
    );

    expect(message?.name).toBeUndefined();

    // Same string on a location.fix keeps working, so the rule is about the
    // record's kind and not about the string.
    const fix = toPositionInput(
      recordFor({
        classification: 'location',
        latitude: 1,
        longitude: 2,
        metadata: { Title: 'Lunch tomorrow' },
      }),
    );

    expect(fix?.name).toBe('Lunch tomorrow');
  });

  it('still reads an explicit Name off a geotagged capture', () => {
    // `Name` is the one key that MEANS a name: an importer setting it on a photo
    // is stating "this fix is at a place called X", which is the claim `name`
    // records. Narrowing the TITLE slots must not close that door.
    const photo = toPositionInput(
      recordFor({
        dataSource: 'apple_photos',
        classification: 'photo',
        latitude: 1,
        longitude: 2,
        filename: 'IMG_0139.JPG',
        metadata: { Name: 'Las Vegas Convention Center' },
      }),
    );

    expect(photo?.name).toBe('Las Vegas Convention Center');
  });
});

/**
 * The four structural rejects for a place NAME, tested together because they
 * are one rule (isNotAPlaceName) applied in one place. Each is deliberately a
 * grammar rather than a per-importer denylist, so what matters most is the
 * NEGATIVE side: a real place name must survive all four.
 */
describe('isNotAPlaceName and its four arms', () => {
  describe('isCoordinateText', () => {
    it('matches a bare coordinate pair', () => {
      expect(isCoordinateText('33.51469, -117.72169')).toBe(true);
      expect(isCoordinateText('33.51469,-117.72169')).toBe(true);
      expect(isCoordinateText('  +12.34 , 56.78  ')).toBe(true);
      expect(isCoordinateText('0,0')).toBe(true);
    });

    it('matches the pair behind a generic geo label', () => {
      // The unfixed variant: anchored at `^\s*[-+]?\d`, every one of these was
      // read as a real name and written to ci.position.name.
      expect(isCoordinateText('Location 33.51469, -117.72169')).toBe(true);
      expect(isCoordinateText('Location 33.51469,-117.72169')).toBe(true);
      expect(isCoordinateText('location: 12.34, 56.78')).toBe(true);
      expect(isCoordinateText('Position 12.34, 56.78')).toBe(true);
      expect(isCoordinateText('Coordinates 12.34, 56.78')).toBe(true);
      expect(isCoordinateText('Coords 12.34, 56.78')).toBe(true);
      expect(isCoordinateText('Point 12.34, 56.78')).toBe(true);
      expect(isCoordinateText('Waypoint 12.34, 56.78')).toBe(true);
      expect(isCoordinateText('Fix 12.34, 56.78')).toBe(true);
      expect(isCoordinateText('GPS 12.34, 56.78')).toBe(true);
    });

    it('reproduces exactly what the three offending datasources used to emit', () => {
      const lat = 37.4221234;
      const lon = -122.0839876;

      // google_location.ts and nmea.ts (", " separator), kmlgx.ts ("," only).
      expect(isCoordinateText(`Location ${lat.toFixed(5)}, ${lon.toFixed(5)}`)).toBe(true);
      expect(isCoordinateText(`Location ${lat.toFixed(5)},${lon.toFixed(5)}`)).toBe(true);
    });

    it('keeps a real place name that merely contains numbers', () => {
      // The label vocabulary is generic geo nouns ONLY — no venue words — so a
      // place whose name happens to be followed by numbers survives.
      expect(isCoordinateText('Cafe 40.7, 74.0')).toBe(false);
      expect(isCoordinateText('Pier 39, 94133')).toBe(false);
      expect(isCoordinateText('Studio 54, New York')).toBe(false);
      expect(isCoordinateText('12 Avenue & West 23 St')).toBe(false);
      expect(isCoordinateText('1011-7')).toBe(false);
      expect(isCoordinateText('Location Barn')).toBe(false);
      expect(isCoordinateText('')).toBe(false);
    });

    it('does not match a coordinate pair with trailing text', () => {
      expect(isCoordinateText('33.51469, -117.72169 (approx)')).toBe(false);
    });
  });

  describe('isMediaFilename', () => {
    it('matches the media extensions a camera roll produces', () => {
      expect(isMediaFilename('IMG_0139.JPG')).toBe(true);
      expect(isMediaFilename('20140710_170940.jpg')).toBe(true);
      expect(isMediaFilename('IMAG0459.jpeg')).toBe(true);
      expect(isMediaFilename('A20CEAAC-8F30-403E-A17B-E60DBC744DBB_3.mov')).toBe(true);
      expect(isMediaFilename('clip.MP4')).toBe(true);
      expect(isMediaFilename('shot.heic')).toBe(true);
      expect(isMediaFilename('shot.heif')).toBe(true);
      expect(isMediaFilename('raw.dng')).toBe(true);
      expect(isMediaFilename('scan.tif')).toBe(true);
      expect(isMediaFilename('scan.tiff')).toBe(true);
      expect(isMediaFilename('  IMG_0139.PNG  ')).toBe(true);
    });

    it('matches a bare UUID stem, with or without a burst suffix', () => {
      expect(isMediaFilename('A20CEAAC-8F30-403E-A17B-E60DBC744DBB')).toBe(true);
      expect(isMediaFilename('a20ceaac-8f30-403e-a17b-e60dbc744dbb_3')).toBe(true);
    });

    it('keeps a real place name, including one with a dot in it', () => {
      expect(isMediaFilename('A.G. Bartlett Building')).toBe(false);
      expect(isMediaFilename('St. Louis')).toBe(false);
      expect(isMediaFilename('Las Vegas Convention Center')).toBe(false);
      expect(isMediaFilename('Pico / Figueroa')).toBe(false);
      expect(isMediaFilename('75 Amherst St, Cambridge, MA 02139, USA')).toBe(false);
      expect(isMediaFilename('')).toBe(false);
    });

    it('does not match a non-media file extension', () => {
      // Out of scope on purpose: this arm is about camera-roll filenames, and
      // widening it to "anything with a dot and 2-4 chars" would eat "St. Louis".
      // These ARE still rejected as position names — by the staged-filename rule
      // in toPositionInput, not by an extension list. See the round-trip tests
      // in the toPositionInput describe block.
      expect(isMediaFilename('track.gpx')).toBe(false);
      expect(isMediaFilename('location.txt')).toBe(false);
    });
  });

  describe('isTitleText', () => {
    it('matches a clipped body — the ellipsis is `clip`’s own truncation mark', () => {
      // Every one of these is a live ci.position.name from a geotagged tweet.
      expect(
        isTitleText("Check out a replay of BitScoop Labs' first live stream! #BitScoop #APIs #Micros…"),
      ).toBe(true);
      expect(
        isTitleText('Learn about more advanced data modeling when consuming and publishing APIs. htt…'),
      ).toBe(true);
      // Short enough to pass the word bound, unpunctuated — the ellipsis alone
      // has to carry it.
      expect(isTitleText('Data Science Wizardry…')).toBe(true);
    });

    it('matches a sentence by its punctuation', () => {
      expect(isTitleText('Showtime! BitScoop Labs will be going Live on FB')).toBe(true);
      expect(isTitleText('Anyone else seeing this?')).toBe(true);
    });

    it('matches a narration by its length in words', () => {
      // The 16-word floor of the narrations that survive both arms above. Neither
      // carries an ellipsis or a bang.
      expect(
        isTitleText(
          'Uber ride from Red Rocks Amphitheatre to 717 E Colfax Ave, Denver, CO 80203, US (request)',
        ),
      ).toBe(true);
      expect(
        isTitleText(
          'Uber ride from 110 E 30th St, Austin, TX 78705, US to 101 Red River St, Austin, TX 78701, US (request)',
        ),
      ).toBe(true);
    });

    it('keeps the longest real place names on the corpus, at 14 words and 90 characters', () => {
      // The boundary cases, and the reason the bound is in WORDS: this hotel is
      // 90 characters — LONGER than the 89-character narration above — so a
      // character bound cannot separate the two classes at any threshold.
      expect(
        isTitleText(
          'Red Roof PLUS+ Boston - Framingham, 650 Cochituate Rd, Framingham, MA 01701, United States',
        ),
      ).toBe(false);
      expect(
        isTitleText(
          'Battery Wharf Hotel Boston Waterfront, 3 Battery Wharf, Boston, MA 02109, United States',
        ),
      ).toBe(false);
      expect(
        isTitleText('Terminal 5 Departures Level: Ride Service Sign E Los Angeles International Airport'),
      ).toBe(false);
      expect(
        isTitleText('Concourse C, Palm Beach International Airport (PBI), West Palm Beach, FL 33406, US'),
      ).toBe(false);
    });

    it('keeps the punctuation real place names actually use', () => {
      // `.` and `@` are deliberately absent from the punctuation arm; all three
      // of these are live values in ci.position.name.
      expect(isTitleText('A.G. Bartlett Building')).toBe(false);
      expect(isTitleText('Bongeunsa Temple. Lotte Duty Free Shop')).toBe(false);
      expect(isTitleText('On Jane Stanford Way @ Gilbert Biological Sciences')).toBe(false);
      expect(isTitleText('')).toBe(false);
    });
  });

  describe('isNotAPlaceName', () => {
    it('is the union of the four arms', () => {
      expect(isNotAPlaceName('Location 33.51469, -117.72169')).toBe(true);
      expect(isNotAPlaceName('33.51469, -117.72169')).toBe(true);
      expect(isNotAPlaceName('IMG_0139.JPG')).toBe(true);
      expect(isNotAPlaceName('https://us02web.zoom.us/j/8842952968')).toBe(true);
      expect(isNotAPlaceName('altspace://account.altvr.com/api/events/1629227784846967373')).toBe(true);
      expect(
        isNotAPlaceName(
          'Uber ride from Red Rocks Amphitheatre to 717 E Colfax Ave, Denver, CO 80203, US (request)',
        ),
      ).toBe(true);
      expect(
        isNotAPlaceName("Check out a replay of BitScoop Labs' first live stream! #BitScoop #APIs #Micros…"),
      ).toBe(true);
    });

    it('lets every real place name observed on a live appliance through', () => {
      for (const name of [
        'Las Vegas Convention Center',
        'Pico / Figueroa',
        'A.G. Bartlett Building',
        'On Jane Stanford Way @ Main Quad',
        'Irvine Spectrum Center - Nordstrom Parking (South Garage)',
        '75 Amherst St, Cambridge, MA 02139, USA',
        'Cafe 40.7, 74.0',
        '1011-7',
        'Gym',
        'Red Roof PLUS+ Boston - Framingham, 650 Cochituate Rd, Framingham, MA 01701, United States',
        'Boston Logan International Airport, 1 Harborside Dr, Boston, MA 02128, United States',
        'Terminal A, Newark Liberty International Airport (EWR), Elizabeth, NJ 07114, US',
        'Fifth & Mission / Yerba Buena Parking Garage',
        'LAX Terminal 5 Upper Level FlyAway Stop',
      ]) {
        expect(isNotAPlaceName(name)).toBe(false);
      }
    });
  });
});

describe('toBrowserActivityInput', () => {
  it('keeps time as a string, unlike communications and events', () => {
    const view = recordFor({ classification: 'page_view', metadata: { URL: 'https://example.com' } });

    expect(typeof toBrowserActivityInput(view).time).toBe('string');
  });

  it('falls back to the query when a search carries no page URL', () => {
    const search = recordFor({ classification: 'search', metadata: { Query: 'kettle descaling' } });

    expect(toBrowserActivityInput(search).url).toBeTruthy();
  });

  // `duration_seconds` had a column, this DTO field, and a `screen_minutes`
  // metric summing it, and no producer anywhere on the import path — the only
  // other assignment of the column is a COMMUNICATION's call duration. Browser
  // rows sat at 0 of 327,745.
  it('carries dwell time through to duration_seconds', () => {
    const view = recordFor({
      classification: 'page_view',
      metadata: { URL: 'https://example.com', DurationSeconds: 45 },
    });

    expect(toBrowserActivityInput(view).duration_seconds).toBe(45);
  });

  it('leaves duration_seconds unset when the parser recorded no dwell time', () => {
    const view = recordFor({ classification: 'page_view', metadata: { URL: 'https://example.com' } });

    expect(toBrowserActivityInput(view).duration_seconds).toBeUndefined();
  });

  it('does not pass through a zero or negative dwell time', () => {
    // The parser already omits these; this is the mapper refusing to record a
    // visit as having lasted no time at all rather than not knowing.
    for (const DurationSeconds of [0, -1]) {
      const view = recordFor({
        classification: 'page_view',
        metadata: { URL: 'https://example.com', DurationSeconds },
      });

      expect(toBrowserActivityInput(view).duration_seconds).toBeUndefined();
    }
  });

  it('marks a download with action_type download, not visit', () => {
    // ci.browser_activity has modelled this action_type all along and held 0
    // rows, because nothing produced web.download.
    const dl = recordFor({ classification: 'download', metadata: { URL: 'https://files.example/a.pdf' } });

    expect(toBrowserActivityInput(dl).action_type).toBe('download');
  });

  it('does not pass through a non-numeric dwell time', () => {
    const view = recordFor({
      classification: 'page_view',
      metadata: { URL: 'https://example.com', DurationSeconds: 'a while' },
    });

    expect(toBrowserActivityInput(view).duration_seconds).toBeUndefined();
  });
});

describe('toEventInput', () => {
  it('names an untitled record by its kind rather than leaving the title blank', () => {
    // `title` is required here where upstream left it optional.
    const untitled = recordFor({ classification: 'photo', mediaType: 'image/jpeg' });

    expect(toEventInput(untitled).title).toBe('capture.photo');
  });

  it('carries the GPS provenance in metadata as well as on the position row', () => {
    // LocationEstimateService weighs donors by accuracy; an event whose position
    // leg was skipped would otherwise carry a coordinate with no idea how good
    // it is.
    const geotagged = recordFor({
      classification: 'photo',
      mediaType: 'image/jpeg',
      latitude: 1,
      longitude: 2,
    });
    const input = toEventInput(geotagged);

    expect(input.metadata?.locationSource).toBe('exif');
    expect(input.metadata?.accuracyMeters).toBe(30);
  });

  it('passes start_time as a Date and the coordinate as a GeoJSON Point', () => {
    const visit = recordFor({ classification: 'place', latitude: 37.7936, longitude: -122.3965 });
    const input = toEventInput(visit);

    expect(input.start_time).toBeInstanceOf(Date);
    expect(input.location_coordinates).toEqual({ type: 'Point', coordinates: [-122.3965, 37.7936] });
  });

  it('refuses a meeting-join URL as a location name', () => {
    // A .ics VLOCATION of a pasted Zoom link is not a place name, the same
    // defect class as a coordinate pair in toPositionInput's `name` (above) —
    // see isUriLocation.
    const zoomMeeting = recordFor({
      classification: 'event',
      metadata: { Location: 'https://khronosgroup.zoom.us/w/99353948195?tk=oBjpnuWTonC0SQZ_XX0y' },
    });

    expect(toEventInput(zoomMeeting).location_name).toBeUndefined();
  });

  it('refuses a custom-scheme URI (e.g. AltspaceVR) as a location name', () => {
    const altspaceEvent = recordFor({
      classification: 'event',
      metadata: { Location: 'altspace://account.altvr.com/api/events/1629227784846967373' },
    });

    expect(toEventInput(altspaceEvent).location_name).toBeUndefined();
  });

  it('keeps a real venue name in the calendar Location field', () => {
    const inPerson = recordFor({
      classification: 'event',
      metadata: { Location: 'Golden Gate Park, San Francisco, CA' },
    });

    expect(toEventInput(inPerson).location_name).toBe('Golden Gate Park, San Francisco, CA');
  });
});

/**
 * `Conversation` — the per-chat key eleven datasources stamp — reaching
 * thread_id.
 *
 * The chain read ThreadId/Thread/MessageID only, so any source that spelled the
 * conversation `Conversation` (LinkedIn, Instagram, Claude, Google Voice,
 * WhatsApp, Discord, Telegram, Grok, …) had its grouping dropped here and its
 * rows landed with ci.communications.thread_id NULL — 4,840 LinkedIn, 228
 * Instagram and 4 Claude rows on the live database, plus every Google Voice
 * message. Both special-case mappers in this file already read `Conversation`
 * themselves, which is the tell that the generic chain should have.
 */
describe('the conversation key reaching thread_id', () => {
  it('threads a LinkedIn message on its conversation title', () => {
    const linkedin = recordFor({
      classification: 'message',
      dataSource: 'linkedin',
      metadata: { Conversation: 'Ada Lovelace', Sender: 'Ada Lovelace', Text: 'hello' },
    });

    expect(toCommunicationInput(linkedin).thread_id).toBe('Ada Lovelace');
  });

  it('threads an Instagram DM on its thread title', () => {
    const instagram = recordFor({
      classification: 'message',
      dataSource: 'instagram',
      metadata: { Conversation: 'grace.hopper', Sender: 'grace.hopper', Text: 'hi' },
    });

    expect(toCommunicationInput(instagram).thread_id).toBe('grace.hopper');
  });

  it('prefers an explicit ThreadId when the source states both', () => {
    // A source that stamps both means the explicit key — Claude stamps the
    // conversation UUID as ThreadId and its renameable title as Conversation.
    const claude = recordFor({
      classification: 'message',
      dataSource: 'claude',
      metadata: { ThreadId: 'conv-uuid', Conversation: 'A renameable title', Text: 'hi' },
    });

    expect(toCommunicationInput(claude).thread_id).toBe('conv-uuid');
  });

  it('prefers the conversation over MessageID, which is a per-message id', () => {
    // MessageID makes every message its own thread — it is the last resort,
    // so a real conversation key has to beat it.
    const both = recordFor({
      classification: 'message',
      metadata: { Conversation: 'the chat', MessageID: '<one-message@example.com>' },
    });

    expect(toCommunicationInput(both).thread_id).toBe('the chat');
  });

  it('still falls back to MessageID for email, which has no Conversation', () => {
    const email = recordFor({
      classification: 'email',
      metadata: { MessageID: '<one-message@example.com>' },
    });

    expect(toCommunicationInput(email).thread_id).toBe('<one-message@example.com>');
  });

  it('leaves thread_id unset when the source names no conversation at all', () => {
    expect(toCommunicationInput(recordFor({ classification: 'message' })).thread_id).toBeUndefined();
  });
});

describe('communication attachments reach the column', () => {
  /**
   * The read side of the lane, which was never dead — `attachmentsFor` has
   * always built this column from `AttachmentFileIds`/`AttachmentContentIds`.
   * It had no producer, so it ran on every communication in the corpus and
   * produced `[]` 325,198 times. These assert the contract the media leg now
   * writes against.
   */
  it('turns the stamped file ids into attachment references', () => {
    const message = recordFor({
      classification: 'message',
      dataSource: 'twitter',
      metadata: { Text: 'look', AttachmentFileIds: ['file-a', 'file-b'] },
    });

    expect(toCommunicationInput(message).attachments).toEqual([
      { type: 'file', id: 'file-a' },
      { type: 'file', id: 'file-b' },
    ]);
  });

  it('carries the content rows alongside the files for a source that catalogues them', () => {
    const message = recordFor({
      classification: 'message',
      dataSource: 'facebook',
      metadata: {
        Text: 'photo',
        AttachmentFileIds: ['file-a'],
        AttachmentContentIds: ['content-a'],
      },
    });

    expect(toCommunicationInput(message).attachments).toEqual([
      { type: 'file', id: 'file-a' },
      { type: 'content', id: 'content-a' },
    ]);
  });

  it('leaves the column unset for a message with no attachments', () => {
    // The default the whole corpus sat at, and the correct answer for a message
    // that genuinely carried nothing.
    const message = recordFor({ classification: 'message', metadata: { Text: 'hi' } });

    expect(toCommunicationInput(message).attachments).toBeUndefined();
  });
});

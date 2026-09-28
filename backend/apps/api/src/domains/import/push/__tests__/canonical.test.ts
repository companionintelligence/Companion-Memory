import type { StagedItem } from '../../entities/StagedItemEntity';
import {
  communicationAttachmentsFrom,
  destinationsFor,
  discordAttachmentFilename,
  edgeProjectionSourcesFor,
  discordAttachmentUrls,
  isAttachmentPlaceholderOnly,
  isDiscordAttachmentOnly,
  isRedditComment,
  isRedditPost,
  isRepresentedElsewhere,
  isSocialAffiliation,
  kindFor,
  redditMediaUrl,
  str,
  toCanonical,
  type CanonicalRecord,
} from '../canonical';

/**
 * The routing rules, which are the whole reason this mapping was ported rather
 * than rewritten. Nearly every case here is a decision someone made after
 * watching real data land in the wrong place:
 *
 *  - ~96k Google/YouTube searches landed in `ci.events` instead of
 *    `ci.browser_activity`;
 *  - a content row per text-only calendar event duplicated every agenda into
 *    `ci.content` as a phantom document;
 *  - millions of GPS trackpoints drowned the timeline;
 *  - undated files dated themselves to the moment of import.
 *
 * A regression in any of them is silent — the import still "succeeds", the rows
 * are just in the wrong table.
 */

function stagedRow(overrides: Partial<StagedItem> = {}): StagedItem {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    runId: '22222222-2222-4222-8222-222222222222',
    userId: '33333333-3333-4333-8333-333333333333',
    dataSource: 'gpx',
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
  } as StagedItem;
}

function recordFor(overrides: Partial<StagedItem> = {}): CanonicalRecord {
  return toCanonical(stagedRow(overrides));
}

describe('toCanonical', () => {
  it('takes sourceId from the content hash, not the staging row id', () => {
    // The staging id is a fresh uuid per run. Using it would make an identical
    // re-import a brand new record in ci.* instead of the no-op the dedup triple
    // exists to produce.
    const record = recordFor({ contentHash: 'gmail-msg-1' });

    expect(record.sourceId).toBe('gmail-msg-1');
    expect(record.sourceId).not.toBe(stagedRow().id);
  });

  it('marks a row dated when the source gave it a time', () => {
    expect(recordFor({ occurredAt: new Date('2012-07-04T10:00:00Z') }).dated).toBe(true);
  });

  it('falls back to the row creation time and says so', () => {
    // The fallback is IMPORT time. `dated: false` is what stops it being
    // presented as a timeline occurrence.
    const record = recordFor({ occurredAt: null });

    expect(record.dated).toBe(false);
    expect(record.startTime).toBe('2026-08-12T00:00:00.000Z');
  });
});

describe('kindFor', () => {
  it('lets the MIME decide when the classification is the generic "media"', () => {
    // google_photos stamps 'media' on photos AND videos AND audio, so the
    // classification alone cannot pick the kind.
    expect(kindFor('media', 'image/jpeg')).toBe('capture.photo');
    expect(kindFor('media', 'video/mp4')).toBe('capture.video');
  });

  it('does not call a non-media MIME a photo just because the classification says "media"', () => {
    // The Instagram HTML importer used to stamp 'media' on text/plain entries
    // that carried no file at all; the photo default turned each into a
    // capture.photo event with no photo behind it (six in the live database).
    // A present, non-media mimetype is a statement about the bytes and beats a
    // coarse classification label.
    expect(kindFor('media', 'text/plain')).toBe('import.archive_item');
    expect(kindFor('media', 'application/pdf')).toBe('import.archive_item');
    // No MIME at all still defaults to photo, as it always has.
    expect(kindFor('media', null)).toBe('capture.photo');
  });

  it('maps the messaging classifications apart rather than into one bucket', () => {
    expect(kindFor('message', null)).toBe('communication.message');
    expect(kindFor('email', null)).toBe('communication.email');
    expect(kindFor('call', null)).toBe('communication.call');
  });
});

describe('destinationsFor', () => {
  it('sends a web search to browser activity, not the timeline', () => {
    expect(destinationsFor(recordFor({ classification: 'search' }))).toEqual(['browser_activity']);
  });

  it('sends a download to browser activity, not the timeline', () => {
    // Without this rule a download falls through to the default 'events'
    // bucket, the same way ~96k searches once did.
    expect(destinationsFor(recordFor({ classification: 'download' }))).toEqual(['browser_activity']);
  });

  it('keeps a raw GPS fix out of events entirely', () => {
    const track = recordFor({ classification: 'location', latitude: 1, longitude: 2 });

    expect(destinationsFor(track)).toEqual(['position']);
  });

  it('keeps a place VISIT on the timeline as well as donating its fix', () => {
    // A visit's time and name have narrative value; a trackpoint's does not.
    const visit = recordFor({ classification: 'place', latitude: 1, longitude: 2 });

    expect(destinationsFor(visit)).toEqual(['events', 'position']);
  });

  it('gives a text-only calendar event no content row', () => {
    const agenda = recordFor({ classification: 'event' });

    expect(destinationsFor(agenda)).toEqual(['events']);
  });

  it('gives a calendar event that carries a file both homes', () => {
    const invite = recordFor({
      classification: 'event',
      mediaType: 'image/png',
      intermediateLocation: '/scratch/invite.png',
    });

    expect(destinationsFor(invite)).toEqual(['events', 'content']);
  });

  it('routes an undated file to content alone', () => {
    // Its startTime would be the moment of import, which reads as a real date on
    // the timeline and is pure noise beside the EXIF-dated items around it.
    const orphan = recordFor({
      classification: 'photo',
      occurredAt: null,
      mediaType: 'image/jpeg',
      intermediateLocation: '/scratch/IMG_0001.jpg',
    });

    expect(destinationsFor(orphan)).toEqual(['content']);
  });

  it('gives a dated photo a content row so its thumbnail can resolve', () => {
    // EventMediaLoader resolves an event's photo/video by INNER-JOINing
    // ci.content on ci.events through the shared source triple
    // (ContentService.findMediaFilesByEventIds). ['events'] alone never
    // creates that content row, so the join finds nothing and the tile is
    // blank — verified on a real import: 2,098 photo/video events, 0 linked.
    const photo = recordFor({
      classification: 'photo',
      mediaType: 'image/jpeg',
      intermediateLocation: '/scratch/IMG_0001.jpg',
    });

    expect(destinationsFor(photo)).toEqual(['events', 'content']);
  });

  it('gives a geotagged photo events, content, AND a position donation', () => {
    const photo = recordFor({
      classification: 'photo',
      mediaType: 'image/jpeg',
      intermediateLocation: '/scratch/IMG_0001.jpg',
      latitude: 1,
      longitude: 2,
    });

    expect(destinationsFor(photo)).toEqual(['events', 'content', 'position']);
  });

  it('donates a geotagged message to the position table as well', () => {
    const tweet = recordFor({ classification: 'message', latitude: 1, longitude: 2 });

    expect(destinationsFor(tweet)).toEqual(['communications', 'position']);
  });

  it('gives a subscription fee its receipt and nothing else', () => {
    // A Prime or Kindle Unlimited charge is a service, not a thing: neither
    // content nor things. It is still a real purchase, so it keeps the
    // receipt that carries the merchant and the money — before the commerce
    // plane it pushed NOWHERE and the spend was invisible.
    const fee = recordFor({ classification: 'purchase', metadata: { Subscription: true } });

    expect(destinationsFor(fee)).toEqual(['receipts']);
  });

  it('leaves the receipt to the order aggregate for a rolled-up line', () => {
    // amazon.ts stamps every line of a multi-item order with the aggregate's
    // id. Without this branch a five-item order produces five single-line
    // receipts on top of the itemised one.
    const line = recordFor({
      classification: 'purchase',
      metadata: { ReceiptRollupId: 'amazon:order:111-2233445-6677889' },
    });

    expect(destinationsFor(line)).toEqual(['things']);
  });

  it('sends a physical purchase to things and a digital one to content, both with a receipt', () => {
    const physical = recordFor({ classification: 'purchase' });

    expect(destinationsFor(physical)).toEqual(['receipts', 'things']);

    const digital = recordFor({ classification: 'purchase', metadata: { Product: 'Kindle Edition' } });

    expect(destinationsFor(digital)).toEqual(['receipts', 'content']);
  });

  it('sends a money movement to events alone', () => {
    // There is no document or media "thing" behind a transaction worth a
    // searchable corpus row.
    expect(destinationsFor(recordFor({ classification: 'transaction' }))).toEqual(['events']);
  });

  it('gives a play both a timeline occurrence and a searchable row', () => {
    expect(destinationsFor(recordFor({ classification: 'play' }))).toEqual(['events', 'content']);
  });

  it('gives a saved library artifact content alone', () => {
    // Its source records no time the user did anything, so an event would pin it
    // to import time.
    expect(destinationsFor(recordFor({ classification: 'saved_media' }))).toEqual(['content']);
  });

  describe('Reddit posts and comments', () => {
    // Authored communications, not timeline events — a content row rides
    // along ONLY when the record carries media (see inputs.test.ts's
    // toContentInput coverage for the row's shape).

    it('sends a text-only post to communications alone', () => {
      const textPost = recordFor({
        classification: 'social',
        dataSource: 'reddit',
        metadata: { Title: 'A wall of text', Kind: 'post', Subreddit: 'AskReddit' },
      });

      expect(destinationsFor(textPost)).toEqual(['communications']);
    });

    it('adds a content row when the post links to media', () => {
      const imagePost = recordFor({
        classification: 'social',
        dataSource: 'reddit',
        metadata: { Title: 'Sunset', URL: 'https://i.redd.it/abc.jpg', Kind: 'post', Subreddit: 'pics' },
      });

      expect(destinationsFor(imagePost)).toEqual(['communications', 'content']);
    });

    it('adds a content row when a comment links to media in its body', () => {
      const comment = recordFor({
        classification: 'social',
        dataSource: 'reddit',
        metadata: { Body: 'same here: https://i.redd.it/xyz.png', Kind: 'comment', Subreddit: 'pics' },
      });

      expect(destinationsFor(comment)).toEqual(['communications', 'content']);
    });

    it('does not treat some other reddit social row as a post or comment', () => {
      // Only Kind 'post'/'saved_post'/'comment'/'saved_comment' qualify. A
      // reddit Kind that is neither an authored post/comment nor an affiliation
      // keeps the generic social.* route — the boundary that stops either
      // predicate from being widened to "any reddit social row".
      const other = recordFor({
        classification: 'social',
        dataSource: 'reddit',
        metadata: { Kind: 'award', Subreddit: 'pics' },
      });

      expect(destinationsFor(other)).toEqual(['events', 'content']);
    });

    it('sends an undated saved post to content alone, never wearing import time', () => {
      // Reddit's saved_posts.csv is `id, permalink` — no date of any kind. A
      // communications row would be forced to a NOT NULL time, i.e. the import
      // moment presented as real (verified live: eight saved posts/comments
      // all stamped the second they were parsed).
      const saved = recordFor({
        classification: 'social',
        dataSource: 'reddit',
        occurredAt: null,
        metadata: { Title: 'English is weird', Kind: 'saved_post', Subreddit: 'Jokes' },
      });

      expect(destinationsFor(saved)).toEqual(['content']);
    });

    it('keeps a DATED saved post in communications', () => {
      // The rule is about the missing date, not about being saved: a future
      // export that dates its saved items gets the normal routing.
      const dated = recordFor({
        classification: 'social',
        dataSource: 'reddit',
        metadata: { Title: 'Dated after all', Kind: 'saved_post', Subreddit: 'space' },
      });

      expect(destinationsFor(dated)).toEqual(['communications']);
    });
  });

  describe('undated social records', () => {
    it('sends an undated authored social record to content alone', () => {
      const undated = recordFor({
        classification: 'social',
        dataSource: 'mastodon',
        occurredAt: null,
        metadata: { Title: 'A post with no date', Kind: 'post' },
      });

      expect(destinationsFor(undated)).toEqual(['content']);
    });

    it('keeps an undated affiliation on its event home', () => {
      // An affiliation models CURRENT state — its event title carries the whole
      // fact, and its content row is the empty one isSocialAffiliation exists
      // to prevent. Content-only would erase it entirely.
      const membership = recordFor({
        classification: 'social',
        dataSource: 'reddit',
        occurredAt: null,
        metadata: { Kind: 'subscribed_subreddit', Subreddit: 'bitscoop' },
      });

      expect(destinationsFor(membership)).toEqual(['events']);
    });
  });

  describe('social affiliations', () => {
    // A connection and a subreddit membership are an edge and a membership, not
    // authored content. They carry no Text/Body/URL, so toContentInput could
    // only ever write a content row with a NULL text AND a NULL url — and
    // ci.content has no title column, so nothing about it renders. A real
    // clean-room import produced 1,977 of them (1,975 LinkedIn connections,
    // 2 moderated subreddits): 100% of what those sources sent to content.

    it('gives a LinkedIn connection its event but no content row', () => {
      const connection = recordFor({
        classification: 'social',
        dataSource: 'linkedin',
        metadata: {
          Title: 'Connected with Morgan Spadone',
          Name: 'Morgan Spadone',
          Person: 'Morgan Spadone',
          Kind: 'connection',
          Source: 'LinkedIn',
        },
      });

      expect(destinationsFor(connection)).toEqual(['events']);
    });

    it('gives a moderated subreddit its event but no content row', () => {
      const subreddit = recordFor({
        classification: 'social',
        dataSource: 'reddit',
        metadata: { Title: 'r/bitscoop', Subreddit: 'bitscoop', Kind: 'moderated_subreddit' },
      });

      expect(destinationsFor(subreddit)).toEqual(['events']);
    });

    it('still donates a geotagged affiliation’s fix to the position table', () => {
      // Skipping `content` must not cost the position donation the social.*
      // branch has always made — the two are independent decisions.
      const connection = recordFor({
        classification: 'social',
        dataSource: 'linkedin',
        metadata: { Kind: 'connection', Name: 'Morgan Spadone' },
        latitude: 1,
        longitude: 2,
      });

      expect(destinationsFor(connection)).toEqual(['events', 'position']);
    });

    it('leaves a real LinkedIn post — one with a body — both homes', () => {
      // The predicate keys on Kind, not on the source: LinkedIn is not
      // blanket-excluded from content, only its connection rows are.
      const post = recordFor({
        classification: 'social',
        dataSource: 'linkedin',
        metadata: { Kind: 'post', Text: 'Thoughts on the release' },
      });

      expect(destinationsFor(post)).toEqual(['events', 'content']);
    });
  });
});

describe('isSocialAffiliation', () => {
  it('is true for the connection and subreddit-membership Kinds', () => {
    expect(isSocialAffiliation(recordFor({ dataSource: 'linkedin', metadata: { Kind: 'connection' } }))).toBe(
      true,
    );
    expect(
      isSocialAffiliation(recordFor({ dataSource: 'reddit', metadata: { Kind: 'moderated_subreddit' } })),
    ).toBe(true);
    // Emitted by pushSubreddit for subscribed_subreddits.csv, which the reddit
    // importer does not read today — covered so enabling that file cannot
    // reintroduce the empty rows.
    expect(
      isSocialAffiliation(recordFor({ dataSource: 'reddit', metadata: { Kind: 'subscribed_subreddit' } })),
    ).toBe(true);
  });

  it('is false for an authored row from the same source', () => {
    expect(isSocialAffiliation(recordFor({ dataSource: 'reddit', metadata: { Kind: 'post' } }))).toBe(false);
    expect(isSocialAffiliation(recordFor({ dataSource: 'linkedin', metadata: { Kind: 'message' } }))).toBe(
      false,
    );
  });

  it('is false for a matching Kind from another source', () => {
    // The sourceSystem check comes first: another importer's 'connection' is
    // not this shape, and must not lose its content row on the strength of a
    // coincidental metadata value.
    expect(
      isSocialAffiliation(recordFor({ dataSource: 'some_other_source', metadata: { Kind: 'connection' } })),
    ).toBe(false);
  });
});

describe('isRedditPost / isRedditComment', () => {
  it('is true only for reddit rows carrying the matching Kind', () => {
    const post = recordFor({ dataSource: 'reddit', metadata: { Kind: 'post' } });
    const savedPost = recordFor({ dataSource: 'reddit', metadata: { Kind: 'saved_post' } });
    const comment = recordFor({ dataSource: 'reddit', metadata: { Kind: 'comment' } });

    expect(isRedditPost(post)).toBe(true);
    expect(isRedditPost(savedPost)).toBe(true);
    expect(isRedditPost(comment)).toBe(false);
    expect(isRedditComment(comment)).toBe(true);
  });

  it('is false for a non-reddit source even with a matching Kind value', () => {
    // The dataSource check comes first — a coincidental Kind:'post' from
    // another importer must not be read as an authored reddit post.
    const lookalike = recordFor({ dataSource: 'some_other_source', metadata: { Kind: 'post' } });

    expect(isRedditPost(lookalike)).toBe(false);
  });
});

describe('redditMediaUrl', () => {
  it('reads a link post’s media from its URL field', () => {
    const post = recordFor({
      dataSource: 'reddit',
      metadata: { Kind: 'post', URL: 'https://i.redd.it/a.jpg' },
    });

    expect(redditMediaUrl(post)).toEqual({ url: 'https://i.redd.it/a.jpg', kind: 'image' });
  });

  it('is null for a post whose URL is not a recognised media link (a self-post permalink)', () => {
    const selfPost = recordFor({
      dataSource: 'reddit',
      metadata: { Kind: 'post', URL: 'https://reddit.com/r/pics/comments/abc123/my_post/' },
    });

    expect(redditMediaUrl(selfPost)).toBeNull();
  });

  it('finds the first media link inside a comment’s body markdown', () => {
    const comment = recordFor({
      dataSource: 'reddit',
      metadata: {
        Kind: 'comment',
        Body: 'not media: https://example.com, but this is: https://v.redd.it/clip1',
      },
    });

    expect(redditMediaUrl(comment)).toEqual({ url: 'https://v.redd.it/clip1', kind: 'video' });
  });

  it('is null for a comment whose body has no media link at all', () => {
    const comment = recordFor({ dataSource: 'reddit', metadata: { Kind: 'comment', Body: 'just words' } });

    expect(redditMediaUrl(comment)).toBeNull();
  });

  it('strips trailing punctuation a sentence wraps the link in', () => {
    const comment = recordFor({
      dataSource: 'reddit',
      metadata: { Kind: 'comment', Body: 'check this out (https://i.redd.it/trailing.png).' },
    });

    expect(redditMediaUrl(comment)?.url).toBe('https://i.redd.it/trailing.png');
  });
});

describe('Discord attachments', () => {
  describe('discordAttachmentUrls', () => {
    it('splits space-separated links off a multi-attachment message', () => {
      const message = recordFor({
        dataSource: 'discord',
        metadata: {
          Attachments: 'https://cdn.discordapp.com/a/1/x.png https://cdn.discordapp.com/a/1/y.png',
        },
      });

      expect(discordAttachmentUrls(message)).toEqual([
        'https://cdn.discordapp.com/a/1/x.png',
        'https://cdn.discordapp.com/a/1/y.png',
      ]);
    });

    it('is empty for a non-Discord source even with an Attachments-shaped field', () => {
      const notDiscord = recordFor({
        dataSource: 'imessage',
        metadata: { Attachments: 'https://cdn.discordapp.com/a/1/x.png' },
      });

      expect(discordAttachmentUrls(notDiscord)).toEqual([]);
    });

    it('is empty when the field is absent', () => {
      expect(discordAttachmentUrls(recordFor({ dataSource: 'discord' }))).toEqual([]);
    });
  });

  describe('discordAttachmentFilename', () => {
    it('decodes a percent-encoded name and drops the signature query string', () => {
      const url = 'https://cdn.discordapp.com/attachments/1/2/Screenshot%20from%202020.png?ex=1&is=2&hm=3';

      expect(discordAttachmentFilename(url)).toBe('Screenshot from 2020.png');
    });

    it('is undefined for an unparseable URL', () => {
      expect(discordAttachmentFilename('not a url')).toBeUndefined();
    });
  });

  describe('isDiscordAttachmentOnly', () => {
    it('is true for a Discord message with attachments and no text', () => {
      const message = recordFor({
        dataSource: 'discord',
        metadata: { Attachments: 'https://cdn.discordapp.com/a/1/x.png' },
      });

      expect(isDiscordAttachmentOnly(message)).toBe(true);
    });

    it('is false once the message carries a caption', () => {
      const captioned = recordFor({
        dataSource: 'discord',
        metadata: { Text: 'look!', Attachments: 'https://cdn.discordapp.com/a/1/x.png' },
      });

      expect(isDiscordAttachmentOnly(captioned)).toBe(false);
    });

    it('is false for a Discord message with no attachments at all', () => {
      expect(isDiscordAttachmentOnly(recordFor({ dataSource: 'discord' }))).toBe(false);
    });
  });

  // U+FFFC OBJECT REPLACEMENT CHARACTER is what macOS writes into
  // `message.text` where an inline attachment sits. It is a control glyph, not
  // text: a live appliance database held 21,781 iMessage rows whose ENTIRE
  // ci.communications.content was one of them.
  describe('str() strips the U+FFFC attachment placeholder', () => {
    it('collapses a body that is nothing but placeholders to null', () => {
      expect(str('\uFFFC')).toBeNull();
      expect(str('\uFFFC\uFFFC')).toBeNull();
      expect(str('\uFFFC ')).toBeNull();
    });

    it('leaves a CAPTIONED attachment as just the caption', () => {
      expect(str('\uFFFC look at this')).toBe('look at this');
      expect(str('\uFFFC\uFFFCGood morning see you tomorrow')).toBe('Good morning see you tomorrow');
      expect(str('Also, what is this thing called?\uFFFC\uFFFC')).toBe('Also, what is this thing called?');
    });

    it('still repairs lone surrogates, and never splices two into a fake pair', () => {
      // The FFFC strip runs AFTER the surrogate repair, so removing the glyph
      // between a high and a low surrogate cannot fabricate an emoji that was
      // never in the source.
      expect(str('\uD83D\uFFFC\uDE00')).toBe('\uFFFD\uFFFD');
      // A genuine pair is untouched.
      expect(str('\uD83D\uDE00')).toBe('\uD83D\uDE00');
    });

    it('does NOT strip U+FFFD — sanitizeText mints it for broken surrogates', () => {
      expect(str('\uFFFD')).toBe('\uFFFD');
    });
  });

  describe('isAttachmentPlaceholderOnly', () => {
    it('is true for an iMessage body that is only the U+FFFC placeholder', () => {
      const attachmentOnly = recordFor({
        classification: 'message',
        dataSource: 'imessage',
        metadata: { Text: '\uFFFC', Sender: '+15551234567' },
      });

      expect(attachmentOnly.description).toBeNull();
      expect(isAttachmentPlaceholderOnly(attachmentOnly)).toBe(true);
    });

    it('is true for a body that is only U+FFFD mojibake', () => {
      const mojibake = recordFor({
        classification: 'message',
        dataSource: 'imessage',
        metadata: { Text: '\uFFFD\uFFFD', Sender: '+15551234567' },
      });

      expect(isAttachmentPlaceholderOnly(mojibake)).toBe(true);
    });

    it('is false once the placeholder is joined by real caption text', () => {
      const captioned = recordFor({
        classification: 'message',
        dataSource: 'imessage',
        metadata: { Text: '\uFFFC Merry Christmas' },
      });

      expect(captioned.description).toBe('Merry Christmas');
      expect(isAttachmentPlaceholderOnly(captioned)).toBe(false);
    });

    it('is false for a message with no body metadata at all', () => {
      expect(
        isAttachmentPlaceholderOnly(recordFor({ classification: 'message', dataSource: 'imessage' })),
      ).toBe(false);
    });

    it('is false when a lower-priority body key carries the real text', () => {
      // descriptionFor prefers Text, but falls through to Body — a placeholder
      // in the preferred key must not blank a record that has real prose.
      const rec = recordFor({
        classification: 'message',
        dataSource: 'imessage',
        metadata: { Text: '\uFFFC', Body: 'the real message' },
      });

      expect(rec.description).toBe('the real message');
      expect(isAttachmentPlaceholderOnly(rec)).toBe(false);
    });
  });
});

describe('edgeProjectionSourcesFor', () => {
  /**
   * The seam between two vocabularies that were named independently: the
   * import's `Destination` and the deterministic-edge matrix's
   * `DeterministicEdgeSource`. A wrong pair here is silent — the listener drops
   * the unknown string and the leg is simply never kicked — so every pair is
   * pinned by name rather than by a round-trip through a map.
   */
  it('maps each edge-bearing destination to the matrix source spelling', () => {
    expect(edgeProjectionSourcesFor(['communications'])).toEqual(['communications']);
    expect(edgeProjectionSourcesFor(['events'])).toEqual(['events']);
    expect(edgeProjectionSourcesFor(['content'])).toEqual(['content']);
    expect(edgeProjectionSourcesFor(['things'])).toEqual(['objects']);
    // The one that is NOT the destination's own name.
    expect(edgeProjectionSourcesFor(['position'])).toEqual(['positions']);
  });

  it('maps browser_activity to nothing — the matrix has no rule over that table', () => {
    expect(edgeProjectionSourcesFor(['browser_activity'])).toEqual([]);
  });

  it('returns an empty list rather than a full scope for a push with no edge sources', () => {
    // The caller must read this as "request nothing". A scope-less payload
    // would read to the listener as "every source", turning a
    // browser-activity-only import into a full-corpus projection pass.
    expect(edgeProjectionSourcesFor([])).toEqual([]);
  });

  it('deduplicates and orders stably, so repeated pushes make identical requests', () => {
    expect(edgeProjectionSourcesFor(['content', 'communications', 'content', 'events'])).toEqual([
      'communications',
      'events',
      'content',
    ]);
  });
});

describe('a contact card is a person, not a document', () => {
  /**
   * The other half of the shape #2152 fixed for LinkedIn connections. A vCard /
   * Address Book / contact-list card has no `KIND_BY_CLASSIFICATION` entry, so
   * it fell to the default and the undated-file rule filed it as
   * `import.archive_item` -> a `ci.content` row with `type='file'` and a NULL
   * url: a file pointing at no file.
   *
   * Measured on a fresh full-corpus import carrying every fix merged
   * 2026-08-19: 4,870 such rows from vcard, 2,085 of them with no text and no
   * url. The same parsers already emit each card correctly on the entity lane,
   * so the content row was a second, empty copy.
   */
  const contactRecord = (overrides: Record<string, unknown> = {}) =>
    ({
      kind: kindFor('contact', null),
      metadata: {},
      sourceSystem: 'vcard',
      title: 'Nadia Whitlock',
      description: null,
      coordinates: null,
      time: null,
      mediaType: null,
      mediaPath: null,
      ...overrides,
    }) as never;

  it('gives a contact classification its own kind', () => {
    expect(kindFor('contact', null)).toBe('contact.card');
  });

  it('routes a contact card nowhere — the entity lane already has it', () => {
    expect(destinationsFor(contactRecord())).toEqual([]);
  });

  it('still routes a plain file to content, so the file rule is untouched', () => {
    expect(kindFor('file', null)).toBe('import.archive_item');
    // Pinned to the destination, not merely to "somewhere". The record is
    // undated so the result is deterministic, and `.length > 0` would have
    // passed if the file rule regressed from ['content'] to ['events'] --
    // exactly what this test's name claims to guard.
    expect(destinationsFor(contactRecord({ kind: kindFor('file', null) }))).toEqual(['content']);
  });
});

describe('isRepresentedElsewhere — routed nowhere, and not a loss', () => {
  /**
   * `destinationsFor` returns `[]` for two kinds of record that mean opposite
   * things to the run's gap list. A contact card is routed nowhere because its
   * Person arrived on the entity lane; an undated GPS fix is routed nowhere
   * because it has nothing left to file. Counting both as `no_destination` made
   * every address-book import report a loss it had not had — 341 of them on
   * one Takeout, beside the 337 Persons the same run resolved.
   */
  it('says a contact card is carried by the entity lane', () => {
    const card = recordFor({ dataSource: 'vcard', classification: 'contact', occurredAt: null });

    expect(destinationsFor(card)).toEqual([]);
    expect(isRepresentedElsewhere(card)).toBe(true);
  });

  it('says a rolled-up subscription line is carried by its order’s itemised receipt', () => {
    const line = recordFor({
      dataSource: 'amazon',
      classification: 'purchase',
      metadata: { Product: 'Prime Membership', Subscription: true, ReceiptRollupId: 'order-1' },
    });

    expect(destinationsFor(line)).toEqual([]);
    expect(isRepresentedElsewhere(line)).toBe(true);
  });

  it('does not excuse an undated raw GPS fix — nothing else carries it', () => {
    const fix = recordFor({
      dataSource: 'nmea',
      classification: 'location',
      occurredAt: null,
      latitude: 1,
      longitude: 2,
    });

    expect(destinationsFor(fix)).toEqual([]);
    expect(isRepresentedElsewhere(fix)).toBe(false);
  });

  it('has nothing to say about a social affiliation, which keeps its event and never reaches []', () => {
    const connection = recordFor({
      dataSource: 'linkedin',
      classification: 'social',
      metadata: { Kind: 'connection' },
    });

    expect(isSocialAffiliation(connection)).toBe(true);
    expect(destinationsFor(connection)).toEqual(['events']);
  });
});

describe('communicationAttachmentsFrom', () => {
  /**
   * The union the media leg reads. Two parser generations wrote two different
   * keys for the same idea and NEITHER was ever read — `MediaAttachments` by
   * twitter, gmail, iMessage and the chat exports, `MediaFilePaths` by facebook
   * and sms_backup_restore. Reading only one of them leaves half the sources
   * dropping their attachments exactly as before.
   */
  it('reads the rich descriptor shape', () => {
    const attachments = communicationAttachmentsFrom({
      MediaAttachments: [
        { path: '/scratch/a.jpg', filename: 'holiday.jpg', type: 'image', mimetype: 'image/jpeg' },
      ],
    });

    expect(attachments).toEqual([
      { path: '/scratch/a.jpg', filename: 'holiday.jpg', type: 'image', mimetype: 'image/jpeg' },
    ]);
  });

  it('fills a bare path in from its own extension', () => {
    // An MMS part is bytes and nothing else, so the filename and MIME have to
    // come from the path or the file arrives called `d41d8cd98f…` and untyped.
    expect(communicationAttachmentsFrom({ MediaFilePaths: ['/scratch/part-1.png'] })).toEqual([
      { path: '/scratch/part-1.png', filename: 'part-1.png', type: 'media', mimetype: 'image/png' },
    ]);
  });

  it('keeps a non-media attachment honest rather than calling it media', () => {
    // An email's PDF is a file. Typing it 'media' would put it in a gallery.
    expect(communicationAttachmentsFrom({ MediaFilePaths: ['/scratch/invoice.pdf'] })).toMatchObject([
      { type: 'file', mimetype: 'application/pdf' },
    ]);
  });

  it('drops a descriptor with no path, because there are no bytes to store', () => {
    // Still counted as a gap by the caller — see MediaStage's attachment_no_path.
    expect(communicationAttachmentsFrom({ MediaAttachments: [{ guid: 'abc', type: 'image' }] })).toEqual([]);
  });

  it('does not upload the same file twice when both keys name it', () => {
    // A parser is allowed to write both; two entries for one photo would put
    // the same file in `attachments` twice.
    const attachments = communicationAttachmentsFrom({
      MediaAttachments: [{ path: '/scratch/same.jpg', filename: 'same.jpg', type: 'image' }],
      MediaFilePaths: ['/scratch/same.jpg', '/scratch/other.jpg'],
    });

    expect(attachments.map((a) => a.path)).toEqual(['/scratch/same.jpg', '/scratch/other.jpg']);
  });

  it('is empty for a message that carries nothing', () => {
    expect(communicationAttachmentsFrom({ Text: 'hi' })).toEqual([]);
    expect(communicationAttachmentsFrom(undefined)).toEqual([]);
  });
});

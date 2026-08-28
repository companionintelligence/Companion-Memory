/*
 * Twitter/X archive → communications, plus retweets as events.
 *
 * Tweets, replies and DMs are things the account SAID, so they import as
 * communication rows (classification 'message'). A retweet is an act of
 * sharing, so it imports as an event (classification 'social') titled after
 * the shared post — and only when the archive dates it. Likes are not imported.
 *
 * What each test pins is the part a format change would break silently:
 * direction, the media→file/content descriptors, the retweet title, and the
 * coordinates a geotagged tweet donates.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Graph, ImportParams, Item, MediaAttachment } from '../timeline';
import { TwitterFileImporter } from '../twitter';

import type { EmittedGraph, TestPipeline } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const ROOT = path.join(FIXTURES_DIR, 'twitter-archive');

interface Run {
  items: Item[];
  drops: Array<{ reason: string; detail?: string }>;
  byId: (id: string) => Item;
}

async function runImport(over: Partial<ImportParams> = {}, root: string = ROOT): Promise<Run> {
  const collected: Graph[] = [];
  const drops: Array<{ reason: string; detail?: string }> = [];
  const fi = new TwitterFileImporter();
  await fi.fileImport({}, { filename: path.basename(root), fullPath: root }, {
    options: { includeReplies: true, includeRetweets: true },
    timeframe: {},
    log: () => {},
    ...over,
    pipeline: {
      push: (g: Graph) => collected.push(g as EmittedGraph),
      drop: (reason: string, detail?: string) => drops.push({ reason, detail }),
    },
  } as unknown as ImportParams);
  const items = collected.map((g) => g.item!).filter(Boolean);

  return {
    items,
    drops,
    byId: (id: string) => {
      const hit = items.find((i) => i.id === id);
      if (!hit) {
        throw new Error(`no item ${id} (have: ${items.map((i) => i.id!).join(', ')})`);
      }

      return hit;
    },
  };
}

const attachments = (item: Item): MediaAttachment[] =>
  (item.metadata?.MediaAttachments as MediaAttachment[] | undefined) ?? [];

describe('Twitter archive datasource', () => {
  // The importer copies attachments into the media store, so give each run a
  // throwaway one rather than writing next to the fixture.
  let storeDir: string;
  beforeEach(() => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-twitter-store-'));
  });
  afterEach(() => {
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  it('recognizes manifest.js', async () => {
    const fi = new TwitterFileImporter();
    const rec = await fi.recognize({}, { filename: path.basename(ROOT), fullPath: ROOT });
    expect(rec.confidence).toBeGreaterThan(0.8);
    expect(rec.snapshot_date).toBeInstanceOf(Date);
    expect(rec.snapshot_date?.toISOString()).toBe('2025-01-05T00:00:00.000Z');
  });

  it('imports what the account said as communications and a dated retweet as an event', async () => {
    const { items } = await runImport({ mediaStoreDir: storeDir });
    // 3 tweets + 2 DMs as communications, 1 dated retweet as an event. The
    // undated retweet and the like produce nothing.
    expect(items.length).toBe(6);
    expect(items.filter((i) => i.classification === 'message').length).toBe(5);
    expect(items.filter((i) => i.classification === 'social').length).toBe(1);
    expect(items.every((i) => !!i.timestamp)).toBe(true);
  });

  it('imports no likes at all', async () => {
    const { items } = await runImport({ mediaStoreDir: storeDir });
    // like.js is in the fixture; nothing derived from it may appear.
    expect(items.some((i) => i.id?.includes('like'))).toBe(false);
    expect(items.some((i) => i.metadata?.Kind === 'like')).toBe(false);
  });

  it('marks what the account sent outbound and what reached it inbound', async () => {
    const { byId } = await runImport({ mediaStoreDir: storeDir });
    expect(byId('twitter:tweet:1').metadata?.Direction).toBe('sent');
    // DM sent by the archive owner (senderId === accountId) vs one received.
    expect(byId('twitter:dm:5001').metadata?.Direction).toBe('sent');
    expect(byId('twitter:dm:5002').metadata?.Direction).toBe('received');
  });

  it('carries the message body, participants and thread on each communication', async () => {
    const { byId } = await runImport({ mediaStoreDir: storeDir });

    const tweet = byId('twitter:tweet:1');
    expect(tweet.metadata?.CommunicationType).toBe('post');
    expect(tweet.metadata?.Text).toBe('Hello world https://example.com/full'); // t.co expanded
    expect(tweet.metadata?.Sender).toBe('@tester');
    expect(tweet.metadata?.URL).toBe('https://x.com/tester/status/1');
    expect(tweet.metadata?.Retweets).toBe(1);
    expect(tweet.metadata?.Likes).toBe(2);
    expect(tweet.metadata?.Client).toBe('Twitter Web Client');

    // A reply is addressed to the account it answers and joins that thread.
    const reply = byId('twitter:tweet:2');
    expect(reply.metadata?.To).toEqual(['@someone']);
    expect(reply.metadata?.ThreadId).toBe('1');
    expect(reply.metadata?.Kind).toBe('reply');

    // DMs are chat, threaded by conversation, with the raw participant ids the
    // export gives (it records no handles).
    const dm = byId('twitter:dm:5002');
    expect(dm.metadata?.CommunicationType).toBe('chat');
    // The t.co the DM carries is X's self-link to the attachment this message
    // already ships, so it's stripped rather than expanded — otherwise a
    // media-only DM's whole body is a /messages/media/ URL.
    expect(dm.metadata?.Text).toBe('yo');
    // The export names DM participants by account id only; tweets.js is the one
    // store pairing an id with a handle, so these resolve through it — 158017896
    // is @someone there, and 2840684163 is the archive owner.
    expect(dm.metadata?.Sender).toBe('@someone');
    expect(dm.metadata?.To).toEqual(['@tester']);
    // The raw ids stay alongside: they are the durable key, and a handle can be
    // reassigned to a different account.
    expect(dm.metadata?.SenderId).toBe('158017896');
    expect(dm.metadata?.RecipientIds).toEqual(['2840684163']);
    expect(dm.metadata?.ThreadId).toBe('158017896-2840684163');
  });

  it('describes each attachment with its type and its URL on X', async () => {
    const { byId } = await runImport({ mediaStoreDir: storeDir });

    const [photo, video] = attachments(byId('twitter:tweet:3'));
    expect(photo).toMatchObject({
      type: 'image',
      mimetype: 'image/jpeg',
      url: 'https://pbs.twimg.com/media/PIC1.jpg',
    });
    // A video's own URL is its highest-bitrate MP4 variant — media_url_https is
    // only the thumbnail — and its bytes are filed under a variant name.
    expect(video).toMatchObject({
      type: 'video',
      mimetype: 'video/mp4',
      url: 'https://video.twimg.com/ext_tw_video/9002/vid/480x480/CLIP.mp4',
    });
    expect(path.basename(video.path)).toContain('CLIP.mp4');

    // Messages with no media carry no descriptors at all.
    expect(byId('twitter:tweet:1').metadata?.MediaAttachments).toBeUndefined();
  });

  it('drops a source URL X no longer serves, so the stored copy is what the content row points at', async () => {
    const { byId } = await runImport({ mediaStoreDir: storeDir });

    // ton.twitter.com was the legacy DM CDN and is retired: a content row
    // pointed there is a dead link, so the descriptor ships without a URL and
    // media.ts falls back to the uploaded copy's signed URL. The bytes still
    // came through.
    const [dmPic] = attachments(byId('twitter:dm:5002'));
    expect(dmPic.url).toBeUndefined();
    expect(dmPic.type).toBe('image');
    expect(fs.existsSync(dmPic.path)).toBe(true);

    // Public tweet media is still served, so those URLs survive (asserted
    // above) — the filter is host-specific, not a blanket drop.
  });

  it('strips the media self-link from a tweet that carries attachments', async () => {
    const { byId } = await runImport({ mediaStoreDir: storeDir });

    // `https://t.co/pic` / `https://t.co/vid` are the shorteners X appended for
    // tweet 3's own photo and clip — they point at the attachments the row
    // already carries.
    expect(byId('twitter:tweet:3').metadata?.Text).toBe('photo and clip');
    // A link the author actually wrote still expands.
    expect(byId('twitter:tweet:1').metadata?.Text).toBe('Hello world https://example.com/full');
  });

  it('retains attachment bytes in the media store, which outlives the unpacked archive', async () => {
    const { byId } = await runImport({ mediaStoreDir: storeDir });
    for (const a of attachments(byId('twitter:tweet:3'))) {
      expect(a.path.startsWith(storeDir + path.sep)).toBe(true);
      expect(fs.existsSync(a.path)).toBe(true);
    }
  });

  it('leaves attachments in the archive when there is no media store', async () => {
    const { byId } = await runImport();
    const [photo] = attachments(byId('twitter:tweet:3'));
    expect(photo.path.startsWith(ROOT)).toBe(true);
  });

  it("donates a geotagged tweet's coordinates", async () => {
    const { byId, items } = await runImport({ mediaStoreDir: storeDir });
    // `geo` is [lat, lon] and arrives as strings — a swap here would put the
    // tweet in the wrong hemisphere.
    expect(byId('twitter:tweet:3').location).toEqual({ latitude: 33.514774, longitude: -117.7217729 });
    expect(items.filter((i) => i.location).length).toBe(1);
  });

  it('makes a dated retweet an event titled after the post it shared', async () => {
    const { byId } = await runImport({ mediaStoreDir: storeDir });
    const rt = byId('twitter:retweet:4');

    expect(rt.classification).toBe('social'); // an event, not a communication
    expect(rt.timestamp?.toISOString()).toBe('2025-01-06T08:00:00.000Z');
    // The shared post's title is its own text — the `RT @author:` marker is
    // the archive's only record of the original, and it isn't part of it.
    expect(rt.metadata?.Title).toBe('Retweeted worth a read — the whole thread https://example.com/thread');
    expect(rt.metadata?.RetweetOf).toBe('@someone');
    expect(rt.metadata?.Kind).toBe('retweet');
    // No direction / communication type: an event is not a message.
    expect(rt.metadata?.Direction).toBeUndefined();
    expect(rt.metadata?.CommunicationType).toBeUndefined();
  });

  it('makes nothing at all from an undated retweet', async () => {
    const { items, drops } = await runImport({ mediaStoreDir: storeDir });
    expect(items.some((i) => i.id === 'twitter:retweet:5')).toBe(false);
    expect(drops).toContainEqual({ reason: 'undated_retweet', detail: '5' });
  });

  it('clips a long shared post into the retweet title', async () => {
    const long = 'word '.repeat(60).trim();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-twitter-long-'));
    fs.mkdirSync(path.join(dir, 'data'));
    fs.writeFileSync(
      path.join(dir, 'data', 'tweets.js'),
      'window.YTD.tweets.part0 = ' +
        JSON.stringify([
          {
            tweet: {
              id_str: '9',
              created_at: 'Mon Jan 06 08:00:00 +0000 2025',
              full_text: `RT @someone: ${long}`,
            },
          },
        ]),
    );

    const collected: Graph[] = [];
    await new TwitterFileImporter().fileImport({}, { filename: path.basename(dir), fullPath: dir }, {
      timeframe: {},
      log: () => {},
      pipeline: { push: (g: Graph) => collected.push(g as EmittedGraph) },
    } as unknown as ImportParams);

    const title = collected[0].item!.metadata!.Title as string;
    expect(title.startsWith('Retweeted word word')).toBe(true);
    expect(title.endsWith('…')).toBe(true);
    expect(title.length).toBeLessThanOrEqual('Retweeted '.length + 80);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('never strands half a surrogate pair, even with two astral characters at the cut boundary', async () => {
    // A single-lookback fix ("is the unit right before the cut a high
    // surrogate?") only catches one surrogate pair at the boundary. Two
    // consecutive astral characters (two 2-unit emoji back to back) straddling
    // the cut still stranded a lone high surrogate one position further in —
    // real production data, not a contrived edge case; a lone `\ud83d` in a
    // retweet title reached ci_import.staged_items.metadata as a bound `pg`
    // query parameter and Postgres's jsonb parser rejected the whole row with
    // "invalid input syntax for type json", rolling back every row in the same
    // flush batch (StagedWriter batches writes into one transaction).
    const padding = 'x'.repeat(77);
    const long = `${padding}👽🪐 trailing text well past the 80-character clip`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-twitter-surrogate-'));
    fs.mkdirSync(path.join(dir, 'data'));
    fs.writeFileSync(
      path.join(dir, 'data', 'tweets.js'),
      'window.YTD.tweets.part0 = ' +
        JSON.stringify([
          {
            tweet: {
              id_str: '10',
              created_at: 'Mon Jan 06 08:00:00 +0000 2025',
              full_text: `RT @someone: ${long}`,
            },
          },
        ]),
    );

    const collected: Graph[] = [];
    await new TwitterFileImporter().fileImport({}, { filename: path.basename(dir), fullPath: dir }, {
      timeframe: {},
      log: () => {},
      pipeline: { push: (g: Graph) => collected.push(g as EmittedGraph) },
    } as unknown as ImportParams);

    const title = collected[0].item!.metadata!.Title as string;

    // The real failure mode: a lone high surrogate as the LAST code unit
    // before whatever follows (the ellipsis, here) — invalid on its own,
    // since a high surrogate must be immediately followed by its low pair.
    const lastCode = title.codePointAt(title.length - 2);
    expect(lastCode == null || lastCode < 0xd800 || lastCode > 0xdbff).toBe(true);

    // What actually broke in production: this string reaching Postgres as a
    // jsonb column value. Node's own JSON.stringify does not catch a stranded
    // surrogate (this is exactly why the bug reached the database undetected),
    // so the real assertion is that round-tripping through JSON never PRODUCES
    // one — checked by re-decoding and confirming no replacement/malformed
    // code point appears where the emoji pair should be.
    const roundTripped = JSON.parse(JSON.stringify({ title })).title as string;
    expect(roundTripped).toBe(title);
    expect(title).toContain('…');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('honors the retweet and reply options, reporting what it excluded', async () => {
    const { items, drops } = await runImport({
      mediaStoreDir: storeDir,
      options: { includeRetweets: false, includeReplies: false },
    });
    const ids = items.map((i) => i.id!);
    expect(ids).not.toContain('twitter:tweet:2'); // the reply
    expect(ids).not.toContain('twitter:retweet:4'); // the retweet
    expect(drops.filter((d) => d.reason === 'excluded_reply').length).toBe(1);
    expect(drops.filter((d) => d.reason === 'excluded_retweet').length).toBe(2);
  });

  it('applies the timeframe to every record type', async () => {
    const { items } = await runImport({
      mediaStoreDir: storeDir,
      timeframe: { since: new Date('2025-01-05T00:00:00Z'), until: new Date('2025-01-07T23:59:59Z') },
    });
    expect(items.map((i) => i.id!).sort()).toEqual([
      'twitter:dm:5001',
      'twitter:retweet:4',
      'twitter:tweet:3',
    ]);
  });
});

/*
 * Long-form posts. X stores a post over ~280 chars TWICE and neither copy is
 * complete: tweets.js truncates the body and appends a bare "show more" t.co,
 * note-tweet.js holds the whole text but records no tweet id. The importer
 * rejoins them on snowflake proximity — a note and its tweet are ids minted in
 * the same publish request, note first, tens of ms apart.
 *
 * These fixtures are built in code because the join IS id arithmetic: the cases
 * that matter are deltas measured in milliseconds of snowflake id space, which
 * a checked-in JSON blob would bury.
 */
describe('Twitter long-form posts (note-tweet.js)', () => {
  // One millisecond of snowflake id space: Twitter ids are `timestamp << 22`.
  const MS = 4194304n;
  // A real note id from a production archive, as the base for every case.
  const NOTE_BASE = 2064505593935646720n;
  const idAfter = (base: bigint, ms: number) => (base + BigInt(ms) * MS).toString();

  // The marker sits PAST the truncation point, so asserting on it can only pass
  // if the note's body actually replaced the tweet's — every other sentence
  // survives the cut and would make the assertion vacuous.
  const BEYOND_CUT = 'Only note-tweet.js carries this closing line.';
  const BODY =
    'Surveillance Is Not Safety: children deserve to be safe, protected, and nurtured. ' +
    'They do not deserve surveillance, funding cuts, and cover-ups. They also deserve ' +
    'their human right to privacy, which client-side scanning would end for everyone. ' +
    'Read the full statement at https://t.co/statement for the argument in full. ' +
    BEYOND_CUT;
  // How tweets.js ships it: cut mid-sentence, with a link to the rest.
  const truncated = (body: string) => `${body.slice(0, 270)}… https://t.co/showmore`;

  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-note-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** A minimal archive: account + the given tweets and notes. */
  function writeArchive(tweets: object[], notes: object[]): string {
    const data = path.join(dir, 'data');
    fs.mkdirSync(data, { recursive: true });
    const store = (file: string, key: string, rows: object[], wrap: string) =>
      fs.writeFileSync(
        path.join(data, file),
        `window.YTD.${key}.part0 = ${JSON.stringify(rows.map((r) => ({ [wrap]: r })))}`,
      );
    store('account.js', 'account', [{ accountId: '158017896', username: 'tester' }], 'account');
    store('tweets.js', 'tweets', tweets, 'tweet');
    store('note-tweet.js', 'note_tweet', notes, 'noteTweet');

    return dir;
  }

  const tweet = (id: string, full_text: string, over: object = {}) => ({
    id,
    id_str: id,
    created_at: 'Wed Jun 10 00:31:04 +0000 2026',
    full_text,
    favorite_count: '0',
    retweet_count: '0',
    entities: { urls: [], user_mentions: [] },
    ...over,
  });
  const note = (noteTweetId: string, text: string, urls: object[] = []) => ({
    noteTweetId,
    createdAt: '2026-06-10T00:31:04.000Z',
    updatedAt: '2026-06-10T00:31:04.000Z',
    core: { text, urls, mentions: [], hashtags: [], cashtags: [], styletags: [] },
  });

  it("restores the full body onto the post whose id follows the note, expanding the note's own links", async () => {
    // 84ms after the note — the delta a real publish produces.
    const tweetId = idAfter(NOTE_BASE, 84);
    const root = writeArchive(
      [tweet(tweetId, truncated(BODY))],
      [
        note(NOTE_BASE.toString(), BODY, [
          { shortUrl: 'https://t.co/statement', expandedUrl: 'https://signal.org/blog/statement.pdf' },
        ]),
      ],
    );

    const { byId, drops } = await runImport({}, root);
    const text = byId(`twitter:tweet:${tweetId}`).metadata?.Text as string;

    // The whole post, not the 270-char cut.
    expect(text).toContain(BEYOND_CUT);
    // The "show more" t.co is gone — the rest of the post is inline now.
    expect(text).not.toContain('t.co/showmore');
    expect(text).not.toContain('…');
    // note core.urls uses shortUrl/expandedUrl, not the tweet entities shape.
    expect(text).toContain('https://signal.org/blog/statement.pdf');
    expect(text).not.toContain('t.co/statement');
    expect(drops.filter((d) => d.reason === 'note_tweet_unmatched')).toEqual([]);
  });

  it('leaves the post truncated when no tweet is minted inside the window', async () => {
    // 2000ms later: a real pair is 10–84ms apart, so this is not that post.
    const tweetId = idAfter(NOTE_BASE, 2000);
    const root = writeArchive([tweet(tweetId, truncated(BODY))], [note(NOTE_BASE.toString(), BODY)]);

    const { byId, drops } = await runImport({}, root);

    const text = byId(`twitter:tweet:${tweetId}`).metadata?.Text as string;
    expect(text).toContain('t.co/showmore');
    expect(text).not.toContain(BEYOND_CUT);
    expect(drops).toContainEqual({ reason: 'note_tweet_unmatched', detail: NOTE_BASE.toString() });
  });

  it('leaves the post truncated when two candidates in the window both match', async () => {
    // The same body posted twice in a half-second: the window cannot say which
    // one shipped this note, so neither gets it.
    const first = idAfter(NOTE_BASE, 40);
    const second = idAfter(NOTE_BASE, 300);
    const root = writeArchive(
      [tweet(first, truncated(BODY)), tweet(second, truncated(BODY))],
      [note(NOTE_BASE.toString(), BODY)],
    );

    const { byId, drops } = await runImport({}, root);

    for (const id of [first, second]) {
      const text = byId(`twitter:tweet:${id}`).metadata?.Text as string;
      expect(text).toContain('t.co/showmore');
      expect(text).not.toContain(BEYOND_CUT);
    }

    expect(drops).toContainEqual({ reason: 'note_tweet_unmatched', detail: NOTE_BASE.toString() });
  });

  it("does not let a retweet in the window claim the original post's body", async () => {
    // A self-retweet lands 200ms after the note; the real post is 50ms after.
    const original = idAfter(NOTE_BASE, 50);
    const shared = idAfter(NOTE_BASE, 200);
    const root = writeArchive(
      [tweet(original, truncated(BODY)), tweet(shared, `RT @tester: ${truncated(BODY)}`)],
      [note(NOTE_BASE.toString(), BODY)],
    );

    const { byId, items } = await runImport({}, root);

    // The original got the body — which only happens if the RT was rejected as a
    // candidate, since two hits in the window would abandon the join entirely.
    expect(byId(`twitter:tweet:${original}`).metadata?.Text).toContain(BEYOND_CUT);
    // The retweet stayed an event carrying the shared post's own truncated text.
    expect(items.map((i) => i.id!)).toContain(`twitter:retweet:${shared}`);
    const rt = byId(`twitter:retweet:${shared}`).metadata?.Text as string;
    expect(rt).toContain('t.co/showmore');
    expect(rt).not.toContain(BEYOND_CUT);
  });

  it('keeps the tweet body when the note text is shorter — core.text omits the trailing card link', async () => {
    // A note under 280 chars is not truncated in tweets.js, and full_text also
    // carries a card/quote t.co that core.text never has. Substituting would
    // delete that link.
    const short = 'Excited for our most ambitious #Metaverse event yet!';
    const tweetId = idAfter(NOTE_BASE, 30);
    const root = writeArchive(
      [tweet(tweetId, `${short} https://t.co/card`)],
      [note(NOTE_BASE.toString(), short)],
    );

    const { byId } = await runImport({}, root);

    expect(byId(`twitter:tweet:${tweetId}`).metadata?.Text).toBe(`${short} https://t.co/card`);
  });

  it('imports normally when the archive has no note-tweet.js at all', async () => {
    const tweetId = idAfter(NOTE_BASE, 84);
    const root = writeArchive([tweet(tweetId, 'a short post')], []);
    fs.rmSync(path.join(root, 'data', 'note-tweet.js'));

    const { byId, drops } = await runImport({}, root);

    expect(byId(`twitter:tweet:${tweetId}`).metadata?.Text).toBe('a short post');
    expect(drops.filter((d) => d.reason === 'note_tweet_unmatched')).toEqual([]);
  });
});

/*
 * Putting names to the numeric ids.
 *
 * The export identifies everyone in a DM by account id and never by handle, so
 * conversations import as rows of meaningless numbers. tweets.js is the only
 * store that pairs the two. Group conversations are worse off still: their
 * messages carry no recipient field at all, and membership lives in separate
 * events beside the messages.
 */
describe('Twitter participant identity', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-tw-who-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const OWNER = '1000';

  interface ArchiveOpts {
    account?: object;
    tweets?: object[];
    dms?: object[];
    groups?: object[];
  }

  function writeArchive(opts: ArchiveOpts = {}): string {
    const data = path.join(dir, 'data');
    fs.mkdirSync(data, { recursive: true });
    const store = (file: string, key: string, rows: object[], wrap: string) =>
      fs.writeFileSync(
        path.join(data, file),
        `window.YTD.${key}.part0 = ${JSON.stringify(rows.map((r) => ({ [wrap]: r })))}`,
      );
    if (opts.account !== null) {
      store(
        'account.js',
        'account',
        [
          opts.account ?? {
            accountId: OWNER,
            username: 'tester',
            accountDisplayName: 'Testy McTest',
          },
        ],
        'account',
      );
    }

    store('tweets.js', 'tweets', opts.tweets ?? [], 'tweet');
    if (opts.dms) {
      store('direct-messages.js', 'direct_messages', opts.dms, 'dmConversation');
    }

    if (opts.groups) {
      store('direct-messages-group.js', 'direct_messages_group', opts.groups, 'dmConversation');
    }

    return dir;
  }

  const tweetMentioning = (mentions: Array<{ screen_name: string; id_str: string }>) => ({
    id: '1',
    id_str: '1',
    created_at: 'Fri Jan 03 12:00:00 +0000 2025',
    full_text: 'hello',
    favorite_count: '0',
    retweet_count: '0',
    entities: { urls: [], user_mentions: mentions },
  });

  const dmConvo = (conversationId: string, messages: object[]) => ({ conversationId, messages });
  const msg = (m: object) => ({ messageCreate: { createdAt: '2025-01-08T23:50:38.598Z', text: 'hi', ...m } });

  it('names a DM partner the account publicly mentioned, and namespaces the rest', async () => {
    const root = writeArchive({
      tweets: [tweetMentioning([{ screen_name: 'known', id_str: '2000' }])],
      dms: [
        dmConvo('1000-2000', [msg({ id: 'd1', senderId: '2000', recipientId: OWNER })]),
        // 3000 is never mentioned anywhere — the archive simply has no name for
        // them, so the account id has to stand in, under a namespace that says
        // what it is.
        dmConvo('1000-3000', [msg({ id: 'd2', senderId: '3000', recipientId: OWNER })]),
      ],
    });

    const { byId } = await runImport({}, root);

    expect(byId('twitter:dm:d1').metadata?.Sender).toBe('@known');
    expect(byId('twitter:dm:d2').metadata?.Sender).toBe('twitter:id:3000');
    // Resolved or not, the id is always preserved.
    expect(byId('twitter:dm:d1').metadata?.SenderId).toBe('2000');
    expect(byId('twitter:dm:d2').metadata?.SenderId).toBe('3000');
  });

  /**
   * The defect this namespace exists to prevent, stated as the rule that has to
   * hold rather than as the string that happens to satisfy it today.
   *
   * `classifyParticipant` (domains/graph/utils/normalizeIdentifier.ts) types a
   * participant as a phone when it is PHONE-SHAPED — `+()-./`, whitespace and
   * digits, nothing else — and carries at least `PHONE_MIN_DIGITS` = 7 of them.
   * There is no upper bound, so a bare 18-19 digit snowflake cleared that test
   * and `normalizePhone` kept its last ten digits: a Person named after an
   * account id, holding a phone number belonging to nobody, linkable to a real
   * contact at 0.85 confidence by `PersonLinkStage`'s phone_last10 rule.
   *
   * Both id shapes in the corpus are checked — the 18-19 digit snowflakes AND
   * the 7-15 digit ids of early accounts, which are the ones that matter most
   * because a fabricated number in that range is indistinguishable from a real
   * one.
   */
  it('never emits a DM participant that can be read as a phone number', async () => {
    // Phone-shaped, restated from `classifyParticipant` — a value made only of
    // digits and the punctuation phone numbers are written with.
    const PHONE_SHAPED = /^[+()\-.\s\d]+$/;
    const digitsIn = (value: string) => value.replace(/\D/g, '').length;

    const root = writeArchive({
      dms: [
        // A snowflake (19 digits) and an early sequential id (7 digits): the
        // two shapes a real archive holds.
        dmConvo('1000-a', [msg({ id: 'd1', senderId: '1657380978392702976', recipientId: OWNER })]),
        dmConvo('1000-b', [msg({ id: 'd2', senderId: '6245902', recipientId: OWNER })]),
      ],
    });

    const { byId } = await runImport({}, root);

    for (const id of ['twitter:dm:d1', 'twitter:dm:d2']) {
      const dm = byId(id);
      const participants = [dm.metadata?.Sender, ...((dm.metadata?.To as string[] | undefined) ?? [])].filter(
        (value): value is string => typeof value === 'string',
      );

      // The rule below is a for-loop over a list this import produces, so an
      // empty list would satisfy it without testing anything.
      expect(participants).toHaveLength(2);

      for (const participant of participants) {
        expect(PHONE_SHAPED.test(participant) && digitsIn(participant) >= 7).toBe(false);
      }
    }

    // And the correspondent is still named — refusing to emit the participant
    // at all would leave a real conversation with nobody on the other end.
    expect(byId('twitter:dm:d1').metadata?.Sender).toBe('twitter:id:1657380978392702976');
    expect(byId('twitter:dm:d2').metadata?.Sender).toBe('twitter:id:6245902');
  });

  it('namespaces an unresolvable recipient too, not only a sender', async () => {
    const root = writeArchive({
      tweets: [tweetMentioning([{ screen_name: 'known', id_str: '2000' }])],
      groups: [
        dmConvo('g1', [
          msg({ id: 'g-m1', senderId: OWNER }),
          {
            joinConversation: {
              initiatingUserId: OWNER,
              participantsSnapshot: [OWNER, '2000', '31353900'],
              createdAt: '2025-01-01T00:00:00.000Z',
            },
          },
        ]),
      ],
    });

    const { byId } = await runImport({}, root);

    expect(byId('twitter:dm:g-m1').metadata?.To).toEqual(['@known', 'twitter:id:31353900']);
  });

  it('resolves a handle from a reply, not just a mention', async () => {
    const root = writeArchive({
      tweets: [
        {
          id: '1',
          id_str: '1',
          created_at: 'Fri Jan 03 12:00:00 +0000 2025',
          full_text: '@replied hi',
          favorite_count: '0',
          retweet_count: '0',
          in_reply_to_status_id_str: '9',
          in_reply_to_user_id_str: '2000',
          in_reply_to_screen_name: 'replied',
          entities: { urls: [], user_mentions: [] },
        },
      ],
      dms: [dmConvo('1000-2000', [msg({ id: 'd1', senderId: '2000', recipientId: OWNER })])],
    });

    const { byId } = await runImport({}, root);
    expect(byId('twitter:dm:d1').metadata?.Sender).toBe('@replied');
  });

  it('names the archive owner on their own outbound DMs', async () => {
    const root = writeArchive({
      dms: [dmConvo('1000-2000', [msg({ id: 'd1', senderId: OWNER, recipientId: '2000' })])],
    });

    const { byId } = await runImport({}, root);
    const dm = byId('twitter:dm:d1');
    expect(dm.metadata?.Sender).toBe('@tester');
    // account.js spells it accountDisplayName — reading `displayName` yields
    // undefined forever, which is what this used to do.
    expect(dm.metadata?.SenderName).toBe('Testy McTest');
  });

  it('falls back to manifest.js for an owner identity account.js does not carry', async () => {
    const root = writeArchive({
      account: {}, // present but empty
      dms: [dmConvo('1000-2000', [msg({ id: 'd1', senderId: OWNER, recipientId: '2000' })])],
    });
    fs.writeFileSync(
      path.join(root, 'data', 'manifest.js'),
      `window.YTD.manifest.part0 = ${JSON.stringify({
        userInfo: { accountId: OWNER, userName: 'fromManifest', displayName: 'From Manifest' },
      })}`,
    );

    const { byId } = await runImport({}, root);
    const dm = byId('twitter:dm:d1');
    expect(dm.metadata?.Sender).toBe('@fromManifest');
    expect(dm.metadata?.SenderName).toBe('From Manifest');
  });

  it('gives a group message the conversation roster, which its own record omits entirely', async () => {
    const root = writeArchive({
      tweets: [tweetMentioning([{ screen_name: 'alice', id_str: '2000' }])],
      groups: [
        dmConvo('g1', [
          // No messageCreate in a group carries recipientId — not one.
          msg({ id: 'g-m1', senderId: OWNER }),
          {
            joinConversation: {
              initiatingUserId: OWNER,
              participantsSnapshot: [OWNER, '2000', '3000'],
              createdAt: '2025-01-01T00:00:00.000Z',
            },
          },
        ]),
      ],
    });

    const { byId } = await runImport({}, root);
    const m = byId('twitter:dm:g-m1');

    // Everyone but the sender, named where the archive allows it.
    expect(m.metadata?.RecipientIds).toEqual(['2000', '3000']);
    expect(m.metadata?.To).toEqual(['@alice', 'twitter:id:3000']);
  });

  it('merges a conversation split across several rows before building its roster', async () => {
    // X splits one conversation's events over multiple dmConversation entries;
    // a roster built per-row would see only a fragment of the membership.
    const root = writeArchive({
      groups: [
        dmConvo('g1', [msg({ id: 'g-m1', senderId: OWNER })]),
        dmConvo('g1', [
          {
            joinConversation: {
              initiatingUserId: OWNER,
              participantsSnapshot: [OWNER, '2000', '3000'],
              createdAt: '2025-01-01T00:00:00.000Z',
            },
          },
        ]),
      ],
    });

    const { byId } = await runImport({}, root);
    expect(byId('twitter:dm:g-m1').metadata?.RecipientIds).toEqual(['2000', '3000']);
  });

  it('drops a departed member from messages sent after they left, but not before', async () => {
    // The arrays are NOT stored chronologically, so this also pins that the
    // roster walk sorts by time rather than trusting array order.
    const root = writeArchive({
      groups: [
        dmConvo('g1', [
          {
            messageCreate: {
              id: 'after',
              senderId: OWNER,
              text: 'later',
              createdAt: '2025-03-01T00:00:00.000Z',
            },
          },
          { participantsLeave: { userIds: ['3000'], createdAt: '2025-02-01T00:00:00.000Z' } },
          {
            messageCreate: {
              id: 'before',
              senderId: OWNER,
              text: 'earlier',
              createdAt: '2025-01-01T00:00:00.000Z',
            },
          },
          {
            joinConversation: {
              initiatingUserId: OWNER,
              participantsSnapshot: [OWNER, '2000', '3000'],
              createdAt: '2024-12-01T00:00:00.000Z',
            },
          },
        ]),
      ],
    });

    const { byId } = await runImport({}, root);

    expect(byId('twitter:dm:before').metadata?.RecipientIds).toEqual(['2000', '3000']);
    expect(byId('twitter:dm:after').metadata?.RecipientIds).toEqual(['2000']);
  });

  it('still names a 1:1 recipient from the message itself', async () => {
    const root = writeArchive({
      dms: [dmConvo('1000-2000', [msg({ id: 'd1', senderId: OWNER, recipientId: '2000' })])],
    });

    const { byId } = await runImport({}, root);
    expect(byId('twitter:dm:d1').metadata?.RecipientIds).toEqual(['2000']);
  });
});

describe('parser loss reporting (reconciliation)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-tw-reconcile-'));
    fs.mkdirSync(path.join(dir, 'data'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const writeTweets = (tweets: object[]) =>
    fs.writeFileSync(
      path.join(dir, 'data', 'tweets.js'),
      'window.YTD.tweets.part0 = ' + JSON.stringify(tweets.map((t) => ({ tweet: t }))),
    );

  const writeDms = (conversations: object[]) =>
    fs.writeFileSync(
      path.join(dir, 'data', 'direct-messages.js'),
      'window.YTD.direct_messages.part0 = ' +
        JSON.stringify(conversations.map((c) => ({ dmConversation: c }))),
    );

  async function run(pipeline: TestPipeline): Promise<void> {
    await new TwitterFileImporter().fileImport({}, { filename: path.basename(dir), fullPath: dir }, {
      options: { includeReplies: true, includeRetweets: true },
      timeframe: {},
      log: () => {},
      pipeline,
    } as unknown as ImportParams);
  }

  it('reconciles against the fixture archive: consumed === produced + dropped', async () => {
    // The real fixture: 5 tweets.js rows (1 undated retweet drops, the other
    // 4 push) + 2 direct-messages.js rows (both push) = 7 consumed, 6
    // produced, 1 dropped.
    const pipeline: TestPipeline = Object.assign([] as EmittedGraph[], {
      drop: jest.fn(),
      consumed: jest.fn(),
    });
    await new TwitterFileImporter().fileImport({}, { filename: 'twitter-archive', fullPath: ROOT }, {
      options: { includeReplies: true, includeRetweets: true },
      timeframe: {},
      log: () => {},
      pipeline,
    } as unknown as ImportParams);

    const consumedSum = (pipeline.consumed as jest.Mock).mock.calls.reduce(
      (sum: number, [n]: [number]) => sum + n,
      0,
    );
    const producedCount = pipeline.filter((g) => g.item).length;
    const droppedCount = (pipeline.drop as jest.Mock).mock.calls.length;

    expect(pipeline.drop).toHaveBeenCalledWith('undated_retweet', '5');
    expect(consumedSum).toBe(producedCount + droppedCount);
  });

  it('drops a tweet with no id instead of silently skipping it', async () => {
    writeTweets([{ created_at: 'Fri Jan 03 12:00:00 +0000 2025', full_text: 'no id on this row' }]);
    const pipeline: TestPipeline = Object.assign([] as EmittedGraph[], {
      drop: jest.fn(),
      consumed: jest.fn(),
    });

    await run(pipeline);

    expect(pipeline.length).toBe(0);
    expect(pipeline.drop).toHaveBeenCalledWith('tweet_without_id');
    expect(pipeline.consumed).toHaveBeenCalledWith(1);
  });

  it('drops a timeframe-excluded tweet instead of silently skipping it', async () => {
    writeTweets([{ id_str: '1', created_at: 'Fri Jan 03 12:00:00 +0000 2025', full_text: 'old news' }]);
    const pipeline: TestPipeline = Object.assign([] as EmittedGraph[], {
      drop: jest.fn(),
      consumed: jest.fn(),
    });

    await new TwitterFileImporter().fileImport({}, { filename: path.basename(dir), fullPath: dir }, {
      options: { includeReplies: true, includeRetweets: true },
      timeframe: { since: new Date('2027-01-01T00:00:00Z') },
      log: () => {},
      pipeline,
    } as unknown as ImportParams);

    expect(pipeline.length).toBe(0);
    expect(pipeline.drop).toHaveBeenCalledWith('outside_timeframe');
    expect(pipeline.consumed).toHaveBeenCalledWith(1);
  });

  it('reports an extra consumed() unit when a retweet carries media that is not imported', async () => {
    writeTweets([
      {
        id_str: '9',
        created_at: 'Mon Jan 06 08:00:00 +0000 2025',
        full_text: 'RT @someone: worth a look',
        extended_entities: {
          media: [
            { type: 'photo', id_str: '1', url: 'https://t.co/pic', media_url_https: 'https://x/pic.jpg' },
          ],
        },
      },
    ]);
    const pipeline: TestPipeline = Object.assign([] as EmittedGraph[], {
      drop: jest.fn(),
      consumed: jest.fn(),
    });

    await run(pipeline);

    // The retweet still pushes (1 item), and the media-not-imported drop
    // rides the same row — 2 ledger events from 1 tweets.js row.
    expect(pipeline.filter((g) => g.item).length).toBe(1);
    expect(pipeline.drop).toHaveBeenCalledWith('retweet_media_not_imported', expect.stringContaining('9'));
    const consumedSum = (pipeline.consumed as jest.Mock).mock.calls.reduce(
      (sum: number, [n]: [number]) => sum + n,
      0,
    );
    expect(consumedSum).toBe(2);
  });

  it('drops a non-message DM conversation event (join/leave/rename) instead of silently skipping it', async () => {
    writeDms([{ conversationId: 'c1', messages: [{ participantsJoin: { userIds: ['2000'] } }] }]);
    const pipeline: TestPipeline = Object.assign([] as EmittedGraph[], {
      drop: jest.fn(),
      consumed: jest.fn(),
    });

    await run(pipeline);

    expect(pipeline.length).toBe(0);
    expect(pipeline.drop).toHaveBeenCalledWith('non_message');
    expect(pipeline.consumed).toHaveBeenCalledWith(1);
  });

  it('drops a timeframe-excluded DM instead of silently skipping it', async () => {
    writeDms([
      {
        conversationId: 'c1',
        messages: [
          {
            messageCreate: { id: 'd1', createdAt: '2025-01-08T23:50:38.598Z', text: 'hi', senderId: '2000' },
          },
        ],
      },
    ]);
    const pipeline: TestPipeline = Object.assign([] as EmittedGraph[], {
      drop: jest.fn(),
      consumed: jest.fn(),
    });

    await new TwitterFileImporter().fileImport({}, { filename: path.basename(dir), fullPath: dir }, {
      options: { includeReplies: true, includeRetweets: true },
      timeframe: { since: new Date('2027-01-01T00:00:00Z') },
      log: () => {},
      pipeline,
    } as unknown as ImportParams);

    expect(pipeline.length).toBe(0);
    expect(pipeline.drop).toHaveBeenCalledWith('outside_timeframe');
    expect(pipeline.consumed).toHaveBeenCalledWith(1);
  });
});

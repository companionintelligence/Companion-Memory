import fs from 'fs';
import os from 'os';
import path from 'path';

import { InstagramFileImporter } from '../instagram';
import type { ImportParams } from '../timeline';

import { metaText } from './support/emitted';
import type { EmittedGraph, TestPipeline } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

describe('Instagram datasource', () => {
  it('recognizes directory with your_instagram_activity folder', async () => {
    const root = path.join(FIXTURES_DIR, 'instagram-export');
    const fi = new InstagramFileImporter();
    const rec = await fi.recognize({}, { filename: 'instagram-export', fullPath: root });
    expect(rec.confidence).toBeGreaterThan(0.9);
  });

  it('imports messages and posts', async () => {
    const root = path.join(FIXTURES_DIR, 'instagram-export');
    const fi = new InstagramFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'instagram-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    // 3 messages + 2 posts
    expect(pipeline.length).toBe(5);
  });

  it('imports messages with correct classification', async () => {
    const root = path.join(FIXTURES_DIR, 'instagram-export');
    const fi = new InstagramFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'instagram-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const messages = pipeline.filter((p) => p.item.classification === 'message');
    expect(messages.length).toBe(3);
    expect(messages[0].item.metadata.Sender).toBe('alice');
    expect(messages[0].item.metadata.Source).toBe('Instagram');
    expect(messages[0].item.timestamp).toBeDefined();
    // Participants + direction: roster is [alice, testuser], thread titled 'alice'
    // so owner = testuser. Inbound msg from alice -> To=testuser, From Me=false.
    expect(messages[0].item.metadata.To).toBe('testuser');
    expect(messages[0].item.metadata['From Me']).toBe(false);
    // Outbound msg from testuser (owner) -> To=alice, From Me=true.
    const mine = messages.find((m) => m.item.metadata.Sender === 'testuser');
    expect(mine!.item.metadata.To).toBe('alice');
    expect(mine!.item.metadata['From Me']).toBe(true);
  });

  it('imports posts with correct classification', async () => {
    const root = path.join(FIXTURES_DIR, 'instagram-export');
    const fi = new InstagramFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'instagram-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const posts = pipeline.filter((p) => p.item.classification === 'social');
    expect(posts.length).toBe(2);
    expect(posts[0].item.metadata.Source).toBe('Instagram');
    // Caption rides under title- and body-bearing keys so titleFor/descriptionFor
    // resolve the caption instead of falling back to basename('post.txt').
    expect(posts[0].item.metadata.Title).toBe('Beautiful sunset at the beach 🌅');
    expect(posts[0].item.metadata.Text).toBe('Beautiful sunset at the beach 🌅');
    expect(posts[0].item.metadata.Title).not.toBe('post.txt');
  });
});

describe('Instagram datasource — Meta HTML format', () => {
  const root = path.join(FIXTURES_DIR, 'instagram-html-export');

  async function runImport() {
    const fi = new InstagramFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'instagram-html-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    return pipeline;
  }

  it('recognizes the HTML export (your_instagram_activity present)', async () => {
    const fi = new InstagramFileImporter();
    const rec = await fi.recognize({}, { filename: 'instagram-html-export', fullPath: root });
    expect(rec.confidence).toBeGreaterThan(0.9);
  });

  it('imports DMs from message_*.html with sender, conversation and timestamp', async () => {
    const pipeline = await runImport();
    const messages = pipeline.filter((p) => p.item.classification === 'message');
    expect(messages.length).toBe(2);

    const alice = messages.find((m) => m.item.metadata.Sender === 'Alice Example');
    expect(alice).toBeDefined();
    expect(alice!.item.metadata.Conversation).toBe('Alice Example');
    expect(alice!.item.metadata.Source).toBe('Instagram');
    expect(alice!.item.timestamp).toBeInstanceOf(Date);
    const text = (await alice!.item.content.data!()).toString();
    // Entity decoded; sender line dropped from body.
    expect(text).toContain('Hey there & welcome!');
    expect(text).not.toContain('Alice Example');

    // Best-effort recipient: a message from someone other than the conversation
    // title (Bob) gets To=<conversation>; the title's own message leaves To unset.
    const bob = messages.find((m) => m.item.metadata.Sender === 'Bob');
    expect(bob!.item.metadata.To).toBe('Alice Example');
    expect(alice!.item.metadata.To).toBeUndefined();
  });

  it('imports likes from liked_posts.html as classification "like"', async () => {
    const pipeline = await runImport();
    const likes = pipeline.filter((p) => p.item.classification === 'like');
    expect(likes.length).toBe(2);
    expect(likes[0].item.metadata.Source).toBe('Instagram');
    expect(likes[0].item.timestamp).toBeInstanceOf(Date);
    const text = (await likes[0].item.content!.data!()).toString();
    expect(text).toContain('A great post about AI & privacy');
  });

  it('titles every activity entry with its human label, not the raw export filename', () => {
    // Every entry from processHtmlActivity used to have no Title at all, so the
    // canonical mapper fell back to content.filename — "liked_posts.html",
    // "stories_viewed.html" — verbatim, on the timeline, repeated once per
    // entry. Verified on a real import: all 39 Instagram events, every one.
    return runImport().then((pipeline) => {
      const likes = pipeline.filter((p) => p.item.classification === 'like');

      expect(likes[0].item.metadata.Title).toMatch(/^Instagram like\b/);
      expect(likes[0].item.metadata.Title).not.toMatch(/\.html$/);
      // The entry's own detail (caption/URL) still rides along, now as
      // Description rather than being the only place it appeared.
      expect(likes[0].item.metadata.Description).toContain('A great post about AI & privacy');
    });
  });

  it('imports saved items as classification "interaction"', async () => {
    const pipeline = await runImport();
    const saved = pipeline.filter(
      (p) => p.item.classification === 'interaction' && p.item.metadata.Type === 'Instagram saved',
    );
    expect(saved.length).toBe(1);
    expect(saved[0].item.timestamp).toBeInstanceOf(Date);
  });

  it('imports followers and following from connections/followers_and_following as classification "interaction"', async () => {
    const pipeline = await runImport();

    const followers = pipeline.filter((p) => p.item.metadata.Type === 'Instagram follower');
    expect(followers.length).toBe(2);
    for (const f of followers) {
      expect(f.item.classification).toBe('interaction');
      expect(f.item.metadata.Source).toBe('Instagram');
      expect(f.item.timestamp).toBeInstanceOf(Date);
    }

    const followerNames = await Promise.all(
      followers.map((f) => f.item.content!.data!().then((b: Buffer) => b.toString())),
    );
    expect(followerNames.some((t: string) => t.includes('johndoe'))).toBe(true);
    expect(followerNames.some((t: string) => t.includes('jane_smith'))).toBe(true);

    const following = pipeline.filter((p) => p.item.metadata.Type === 'Instagram following');
    expect(following.length).toBe(1);
    expect(following[0].item.classification).toBe('interaction');
    const followingText = (await following[0].item.content!.data!()).toString();
    expect(followingText).toContain('cool_traveler');
  });

  it('produces items with no errors and skips empty entries', async () => {
    const pipeline = await runImport();
    // 2 messages + 2 likes + 1 saved + 2 followers + 1 following
    expect(pipeline.length).toBe(8);
    for (const g of pipeline) {
      const body = (await g.item.content!.data!()).toString();
      expect(body.length).toBeGreaterThan(0);
    }
  });

  it('respects the timeframe filter', async () => {
    const fi = new InstagramFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'instagram-html-export', fullPath: root }, {
      pipeline,
      timeframe: { since: new Date('2026-01-01T00:00:00Z') },
      log: () => {},
    } as unknown as ImportParams);
    // Only 2026 entries survive: 2 messages (May 25 + May 24 2026) + 1 like (May 04 2026)
    // + 1 follower (May 04 2026) + 1 following (Jun 21 2026).
    // The Dec 2025 like, Dec 2025 follower, and Jun 2025 saved item are filtered out.
    for (const g of pipeline) {
      expect(g.item.timestamp!.getTime()).toBeGreaterThanOrEqual(new Date('2026-01-01T00:00:00Z').getTime());
    }

    expect(pipeline.length).toBe(5);
  });
});

describe('Instagram datasource — same-minute dedup-collapse regression', () => {
  // Two DMs and two likes share the same clock minute + constant filename. With no
  // item.id, hashItem (persistence.ts) collapses them to one row each and silently
  // drops the duplicate. Each push must carry a stable, unique, idempotent id.
  function buildExport(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-dedup-'));
    const act = path.join(dir, 'your_instagram_activity');
    const inbox = path.join(act, 'messages', 'inbox', 'alice_123');
    fs.mkdirSync(inbox, { recursive: true });
    // Two messages stamped the same minute (10:51 am) — minute-precision date div.
    fs.writeFileSync(
      path.join(inbox, 'message_1.html'),
      '<!DOCTYPE html><html><head><title>Alice Example</title></head><body><main role="main">' +
        '<div class="pam"><h2>Alice Example</h2><div><div>First message</div></div>' +
        '<div class="_3-94 _a6-o">May 25, 2026 10:51 am</div></div>' +
        '<div class="pam"><h2>Alice Example</h2><div><div>Second message</div></div>' +
        '<div class="_3-94 _a6-o">May 25, 2026 10:51 am</div></div>' +
        '</main></body></html>',
    );
    // Two likes stamped the same minute (10:01 am) in one constant-filename file.
    const likes = path.join(act, 'likes');
    fs.mkdirSync(likes, { recursive: true });
    fs.writeFileSync(
      path.join(likes, 'liked_posts.html'),
      '<!DOCTYPE html><html><head><title>Liked posts</title></head><body><main role="main">' +
        '<div class="pam"><div>Liked first post</div>' +
        '<div class="_3-94 _a6-o">May 04, 2026 10:01 am</div></div>' +
        '<div class="pam"><div>Liked second post</div>' +
        '<div class="_3-94 _a6-o">May 04, 2026 10:01 am</div></div>' +
        '</main></body></html>',
    );

    return dir;
  }

  async function runImport(root: string): Promise<EmittedGraph[]> {
    const fi = new InstagramFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: path.basename(root), fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    return pipeline;
  }

  it('gives every same-minute entry a unique, stable, idempotent id', async () => {
    const root = buildExport();
    try {
      const first = await runImport(root);
      // 2 messages + 2 likes that all would otherwise collapse.
      expect(first.length).toBe(4);
      const ids = first.map((g) => g.item.id!);
      // (a) every id truthy
      for (const id of ids) {
        expect(id).toBeTruthy();
      }

      // (b) all ids distinct — no collapse
      expect(new Set(ids).size).toBe(first.length);
      // (c) re-import yields identical ids (idempotent)
      const second = await runImport(root);
      expect(second.map((g) => g.item.id!)).toEqual(ids);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

/*
 * Fixtures under fixtures/instagram-html-activity are verbatim entry blocks cut
 * out of a real Instagram DYI export (June 2026), one or two entries per file,
 * with the surrounding <head>/<main> scaffolding kept intact — including the
 * `<base href="../../">` that decides where a media href resolves to. The only
 * edits: saved_posts.html's shortcode was retargeted at liked_posts.html's
 * first post (so one fixture exercises the like+save collapse), and
 * profile_photos.html's second entry points at a jpg that is deliberately NOT
 * in the tree (Meta ships incomplete media trees routinely).
 */
describe('Instagram datasource — HTML activity entry fidelity', () => {
  const root = path.join(FIXTURES_DIR, 'instagram-html-activity');

  async function runImport(): Promise<{ pipeline: EmittedGraph[]; drops: Array<[string, string?]> }> {
    const fi = new InstagramFileImporter();
    const pipeline: EmittedGraph[] = [];
    const drops: Array<[string, string?]> = [];
    (pipeline as TestPipeline).drop = (reason: string, detail?: string) => {
      drops.push([reason, detail]);
    };

    await fi.fileImport({}, { filename: 'instagram-html-activity', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    return { pipeline, drops };
  }

  function byId(pipeline: EmittedGraph[], id: string): EmittedGraph | undefined {
    return pipeline.find((g) => g.item.id === id);
  }

  // ---- F25: the permalink is the entry's only identity, and it was dropped ----

  it('maps the per-entry permalink onto metadata.URL, so the content row stops landing blank', async () => {
    const { pipeline } = await runImport();
    const like = byId(pipeline, 'instagram:liked_posts.html#0');

    expect(like).toBeDefined();
    // push/inputs.ts toContentInput reads metadata.URL into content.url. Before
    // this, `like` / `post` / `social_bookmark` rows reached ci.content with a
    // blank text AND a blank url — 2,010 of them — because stripTags cannot see
    // an href attribute.
    expect(like!.item.metadata.URL).toBe('https://www.instagram.com/p/DX7KXtTionR/');
    expect(like!.item.metadata.PostId).toBe('DX7KXtTionR');
  });

  it('keys a post-bearing entry on the post URI so a like and a save of the same post collapse', async () => {
    const { pipeline } = await runImport();
    const like = byId(pipeline, 'instagram:liked_posts.html#0');
    const saved = byId(pipeline, 'instagram:saved_posts.html#0');

    // metadata.URI REPLACES the content row's source_id (toContentInput), and
    // ci.content dedups on the provenance triple — so one content row, not two.
    expect(like!.item.metadata.URI).toBe('instagram:p:DX7KXtTionR');
    expect(saved!.item.metadata.URI).toBe('instagram:p:DX7KXtTionR');
    // The EVENTS stay distinct: liking and saving are two occurrences.
    expect(like!.item.id).not.toBe(saved!.item.id);
  });

  it('does not give a saved COLLECTION the identity of the first post inside it', async () => {
    const { pipeline } = await runImport();
    const collection = byId(pipeline, 'instagram:saved_collections.html#0');

    expect(collection).toBeDefined();
    // The collection links to several posts; adopting the first one's shortcode
    // as its URI would merge the collection row onto that post's content row.
    expect(collection!.item.metadata.URI).toBeUndefined();
    // ...and it is named after itself, not after a post it contains.
    expect(collection!.item.metadata.Title).toBe('Instagram saved collection — Sales');
  });

  it('lifts the post owner into Author/Handle', async () => {
    const { pipeline } = await runImport();
    const like = byId(pipeline, 'instagram:liked_posts.html#0');

    expect(like!.item.metadata.Author).toBe('Companion Intelligence');
    expect(like!.item.metadata.Handle).toBe('companionintelligence');
  });

  it('de-duplicates the Caption row Meta emits twice per post', async () => {
    const { pipeline } = await runImport();
    const like = byId(pipeline, 'instagram:liked_posts.html#0');
    const description = metaText(like!.item.metadata.Description);
    const caption = metaText(like!.item.metadata.Caption);

    expect(caption).toContain('Everyone’s using AI. Almost no one trusts it.');
    // liked_posts.html carries two adjacent, byte-identical <tr>Caption</tr>
    // rows per entry; the body used to carry the caption (and the label) twice.
    expect(description.split('Almost no one trusts it').length - 1).toBe(1);
    expect(description.split(/\bCaption\b/).length - 1).toBe(1);
  });

  it('titles an entry by what it is about, not by a constant', async () => {
    const { pipeline } = await runImport();
    const titles = pipeline
      .filter((g) => g.item.classification === 'like')
      .map((g) => metaText(g.item.metadata.Title));

    expect(titles).toHaveLength(2);
    for (const t of titles) {
      expect(t.startsWith('Instagram like — ')).toBe(true);
    }

    // Two likes of two different posts must not share a title.
    expect(new Set(titles).size).toBe(2);
  });

  // ---- F24: `if (!text) continue` never fired on non-empty boilerplate ----

  it('drops an entry whose every field is empty or pure bookkeeping', async () => {
    const { pipeline, drops } = await runImport();

    // other_content.html's entries are an EMPTY Media cell plus "Is an
    // advertisement: False" and an "Update time" — non-empty text, zero
    // content, and a distinct `#<i>` id each so they never deduped either.
    expect(pipeline.filter((g) => g.item.id?.startsWith('instagram:other_content.html#'))).toHaveLength(0);
    expect(drops).toContainEqual(['empty_after_parse', 'instagram:other_content.html#0']);
    expect(drops).toContainEqual(['empty_after_parse', 'instagram:other_content.html#1']);
  });

  // ---- F23: a profile photo with no photo behind it ----

  it('emits a profile photo as a real media item pointed at the file on disk', async () => {
    const { pipeline } = await runImport();
    const photo = byId(pipeline, 'instagram:profile_photos.html#0');

    expect(photo).toBeDefined();
    // The href is export-root-relative via <base href="../../">, two levels up
    // from your_instagram_activity/media/ — resolving it against the page's own
    // directory finds nothing.
    expect(photo!.item.intermediateLocation).toBe(path.join(root, 'media', 'other', '17876858054753740.jpg'));
    // Classified off the file's real MIME, so MediaStage uploads the bytes and
    // kindFor sees image/jpeg instead of text/plain.
    expect(photo!.item.content.mediaType).toBe('image/jpeg');
    expect(photo!.item.classification).toBe('media');
    expect((await photo!.item.content.data!()).length).toBeGreaterThan(0);
  });

  it('skips a media entry whose file is not in the export instead of minting a phantom photo', async () => {
    const { pipeline, drops } = await runImport();

    expect(byId(pipeline, 'instagram:profile_photos.html#1')).toBeUndefined();
    expect(drops).toContainEqual(['missing_media', 'instagram:profile_photos.html#1']);
    // Nothing at all reaches the pipeline as a media/photo item without bytes.
    for (const g of pipeline) {
      if (g.item.classification === 'media' || g.item.classification === 'photo') {
        expect(g.item.intermediateLocation).toBeTruthy();
        expect(g.item.content.mediaType).not.toBe('text/plain');
      }
    }
  });

  it('emits every surviving entry exactly once with a stable, unique id', async () => {
    const { pipeline } = await runImport();
    const ids = pipeline.map((g) => g.item.id!);

    // 2 likes + 1 saved post + 1 saved collection + 1 profile photo + 1 repost.
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('Instagram datasource — mojibake repair (emoji/accents)', () => {
  // Instagram DYI JSON comes out of the same Meta exporter as Facebook's, and
  // it escapes every UTF-8 byte of a non-ASCII character as its own \u00XX
  // code point. facebook.ts has repaired that since the day it shipped;
  // instagram.ts parsed the same bytes bare and stored "😊" as "ð\u009f\u0098\u008a".
  it('decodes latin-1-escaped UTF-8 in DM text, sender names, thread titles and captions', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-mojibake-'));
    try {
      const threadDir = path.join(root, 'your_instagram_activity', 'messages', 'inbox', 'jose_111');
      fs.mkdirSync(threadDir, { recursive: true });
      fs.writeFileSync(
        path.join(threadDir, 'message_1.json'),
        `{
          "participants": [{"name": "JosÃ© GarcÃ­a"}, {"name": "testuser"}],
          "messages": [
            {
              "sender_name": "JosÃ© GarcÃ­a",
              "timestamp_ms": 1609459200000,
              "content": "Happy birthday ð\u009f\u0098\u008að\u009f\u008e\u0082"
            }
          ],
          "title": "JosÃ© GarcÃ­a",
          "thread_type": "Regular"
        }`,
      );
      const postsDir = path.join(root, 'your_instagram_activity', 'posts');
      fs.mkdirSync(postsDir, { recursive: true });
      fs.writeFileSync(
        path.join(postsDir, 'post_1.json'),
        `[{"media": [{"uri": "media/posts/202101/photo1.jpg", "creation_timestamp": 1609459200, "title": "CafÃ© ð\u009f\u008e¸"}], "title": "CafÃ© ð\u009f\u008e¸", "creation_timestamp": 1609459200}]`,
      );

      const fi = new InstagramFileImporter();
      const pipeline: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: 'ig', fullPath: root }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);

      const msg = pipeline.find((p) => p.item.classification === 'message');
      expect(msg!.item.metadata.Text).toBe('Happy birthday 😊🎂');
      expect(msg!.item.metadata.Sender).toBe('José García');
      expect(msg!.item.metadata.Conversation).toBe('José García');
      expect(msg!.item.metadata.To).toBe('testuser');

      const post = pipeline.find((p) => p.item.classification !== 'message');
      expect(post!.item.metadata.Caption).toBe('Café 🎸');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves text that is already real Unicode untouched', async () => {
    // The checked-in fixture carries real emoji ("🌅", "☕"); the repair must
    // pass those through, not double-decode them.
    const root = path.join(FIXTURES_DIR, 'instagram-export');
    const fi = new InstagramFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'instagram-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const captions = pipeline
      .filter((p) => p.item.classification !== 'message')
      .map((p) => p.item.metadata.Caption);
    expect(captions).toEqual(['Beautiful sunset at the beach 🌅', 'Morning coffee ☕']);
  });
});

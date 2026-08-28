import fs from 'node:fs';
import os from 'node:os';
import path from 'path';

import { FacebookFileImporter } from '../facebook';
import type { ImportParams } from '../timeline';

import type { EmittedGraph } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

describe('Facebook datasource', () => {
  it('recognizes directory with messages and your_facebook_activity', async () => {
    const root = path.join(FIXTURES_DIR, 'facebook-export');
    const fi = new FacebookFileImporter();
    const rec = await fi.recognize({}, { filename: 'facebook-export', fullPath: root });
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('imports messages and posts', async () => {
    const root = path.join(FIXTURES_DIR, 'facebook-export');
    const fi = new FacebookFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'facebook-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    // 2 messages + 2 posts
    expect(pipeline.length).toBe(4);
  });

  it('imports messages with correct metadata', async () => {
    const root = path.join(FIXTURES_DIR, 'facebook-export');
    const fi = new FacebookFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'facebook-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const messages = pipeline.filter((p) => p.item.classification === 'message');
    expect(messages.length).toBe(2);
    expect(messages[0].item.metadata.Sender).toBe('Alice Smith');
    expect(messages[0].item.metadata.Conversation).toBe('Alice Smith');
    expect(messages[0].item.metadata.Source).toBe('Facebook');
    expect(messages[0].item.timestamp).toBeDefined();
    // Recipient (To) is the thread roster minus the sender, so people-linking
    // resolves both sides. Sender Alice -> To Test User; sender Test User -> To Alice.
    expect(messages[0].item.metadata.To).toBe('Test User');
    expect(messages[1].item.metadata.Sender).toBe('Test User');
    expect(messages[1].item.metadata.To).toBe('Alice Smith');
  });

  it('imports posts with correct metadata', async () => {
    const root = path.join(FIXTURES_DIR, 'facebook-export');
    const fi = new FacebookFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'facebook-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const posts = pipeline.filter((p) => p.item.classification === 'social');
    expect(posts.length).toBe(2);
    expect(posts[0].item.metadata.Text).toContain('new year');
    expect(posts[0].item.metadata.Source).toBe('Facebook');
  });

  it('preserves already-correct Unicode (fixture emoji) untouched', async () => {
    const root = path.join(FIXTURES_DIR, 'facebook-export');
    const fi = new FacebookFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'facebook-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const messages = pipeline.filter((p) => p.item.classification === 'message');
    expect(messages[1].item.metadata.Text).toBe('Happy New Year to you too! 🎉');
  });
});

describe('Facebook datasource — mojibake repair (emoji/accents)', () => {
  it('decodes latin-1-escaped UTF-8 in messages, names, titles, and posts', async () => {
    // Byte-for-byte what real Facebook DYI JSON contains: every UTF-8 byte of a
    // non-ASCII character escaped as its own \u00XX code point.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-mojibake-'));
    try {
      const threadDir = path.join(root, 'messages', 'inbox', 'jose_111');
      fs.mkdirSync(threadDir, { recursive: true });
      fs.writeFileSync(
        path.join(threadDir, 'message_1.json'),
        `{
          "participants": [{"name": "Jos\u00c3\u00a9 Garc\u00c3\u00ada"}, {"name": "Test User"}],
          "messages": [
            {
              "sender_name": "Jos\u00c3\u00a9 Garc\u00c3\u00ada",
              "timestamp_ms": 1609459200000,
              "content": "Happy birthday \u00f0\u009f\u0098\u008a\u00f0\u009f\u008e\u0082"
            }
          ],
          "title": "Caf\u00c3\u00a9 crew"
        }`,
      );
      const postsDir = path.join(root, 'your_facebook_activity', 'posts');
      fs.mkdirSync(postsDir, { recursive: true });
      fs.writeFileSync(
        path.join(postsDir, 'your_posts_1.json'),
        `[{"timestamp": 1609459200, "title": "Great show \u00f0\u009f\u008e\u00b8", "data": [{"post": "Great show \u00f0\u009f\u008e\u00b8"}]}]`,
      );

      const fi = new FacebookFileImporter();
      const pipeline: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: 'fb', fullPath: root }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);

      const msg = pipeline.find((p) => p.item.classification === 'message');
      expect(msg!.item.metadata.Text).toBe('Happy birthday 😊🎂');
      expect(msg!.item.metadata.Sender).toBe('José García');
      expect(msg!.item.metadata.Conversation).toBe('Café crew');
      expect(msg!.item.metadata.To).toBe('Test User');

      const post = pipeline.find((p) => p.item.classification === 'social');
      expect(post!.item.metadata.Text).toBe('Great show 🎸');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Facebook datasource — HTML (Download Your Information) format', () => {
  const root = path.join(FIXTURES_DIR, 'facebook-html-export');

  async function runImport() {
    const fi = new FacebookFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'facebook-html-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    return pipeline;
  }

  it('recognizes the HTML export directory', async () => {
    const fi = new FacebookFileImporter();
    const rec = await fi.recognize({}, { filename: 'facebook-html-export', fullPath: root });
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('parses posts from a Meta HTML page with the entry timestamp and clean text', async () => {
    const pipeline = await runImport();
    const posts = pipeline.filter((p) => p.item.classification === 'social');
    expect(posts.length).toBe(2);

    const first = posts[0];
    // Timestamp comes from the per-entry footer (Jan 01, 2025 12:00:00 am).
    expect(first.item.timestamp).toBeInstanceOf(Date);
    expect(first.item.timestamp!.getTime()).toBe(new Date('Jan 01, 2025 12:00:00 am').getTime());
    // Visible text is extracted and tag/entity-decoded; no markup leaks through.
    const text = (await first.item.content!.data!()).toString();
    expect(text).toContain('Excited to start the new year');
    expect(text).not.toContain('<');
    expect(text).not.toContain('_a6');
    expect(first.item.metadata.Source).toBe('Facebook');
    // Entity decoding: "&amp;" -> "&".
    expect(posts[1].item.metadata.Text).toContain('& it felt great');
  });

  it('parses messages from a Meta HTML thread with sender + thread metadata', async () => {
    const pipeline = await runImport();
    const messages = pipeline.filter((p) => p.item.classification === 'message');
    // Two real messages; the participants-only section (no body text) is skipped.
    expect(messages.length).toBe(2);
    expect(messages[0].item.metadata.Sender).toBe('Alice Smith');
    expect(messages[0].item.metadata.Thread).toBe('alice smith');
    expect(messages[0].item.metadata.Source).toBe('Facebook');
    expect(messages[0].item.timestamp).toBeInstanceOf(Date);
    const text = (await messages[0].item.content!.data!()).toString();
    expect(text).toBe('Happy New Year!');
    // To comes from the "Participants: ..." heading minus the section sender.
    expect(messages[0].item.metadata.To).toBe('Test User');
    expect(messages[1].item.metadata.Sender).toBe('Test User');
    expect(messages[1].item.metadata.To).toBe('Alice Smith');
  });
});

describe('Facebook datasource — dedup id (collapse regression)', () => {
  // Two messages with the IDENTICAL timestamp_ms and constant filename
  // (message_1.json) would collapse under hashItem when no item.id is set.
  function buildExport(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-dedup-'));
    const threadDir = path.join(root, 'messages', 'inbox', 'bob_jones_42');
    fs.mkdirSync(threadDir, { recursive: true });
    fs.writeFileSync(
      path.join(threadDir, 'message_1.json'),
      JSON.stringify({
        participants: [{ name: 'Bob Jones' }, { name: 'Test User' }],
        title: 'Bob Jones',
        messages: [
          { sender_name: 'Bob Jones', timestamp_ms: 1700000000000, content: 'hi' },
          { sender_name: 'Test User', timestamp_ms: 1700000000000, content: 'hi' },
          { sender_name: 'Bob Jones', timestamp_ms: 1700000000000, content: 'hi' },
        ],
      }),
    );

    return root;
  }

  async function runImport(root: string) {
    const fi = new FacebookFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: path.basename(root), fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    return pipeline;
  }

  it('assigns a unique, truthy, idempotent id to every same-ms message', async () => {
    const root = buildExport();
    try {
      const first = await runImport(root);
      expect(first.length).toBe(3);
      const ids = first.map((p) => p.item.id!);
      expect(ids.every((id) => !!id)).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
      // Re-import yields identical ids (deterministic, idempotent).
      const second = await runImport(root);
      expect(second.map((p) => p.item.id!)).toEqual(ids);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('assigns identical ids when the SAME export is re-uploaded to a different staging dir', async () => {
    // The real duplicate bug: each drag-and-drop upload stages under a fresh
    // inbox/_drops/<dropId>/ path. Ids must key off the path RELATIVE to the
    // export root, not the absolute path, or every re-upload duplicates the DB.
    const rootA = buildExport();
    const rootB = buildExport(); // same internal structure, different temp dir
    try {
      const a = await runImport(rootA);
      const b = await runImport(rootB);
      expect(a.length).toBe(3);
      expect(b.map((p) => p.item.id!)).toEqual(a.map((p) => p.item.id!));
      // And the id must not carry the absolute staging path.
      expect(a[0].item.id).not.toContain(rootA);
    } finally {
      fs.rmSync(rootA, { recursive: true, force: true });
      fs.rmSync(rootB, { recursive: true, force: true });
    }
  });
});

describe('Facebook datasource — incremental re-export (content-derived ids)', () => {
  // Meta writes message files NEWEST-FIRST. An incremental re-export prepends
  // new messages, shifting every array index. Under the old rel-path#index id
  // scheme a new message landed on the (rel,#i) id of an OLD row (dedup kept
  // the old row → new message silently lost) while old messages shifted past
  // the previous count re-inserted as duplicates. Content-derived ids must be
  // stable for old messages and fresh for new ones.
  const M1 = { sender_name: 'Alice', timestamp_ms: 1700000001000, content: 'first' };
  const M2 = { sender_name: 'Test User', timestamp_ms: 1700000002000, content: 'second' };
  const M3 = { sender_name: 'Alice', timestamp_ms: 1700000003000, content: 'third (new)' };

  function buildExport(build: (root: string) => void): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-incr-'));
    build(root);

    return root;
  }

  function writeThread(root: string, file: string, messages: unknown[], dirName = 'alice_123') {
    const threadDir = path.join(root, 'messages', 'inbox', dirName);
    fs.mkdirSync(threadDir, { recursive: true });
    fs.writeFileSync(
      path.join(threadDir, file),
      JSON.stringify({
        participants: [{ name: 'Alice' }, { name: 'Test User' }],
        title: 'Alice',
        messages,
      }),
    );
  }

  function writePosts(root: string, posts: unknown[]) {
    const postsDir = path.join(root, 'your_facebook_activity', 'posts');
    fs.mkdirSync(postsDir, { recursive: true });
    fs.writeFileSync(path.join(postsDir, 'your_posts_1.json'), JSON.stringify(posts));
  }

  async function runImport(root: string) {
    const fi = new FacebookFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: path.basename(root), fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    return pipeline.map((p) => p.item);
  }

  it('keeps old message ids stable and gives a prepended new message a fresh id', async () => {
    // Export A: [M2, M1] (newest-first). Export B: same thread, M3 prepended.
    const a = buildExport((r) => writeThread(r, 'message_1.json', [M2, M1]));
    const b = buildExport((r) => writeThread(r, 'message_1.json', [M3, M2, M1]));
    try {
      const idsA = new Map((await runImport(a)).map((i) => [i.metadata.Text, i.id]));
      const idsB = new Map((await runImport(b)).map((i) => [i.metadata.Text, i.id]));
      expect(idsA.size).toBe(2);
      expect(idsB.size).toBe(3);
      // Old messages keep their exact ids despite every index shifting by one.
      expect(idsB.get('first')).toBe(idsA.get('first'));
      expect(idsB.get('second')).toBe(idsA.get('second'));
      // The new message gets an id never used before — it will INSERT, not
      // silently dedup-skip against the old row that used to own its index.
      expect([...idsA.values()]).not.toContain(idsB.get('third (new)'));
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });

  it('keeps message ids stable when pagination moves a message to another file', async () => {
    // The re-export re-paginates: M1 falls out of message_1.json into
    // message_2.json. Ids are scoped to the THREAD, not the file, so they hold.
    const a = buildExport((r) => writeThread(r, 'message_1.json', [M2, M1]));
    const b = buildExport((r) => {
      writeThread(r, 'message_1.json', [M3, M2]);
      writeThread(r, 'message_2.json', [M1]);
    });
    try {
      const idsA = new Map((await runImport(a)).map((i) => [i.metadata.Text, i.id]));
      const idsB = new Map((await runImport(b)).map((i) => [i.metadata.Text, i.id]));
      expect(idsB.get('first')).toBe(idsA.get('first'));
      expect(idsB.get('second')).toBe(idsA.get('second'));
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });

  it('keeps message ids stable when the thread dir title changes but its numeric id does not', async () => {
    // Meta names thread dirs "<title>_<threadid>", and the title half tracks
    // the CURRENT chat/contact name. A rename between exports must not re-mint
    // the thread's message ids — only the numeric id may scope them.
    const a = buildExport((r) => writeThread(r, 'message_1.json', [M2, M1]));
    const b = buildExport((r) => writeThread(r, 'message_1.json', [M2, M1], 'alice_renamed_123'));
    try {
      const idsA = (await runImport(a)).map((i) => i.id!);
      const idsB = (await runImport(b)).map((i) => i.id!);
      expect(idsB).toEqual(idsA);
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });

  it('does not collide identical texts across different threads', async () => {
    const root = buildExport((r) => {
      writeThread(r, 'message_1.json', [M1]);
      const otherDir = path.join(r, 'messages', 'inbox', 'bob_456');
      fs.mkdirSync(otherDir, { recursive: true });
      fs.writeFileSync(
        path.join(otherDir, 'message_1.json'),
        JSON.stringify({
          participants: [{ name: 'Bob' }, { name: 'Test User' }],
          title: 'Bob',
          messages: [M1], // same sender/ts/text as the alice thread
        }),
      );
    });
    try {
      const ids = (await runImport(root)).map((i) => i.id!);
      expect(ids.length).toBe(2);
      expect(new Set(ids).size).toBe(2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps old post ids stable and gives a prepended new post a fresh id', async () => {
    const P1 = { timestamp: 1700000001, data: [{ post: 'old post one' }] };
    const P2 = { timestamp: 1700000002, data: [{ post: 'old post two' }] };
    const P3 = { timestamp: 1700000003, data: [{ post: 'new post' }] };
    const a = buildExport((r) => writePosts(r, [P2, P1]));
    const b = buildExport((r) => writePosts(r, [P3, P2, P1]));
    try {
      const idsA = new Map((await runImport(a)).map((i) => [i.metadata.Text, i.id]));
      const idsB = new Map((await runImport(b)).map((i) => [i.metadata.Text, i.id]));
      expect(idsB.get('old post one')).toBe(idsA.get('old post one'));
      expect(idsB.get('old post two')).toBe(idsA.get('old post two'));
      expect([...idsA.values()]).not.toContain(idsB.get('new post'));
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });

  it('keeps old HTML message ids stable when a new entry is prepended', async () => {
    function writeHtmlThread(root: string, entries: string[]) {
      const threadDir = path.join(root, 'your_facebook_activity', 'messages', 'inbox', 'alice_123');
      fs.mkdirSync(threadDir, { recursive: true });
      fs.writeFileSync(
        path.join(threadDir, 'message_1.html'),
        '<main><section class="_a6-g"><h2>Participants: Alice, Test User</h2></section>' +
          entries.join('') +
          '</main>',
      );
    }

    const entry = (sender: string, text: string, when: string) =>
      `<section class="_a6-g"><h2>${sender}</h2><div>${text}</div>` +
      `<footer><div class="_a72d">${when}</div></footer></section>`;
    const e1 = entry('Alice', 'hey there', 'Jan 01, 2025 12:00:00 am');
    const e2 = entry('Test User', 'hello back', 'Jan 02, 2025 12:00:00 am');
    const e3 = entry('Alice', 'brand new', 'Jan 03, 2025 12:00:00 am');
    const a = buildExport((r) => writeHtmlThread(r, [e2, e1])); // newest-first
    const b = buildExport((r) => writeHtmlThread(r, [e3, e2, e1]));
    try {
      const idsA = new Map((await runImport(a)).map((i) => [i.metadata.Text, i.id]));
      const idsB = new Map((await runImport(b)).map((i) => [i.metadata.Text, i.id]));
      expect(idsB.get('hey there')).toBe(idsA.get('hey there'));
      expect(idsB.get('hello back')).toBe(idsA.get('hello back'));
      expect([...idsA.values()]).not.toContain(idsB.get('brand new'));
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });
});

describe('Facebook datasource — Messenger & post media', () => {
  // Build a temp export with real media files on disk (attachments are dropped
  // unless the file exists), referenced by uri RELATIVE to the export root.
  function buildMediaExport(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-media-'));
    const threadDir = path.join(root, 'messages', 'inbox', 'carol_9');
    for (const d of ['photos', 'videos', 'gifs', 'audio', 'files']) {
      fs.mkdirSync(path.join(threadDir, d), { recursive: true });
    }

    fs.mkdirSync(path.join(root, 'messages', 'stickers_used'), { recursive: true });
    fs.writeFileSync(path.join(threadDir, 'photos', 'pic.jpg'), 'JPGDATA');
    fs.writeFileSync(path.join(threadDir, 'videos', 'clip.mp4'), 'MP4DATA');
    fs.writeFileSync(path.join(threadDir, 'gifs', 'reaction.gif'), 'GIFDATA');
    fs.writeFileSync(path.join(threadDir, 'audio', 'voice.mp4'), 'AUDIODATA');
    fs.writeFileSync(path.join(threadDir, 'files', 'menu.pdf'), 'PDFDATA');
    fs.writeFileSync(path.join(root, 'messages', 'stickers_used', 'thumbsup.png'), 'PNGDATA');
    fs.writeFileSync(
      path.join(threadDir, 'message_1.json'),
      JSON.stringify({
        participants: [{ name: 'Carol' }, { name: 'Test User' }],
        title: 'Carol',
        messages: [
          {
            sender_name: 'Carol',
            timestamp_ms: 1700000000000,
            content: 'look!',
            photos: [{ uri: 'messages/inbox/carol_9/photos/pic.jpg', creation_timestamp: 1699999999 }],
          },
          // Media-only message (no `content`) — a communication with blank content.
          {
            sender_name: 'Test User',
            timestamp_ms: 1700000001000,
            videos: [{ uri: 'messages/inbox/carol_9/videos/clip.mp4' }],
          },
          // The non-photo/video buckets: gifs and audio/files arrays, plus the
          // `sticker` key, which Meta emits as a single object rather than a list.
          {
            sender_name: 'Carol',
            timestamp_ms: 1700000002000,
            content: 'everything',
            gifs: [{ uri: 'messages/inbox/carol_9/gifs/reaction.gif' }],
            audio_files: [{ uri: 'messages/inbox/carol_9/audio/voice.mp4' }],
            files: [{ uri: 'messages/inbox/carol_9/files/menu.pdf' }],
            sticker: { uri: 'messages/stickers_used/thumbsup.png' },
          },
          // Attachment that isn't on disk (Meta splits media across zips) — the
          // message still imports, minus the dangling reference.
          {
            sender_name: 'Carol',
            timestamp_ms: 1700000003000,
            content: 'missing one',
            photos: [{ uri: 'messages/inbox/carol_9/photos/gone.jpg' }],
          },
        ],
      }),
    );

    const postsDir = path.join(root, 'your_facebook_activity', 'posts');
    fs.mkdirSync(path.join(postsDir, 'media'), { recursive: true });
    fs.writeFileSync(path.join(postsDir, 'media', 'album.png'), 'PNGDATA');
    fs.writeFileSync(
      path.join(postsDir, 'your_posts_1.json'),
      JSON.stringify([
        {
          timestamp: 1700000002,
          data: [{ post: 'my album' }],
          attachments: [
            {
              data: [
                {
                  media: {
                    uri: 'your_facebook_activity/posts/media/album.png',
                    creation_timestamp: 1700000002,
                  },
                },
              ],
            },
          ],
        },
      ]),
    );

    return root;
  }

  async function runImport(root: string) {
    const fi = new FacebookFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: path.basename(root), fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    return pipeline;
  }

  it('attaches message media to the message instead of emitting media items', async () => {
    const root = buildMediaExport();
    try {
      const items = (await runImport(root)).map((p) => p.item);

      // Only the POST attachment is still a standalone media item; message
      // media rides on its message.
      const media = items.filter((i) => i.classification === 'media');
      expect(media.length).toBe(1);
      expect(media[0].id).toBe('facebook:media:your_facebook_activity/posts/media/album.png');

      // Every message becomes a communication — including the media-only one.
      const messages = items.filter((i) => i.classification === 'message');
      expect(messages.length).toBe(4);

      const withPhoto = messages.find((m) => m.metadata.Text === 'look!');
      expect(withPhoto!.metadata.MediaFilePaths).toEqual([
        path.join(root, 'messages/inbox/carol_9/photos/pic.jpg'),
      ]);
      // Opts the record into the upload-AND-link push lane (content rows).
      expect(withPhoto!.metadata.AttachmentContent).toBe(true);

      // Media-only: blank content, no Text, all of it in the attachments.
      const mediaOnly = messages.find((m) => m.metadata.Sender === 'Test User');
      expect(mediaOnly!.metadata.Text).toBeUndefined();
      expect((await mediaOnly!.content.data!()).length).toBe(0);
      expect(mediaOnly!.metadata.MediaFilePaths).toEqual([
        path.join(root, 'messages/inbox/carol_9/videos/clip.mp4'),
      ]);

      // gifs / audio_files / files / sticker all attach, in bucket order.
      const everything = messages.find((m) => m.metadata.Text === 'everything');
      expect(everything!.metadata.MediaFilePaths).toEqual([
        path.join(root, 'messages/inbox/carol_9/gifs/reaction.gif'),
        path.join(root, 'messages/inbox/carol_9/audio/voice.mp4'),
        path.join(root, 'messages/inbox/carol_9/files/menu.pdf'),
        path.join(root, 'messages/stickers_used/thumbsup.png'),
      ]);

      // A reference to bytes that aren't on disk drops out; the message stays.
      const missing = messages.find((m) => m.metadata.Text === 'missing one');
      expect(missing!.metadata.MediaFilePaths).toBeUndefined();
      expect(missing!.metadata.AttachmentContent).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('gives media-only messages stable ids across re-uploads to a new dir', async () => {
    const a = buildMediaExport();
    const b = buildMediaExport();
    try {
      const idOf = async (root: string) => {
        const items = (await runImport(root)).map((p) => p.item);

        return items!.find((i) => i.classification === 'message' && i.metadata.Sender === 'Test User')!.id;
      };

      const idA = await idOf(a);
      // Media-only messages have no text to key on, so the id digests the
      // attachment uris — export-root-relative, hence identical in a new dir.
      expect(await idOf(b)).toBe(idA);
      expect(idA!.includes(a)).toBe(false);
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });

  it('gives media stable ids when the same export is re-uploaded to a new dir', async () => {
    const a = buildMediaExport();
    const b = buildMediaExport();
    try {
      const idsA = (await runImport(a))
        .map((p) => p.item)
        .filter((i) => i.classification === 'media')
        .map((i) => i.id!)
        .sort();
      const idsB = (await runImport(b))
        .map((p) => p.item)
        .filter((i) => i.classification === 'media')
        .map((i) => i.id!)
        .sort();
      expect(idsB).toEqual(idsA);
      // And the id must not embed the absolute staging path.
      expect(idsA.every((id) => !id!.includes(a))).toBe(true);
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });
});

describe('Facebook datasource — HTML media (DYI export)', () => {
  // Meta's HTML export references attachments with <img src>/<a href> pointing at
  // files inside the export. Build a temp HTML export with real media on disk.
  function buildHtmlMediaExport(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-html-media-'));
    const threadDir = path.join(root, 'your_facebook_activity', 'messages', 'inbox', 'dave_7');
    fs.mkdirSync(path.join(threadDir, 'photos'), { recursive: true });
    fs.writeFileSync(path.join(threadDir, 'photos', 'beach.jpg'), 'JPGDATA');
    fs.writeFileSync(path.join(threadDir, 'photos', 'sunset.jpg'), 'JPGDATA');
    const dir = 'your_facebook_activity/messages/inbox/dave_7/photos';
    fs.writeFileSync(
      path.join(threadDir, 'message_1.html'),
      '<main>' +
        '<section class="_a6-g"><h2>Participants: Dave, Test User</h2></section>' +
        '<section class="_a6-g"><h2>Dave</h2><div>at the beach</div>' +
        `<img src="${dir}/beach.jpg">` +
        '<footer><div class="_a72d">Jan 01, 2025 12:00:00 am</div></footer></section>' +
        // A media-only message: no body text, just images. The external (https)
        // image must be ignored — only the local file becomes a media item.
        '<section class="_a6-g"><h2>Test User</h2>' +
        `<img src="https://example.com/ignored.jpg"><img src="${dir}/sunset.jpg">` +
        '<footer><div class="_a72d">Jan 02, 2025 12:00:00 am</div></footer></section>' +
        '</main>',
    );

    return root;
  }

  async function runImport(root: string) {
    const fi = new FacebookFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: path.basename(root), fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    return pipeline;
  }

  it('attaches <img> media to the HTML message and ignores external URLs', async () => {
    const root = buildHtmlMediaExport();
    try {
      const items = (await runImport(root)).map((p) => p.item);
      // Message media is attached, not emitted as standalone media items.
      expect(items.filter((i) => i.classification === 'media').length).toBe(0);

      // Both entries import — the text one and the media-only one.
      const messages = items.filter((i) => i.classification === 'message');
      expect(messages.length).toBe(2);

      const dir = 'your_facebook_activity/messages/inbox/dave_7/photos';
      const beach = messages.find((m) => m.metadata.Text === 'at the beach');
      expect(beach!.metadata.MediaFilePaths).toEqual([path.join(root, dir, 'beach.jpg')]);
      expect(beach!.metadata.AttachmentContent).toBe(true);

      // Media-only entry: blank content, and the external https image is not
      // an attachment — only the local file is.
      const mediaOnly = messages.find((m) => m.metadata.Sender === 'Test User');
      expect(mediaOnly!.metadata.Text).toBeUndefined();
      expect(mediaOnly!.metadata.MediaFilePaths).toEqual([path.join(root, dir, 'sunset.jpg')]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Facebook datasource — HTML body-text noise (UI chrome + reaction badges)', () => {
  // Reproduces contamination found in a real Facebook HTML export: a multi-photo/
  // video post came back with `metadata.Text` equal to
  //   "Photos Photos Photos Photos Click for video: Click for video: Click for
  //   video: 6 Years Ago ... added 4 photos and 3 videos. Jan 14, 2020 5:28:01 pm
  //   Best #CES Ever! ... Updated Jan 14, 2026 7:29:40 am"
  // — the thumbnail links' own boilerplate ("Photos", "Click for video: ") was
  // being scraped as if it were part of the caption. This fixture reproduces
  // that same anchor-boilerplate pattern, plus a reaction-summary <ul> (Meta
  // never renders authored post/message text as an HTML list), alongside a
  // caption that legitimately contains the words "video" and a heart emoji —
  // the fix must not strip those just because they resemble the chrome.
  function buildNoisyPostExport(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-html-noise-'));
    const postsDir = path.join(root, 'your_facebook_activity', 'posts');
    const mediaDir = path.join(postsDir, 'media');
    fs.mkdirSync(path.join(mediaDir, 'photos'), { recursive: true });
    fs.mkdirSync(path.join(mediaDir, 'videos'), { recursive: true });
    fs.writeFileSync(path.join(mediaDir, 'photos', 'pic1.jpg'), 'JPGDATA');
    fs.writeFileSync(path.join(mediaDir, 'photos', 'pic2.jpg'), 'JPGDATA');
    fs.writeFileSync(path.join(mediaDir, 'videos', 'clip.mp4'), 'MP4DATA');

    fs.writeFileSync(
      path.join(postsDir, 'your_posts__check_ins__photos_and_videos_1.html'),
      '<main><section class="_a6-g">' +
        '<h2 class="_2ph_ _a6-h _a6-i">Test User shared 2 photos and 1 video.</h2>' +
        '<div class="_2ph_ _a6-p"><div>' +
        '<div>' +
        '<a href="your_facebook_activity/posts/media/photos/pic1.jpg">Photos</a>' +
        '<a href="your_facebook_activity/posts/media/photos/pic2.jpg">Photos</a>' +
        '<a href="your_facebook_activity/posts/media/videos/clip.mp4">Click for video: </a>' +
        '</div>' +
        "<div>Best #CES Ever! Loved this new video setup, can't wait to share more. ❤️</div>" +
        '</div></div>' +
        '<ul class="_a6-p"><li>❤️ Jane Doe and 11 others reacted</li></ul>' +
        '<footer class="_3-94 _a6-o"><div class="_a72d">Jan 14, 2025 5:28:01 pm</div></footer>' +
        '</section></main>',
    );

    return root;
  }

  async function runImport(root: string) {
    const fi = new FacebookFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: path.basename(root), fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    return pipeline;
  }

  it('drops thumbnail-link boilerplate and reaction badges but keeps the real caption', async () => {
    const root = buildNoisyPostExport();
    try {
      const items = (await runImport(root)).map((p) => p.item);

      const posts = items.filter((i) => i.classification === 'social');
      expect(posts.length).toBe(1);

      const text = posts[0].metadata.Text as string;
      // Only what the person actually wrote survives — including the word
      // "video" and a heart emoji they typed themselves.
      expect(text).toBe("Best #CES Ever! Loved this new video setup, can't wait to share more. ❤️");

      // None of the UI chrome leaked in.
      expect(text).not.toContain('Photos');
      expect(text).not.toContain('Click for video:');
      expect(text).not.toContain('Jane Doe');
      expect(text).not.toContain('reacted');
      expect(text).not.toContain('others');

      // The attachments themselves are untouched — stripping the boilerplate
      // link TEXT must not stop the link's href from being discovered.
      const media = items.filter((i) => i.classification === 'media');
      expect(media.length).toBe(3);
      expect(media.filter((m) => m.metadata.Type === 'Photo').length).toBe(2);
      expect(media.filter((m) => m.metadata.Type === 'Video').length).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Facebook datasource — thread lanes beyond messages/inbox', () => {
  // Meta scatters conversations across sibling lanes under messages/: inbox/,
  // filtered_threads/, message_requests/, archived_threads/ and (for accounts
  // migrated to encrypted Messenger) e2ee_cutover/. Walking inbox/ alone lost
  // whole conversations silently — a real export imported 7 of its 24 messages.
  function htmlThread(sender: string, other: string, text: string): string {
    return [
      '<!DOCTYPE html><html><head><title>Thread</title></head><body><div class="_a705"><main class="_a706" role="main">',
      `<section class="_a6-g"><h2 class="_2ph_ _a6-h">Participants: ${sender}, ${other}</h2></section>`,
      `<section class="_a6-g"><h2 class="_2ph_ _a6-h _a6-i">${sender}</h2>`,
      `<div class="_2ph_ _a6-p"><div><div>${text}</div></div></div>`,
      '<footer class="_3-94 _a6-o"><div class="_a72d">Jan 02, 2025 10:00:00 am</div></footer></section>',
      '</main></div></body></html>',
    ].join('');
  }

  function writeHtmlThread(root: string, lane: string, dirName: string, text: string) {
    const threadDir = path.join(root, 'your_facebook_activity', 'messages', lane, dirName);
    fs.mkdirSync(threadDir, { recursive: true });
    fs.writeFileSync(path.join(threadDir, 'message_1.html'), htmlThread('Alice Smith', 'Test User', text));
  }

  function writeJsonThread(root: string, lane: string, dirName: string, text: string) {
    const threadDir = path.join(root, 'messages', lane, dirName);
    fs.mkdirSync(threadDir, { recursive: true });
    fs.writeFileSync(
      path.join(threadDir, 'message_1.json'),
      JSON.stringify({
        participants: [{ name: 'Alice Smith' }, { name: 'Test User' }],
        title: 'Alice Smith',
        messages: [{ sender_name: 'Alice Smith', timestamp_ms: 1735815600000, content: text }],
      }),
    );
  }

  function buildExport(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-lanes-'));
    // HTML lanes — the shape of the real "Download Your Information" export.
    writeHtmlThread(root, 'inbox', 'group_chat_2031253580255991', 'in the inbox');
    writeHtmlThread(root, 'filtered_threads', 'jeff_and_236_others_6345334045584243', 'in filtered threads');
    writeHtmlThread(root, 'e2ee_cutover', 'ashley_10102016970462065', 'in the e2ee cutover');
    // JSON lanes — same tree, JSON format, under the un-nested messages/ root.
    writeJsonThread(root, 'message_requests', 'stranger_555', 'in message requests');
    writeJsonThread(root, 'archived_threads', 'oldfriend_777', 'in archived threads');
    // Media siblings of the lanes: no <thread>/message_N file, so they must be
    // skipped WITHOUT being named — the enumeration is shape-based, not a list.
    const stickers = path.join(root, 'messages', 'stickers_used', 'pack_1');
    fs.mkdirSync(stickers, { recursive: true });
    fs.writeFileSync(path.join(stickers, 'sticker.png'), 'not a message');
    fs.writeFileSync(path.join(root, 'messages', 'autofill_information.json'), '{}');

    return root;
  }

  async function runImport(root: string) {
    const fi = new FacebookFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: path.basename(root), fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    return pipeline;
  }

  it('imports threads from every lane, not just inbox', async () => {
    const root = buildExport();
    try {
      const messages = (await runImport(root)).filter((p) => p.item.classification === 'message');
      expect(messages.map((m) => m.item.metadata.Text).sort()).toEqual([
        'in archived threads',
        'in filtered threads',
        'in message requests',
        'in the e2ee cutover',
        'in the inbox',
      ]);
      // Ids stay unique per thread (contentId is scoped by the numeric thread id).
      const ids = messages.map((m) => m.item.id!);
      expect(ids.every((id) => !!id)).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('is idempotent across re-imports of the newly reachable lanes', async () => {
    const root = buildExport();
    try {
      const first = (await runImport(root)).map((p) => p.item.id!);
      // All five lanes, or the run is not exercising the newly reachable ones.
      expect(first.length).toBe(5);
      const second = (await runImport(root)).map((p) => p.item.id!);
      expect(second).toEqual(first);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores media siblings of the thread lanes', async () => {
    const root = buildExport();
    try {
      const pipeline = await runImport(root);
      // The five real lanes are in — so the enumeration ran — and
      // stickers_used/pack_1/sticker.png, which holds no message_N file, is
      // not among them.
      expect(pipeline.length).toBe(5);
      expect(pipeline.some((p) => String(p.item.metadata.Text ?? '').includes('not a message'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

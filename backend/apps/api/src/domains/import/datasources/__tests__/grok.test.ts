import fs from 'fs';
import os from 'os';
import path from 'path';

import { GrokFileImporter } from '../grok';
import type { Graph, ImportParams } from '../timeline';
import { TwitterFileImporter } from '../twitter';

import type { EmittedGraph, EmittedItem, TestPipeline } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

describe('Grok datasource', () => {
  it('recognizes export directory by grok_conversations.json', async () => {
    const root = path.join(FIXTURES_DIR, 'grok-export');
    const fi = new GrokFileImporter();
    const rec = await fi.recognize({}, { filename: 'grok-export', fullPath: root });
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('recognizes single grok_conversations.json file directly', async () => {
    const fpath = path.join(FIXTURES_DIR, 'grok-export', 'grok_conversations.json');
    const fi = new GrokFileImporter();
    const rec = await fi.recognize({}, { filename: 'grok_conversations.json', fullPath: fpath });
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('does NOT false-match a ChatGPT conversations.json (mapping object)', async () => {
    const fpath = path.join(FIXTURES_DIR, 'chatgpt-export', 'conversations.json');
    const fi = new GrokFileImporter();
    const rec = await fi.recognize({}, { filename: 'conversations.json', fullPath: fpath });
    expect(rec.confidence).toBe(0);
  });

  it('does NOT false-match a Claude conversations.json (chat_messages array)', async () => {
    const fpath = path.join(FIXTURES_DIR, 'claude-export', 'conversations.json');
    const fi = new GrokFileImporter();
    const rec = await fi.recognize({}, { filename: 'conversations.json', fullPath: fpath });
    expect(rec.confidence).toBe(0);
  });

  it('does NOT claim a directory because some unrelated JSON fits the tolerant shape', async () => {
    // The bug this guards: a real 1.1GB X archive of 6,997 files was recognized
    // as Grok at 0.85, because `findExport` reached a JSON file of the tolerant
    // shape (an array whose first object has a title and a messages array) two
    // levels down, and the not-named-grok branch scored it above twitter's 0.9.
    // The import produced 17 messages out of the whole archive.
    //
    // No xAI export is known to produce that standalone shape at all, so a file
    // that merely fits it is evidence of JSON, not of Grok.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'not-grok-'));
    fs.mkdirSync(path.join(root, 'data'));
    fs.writeFileSync(
      path.join(root, 'data', 'saved-searches.json'),
      JSON.stringify([{ title: 'a saved search', messages: [{ role: 'user', text: 'hello' }] }]),
    );

    const rec = await new GrokFileImporter().recognize({}, { filename: path.basename(root), fullPath: root });

    expect(rec.confidence).toBe(0);
  });

  it('leaves an X archive to the twitter importer, which imports the chats too', async () => {
    // Grok scores an X archive 0.3 ON PURPOSE — low enough that twitter (0.9+)
    // wins a bare drop and imports the WHOLE archive including these chats,
    // non-zero so the Grok card can still be chosen explicitly.
    const root = path.join(FIXTURES_DIR, 'twitter-export');

    if (!fs.existsSync(root)) {
      return;
    }

    const grok = await new GrokFileImporter().recognize({}, { filename: 'twitter-export', fullPath: root });
    const twitter = await new TwitterFileImporter().recognize(
      {},
      { filename: 'twitter-export', fullPath: root },
    );

    expect(twitter.confidence).toBeGreaterThan(grok.confidence);
  });

  it('imports user/assistant messages with role, conversation, and source metadata', async () => {
    const root = path.join(FIXTURES_DIR, 'grok-export');
    const fi = new GrokFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'grok-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    // 5 messages in the fixture, one assistant message has empty content -> 4 emitted.
    expect(pipeline.length).toBe(4);

    // First message: user, string content, "title" field, unix-seconds time.
    const first = pipeline[0].item;
    expect(first.classification).toBe('message');
    expect(first.metadata.Role).toBe('user');
    expect(first.metadata.Direction).toBe('outgoing');
    expect(first.metadata.Conversation).toBe('Planning a road trip');
    expect(first.metadata.Source).toBe('Grok');
    expect(first.timestamp).toBeDefined();
    expect(first.timestamp!.toISOString()).toBe('2024-06-19T12:26:40.000Z');
    expect((await first.content!.data!()).toString()).toContain('road trip out of Austin');

    // Second message: assistant, {parts:[...]} content joined with newlines.
    const second = pipeline[1].item;
    expect(second.metadata.Role).toBe('assistant');
    expect(second.metadata.Direction).toBe('incoming');
    expect((await second.content!.data!()).toString()).toContain('Enchanted Rock');

    // Third message: "name" field + "responses" array, "sender":"HUMAN" -> user.
    const third = pipeline[2].item;
    expect(third.metadata.Role).toBe('user');
    expect(third.metadata.Conversation).toBe('Debugging a Python script');
    expect(third.timestamp!.toISOString()).toBe('2024-06-19T15:00:00.000Z');

    // Fourth message: "sender":"Grok" -> assistant, {text:...} content, unix-ms time.
    const fourth = pipeline[3].item;
    expect(fourth.metadata.Role).toBe('assistant');
    expect((await fourth.content!.data!()).toString()).toContain('default mutable argument');
  });

  it('filters by timeframe', async () => {
    const root = path.join(FIXTURES_DIR, 'grok-export');
    const fi = new GrokFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'grok-export', fullPath: root }, {
      pipeline,
      timeframe: { since: new Date('2024-06-19T14:00:00Z') },
      log: () => {},
    } as unknown as ImportParams);

    // Only the two messages on/after 15:00Z survive the since filter.
    expect(pipeline.length).toBe(2);
    expect(pipeline.every((p) => p.item.metadata.Conversation === 'Debugging a Python script')).toBe(true);
  });

  it('assigns unique, idempotent ids to messages that would otherwise dedup-collapse', async () => {
    // Messages share a constant filename and either no timestamp or the same
    // second — under the old code they all collapse to one content_hash.
    const collapsing = [
      {
        title: 'Same conversation',
        messages: [
          { role: 'user', content: 'first turn' },
          { role: 'assistant', content: 'second turn' },
          { role: 'user', content: 'third turn', create_time: 1718800000 },
          { role: 'assistant', content: 'fourth turn', create_time: 1718800000 },
        ],
      },
    ];
    const fi = new GrokFileImporter();
    const tmpFile = path.join(os.tmpdir(), `grok_collapse_${Date.now()}.json`);
    await fs.promises.writeFile(tmpFile, JSON.stringify(collapsing));
    try {
      const run = async () => {
        const pipeline: EmittedGraph[] = [];
        await fi.fileImport({}, { filename: path.basename(tmpFile), fullPath: tmpFile }, {
          pipeline,
          timeframe: {},
          log: () => {},
        } as unknown as ImportParams);

        return pipeline;
      };

      const pipeline = await run();
      expect(pipeline.length).toBe(4);

      const ids = pipeline.map((p) => p.item.id!);
      // (a) every id truthy, (b) all distinct despite identical filename/timestamp.
      expect(ids.every((id) => !!id)).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);

      // (c) re-import yields identical ids (idempotent).
      const pipeline2 = await run();
      expect(pipeline2.map((p) => p.item.id!)).toEqual(ids);
    } finally {
      await fs.promises.unlink(tmpFile).catch(() => {});
    }
  });

  it('does not throw on empty or malformed input', async () => {
    const fi = new GrokFileImporter();
    const fs = await import('node:fs');

    const emptyFile = path.join(FIXTURES_DIR, 'grok-export', 'grok_empty.json');
    const badFile = path.join(FIXTURES_DIR, 'grok-export', 'grok_bad.json');
    await fs.promises.writeFile(emptyFile, '[]');
    await fs.promises.writeFile(badFile, '{ this is not json');
    try {
      const p1: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: 'grok_empty.json', fullPath: emptyFile }, {
        pipeline: p1,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);
      expect(p1.length).toBe(0);

      const p2: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: 'grok_bad.json', fullPath: badFile }, {
        pipeline: p2,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);
      expect(p2.length).toBe(0);

      // Malformed file is not recognized.
      const rec = await fi.recognize({}, { filename: 'grok_bad.json', fullPath: badFile });
      expect(rec.confidence).toBe(0);
    } finally {
      await fs.promises.unlink(emptyFile).catch(() => {});
      await fs.promises.unlink(badFile).catch(() => {});
    }
  });
});

/*
 * The REAL Grok shape: `data/grok-chat-item.js` inside an X (Twitter) archive.
 * xAI publishes no export of its own, so this is the only format users actually
 * have — the grok*.json path above is a speculative fallback.
 *
 * Both cards read it on purpose: the Twitter card imports the whole archive
 * including these chats, the Grok card imports only the chats out of the same
 * .zip. The tests below pin that split, and the recognition ordering that keeps
 * a bare drop of an X archive from being reduced to Grok messages alone.
 */
describe('Grok chats inside an X archive', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-xgrok-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // A question and its answer share one createdAt to the MILLISECOND in real
  // archives, so array order is the only thing that records turn order.
  const TURN_AT = '2026-01-10T07:48:58.157Z';
  const MEDIA_ID = '2009895241692917761';

  interface XGrokOpts {
    rows?: object[];
    media?: string[];
    tweets?: object[];
  }

  /** An X archive carrying Grok chats, and optionally tweets. */
  function writeXArchive(opts: XGrokOpts = {}): string {
    const data = path.join(dir, 'data');
    fs.mkdirSync(data, { recursive: true });
    // Every real archive carries a manifest, and it is what the twitter importer
    // recognizes on — without it the confidence comparison below is meaningless.
    fs.writeFileSync(
      path.join(data, 'manifest.js'),
      `window.YTD.manifest.part0 = ${JSON.stringify({ archiveInfo: { generationDate: '2026-06-20T05:13:48.343Z' } })}`,
    );
    const rows = opts.rows ?? [
      {
        chatId: 'chat1',
        createdAt: TURN_AT,
        sender: { value: '1', name: 'User', originalName: 'USER' },
        grokMode: { name: 'Normal' },
        message: 'Draw a naked woman',
      },
      {
        chatId: 'chat1',
        createdAt: TURN_AT,
        sender: { value: '2', name: 'Agent', originalName: 'AGENT' },
        grokMode: { name: 'Normal' },
        message: "Unfortunately I can't generate that kind of image.",
        // fileName claims .png; the archive stores .jpg — matching on the
        // recorded name or its extension finds nothing.
        attachments: [
          {
            url: `https://ton.x.com/grok-attachment/${MEDIA_ID}`,
            fileName: `${MEDIA_ID}.png`,
            mimeType: 'image/png',
            moderated: true,
            mediaId: MEDIA_ID,
          },
        ],
      },
      {
        chatId: 'chat2',
        createdAt: '2026-01-11T05:15:00.326Z',
        sender: { name: 'User' },
        message: 'How would I test a webview?',
      },
    ];
    fs.writeFileSync(
      path.join(data, 'grok-chat-item.js'),
      `window.YTD.grok_chat_item.part0 = ${JSON.stringify(rows.map((grokChatItem) => ({ grokChatItem })))}`,
    );
    const mediaDir = path.join(data, 'grok_chat_media');
    fs.mkdirSync(mediaDir, { recursive: true });
    for (const name of opts.media ?? [`${MEDIA_ID}-${MEDIA_ID}.jpg`]) {
      fs.writeFileSync(path.join(mediaDir, name), 'JPEGBYTES');
    }

    if (opts.tweets) {
      fs.writeFileSync(
        path.join(data, 'account.js'),
        `window.YTD.account.part0 = ${JSON.stringify([{ account: { accountId: '1', username: 'tester' } }])}`,
      );
      fs.writeFileSync(
        path.join(data, 'tweets.js'),
        `window.YTD.tweets.part0 = ${JSON.stringify(opts.tweets.map((tweet) => ({ tweet })))}`,
      );
    }

    return dir;
  }

  // Either importer — both read the same archive, which is the point.
  type Importer = { fileImport: GrokFileImporter['fileImport'] };

  async function runImport(fi: Importer, root: string, over: object = {}) {
    const items: EmittedItem[] = [];
    const drops: Array<{ reason: string; detail?: string }> = [];
    await fi.fileImport({}, { filename: path.basename(root), fullPath: root }, {
      timeframe: {},
      log: () => {},
      options: {},
      ...over,
      pipeline: {
        push: (g: Graph) => items.push(g.item as EmittedItem),
        drop: (reason: string, detail: string) => drops.push({ reason, detail }),
      },
    } as unknown as ImportParams);

    return { items, drops };
  }

  it('recognizes an X archive, but BELOW the twitter importer', async () => {
    const root = writeXArchive({ tweets: [] });
    const grok = await new GrokFileImporter().recognize(
      {},
      { filename: path.basename(root), fullPath: root },
    );
    const twitter = await new TwitterFileImporter().recognize(
      {},
      { filename: path.basename(root), fullPath: root },
    );

    // Non-zero so findImportRoots can resolve roots when the user explicitly
    // picks the Grok card...
    expect(grok.confidence).toBeGreaterThan(0);
    // ...but under twitter, because dataSourcesRecognize ranks by confidence and
    // a bare drop of an X archive must import the WHOLE archive, Grok included.
    // Pinned relationally: bumping either number alone can't silently invert it.
    expect(grok.confidence).toBeLessThan(twitter.confidence);
  });

  it('imports only the Grok chats — never tweets — and stamps Source: Grok', async () => {
    const root = writeXArchive({
      tweets: [
        {
          id: '9',
          id_str: '9',
          created_at: 'Sun Jan 05 18:15:00 +0000 2025',
          full_text: 'a tweet',
          favorite_count: '0',
          retweet_count: '0',
          entities: { urls: [], user_mentions: [] },
        },
      ],
    });

    const { items } = await runImport(new GrokFileImporter(), root);

    expect(items.every((i) => i.id!.startsWith('grok:'))).toBe(true);
    expect(items.some((i) => i.id!.startsWith('twitter:'))).toBe(false);
    expect(items.every((i) => i.metadata?.Source === 'Grok')).toBe(true);
  });

  it('threads by chatId and keeps turn order when a question and answer share a timestamp', async () => {
    const root = writeXArchive();

    const { items } = await runImport(new GrokFileImporter(), root);
    const messages = items.filter((i) => i.classification === 'message');

    expect(messages.map((i) => i.metadata.ThreadId)).toEqual(['chat1', 'chat1', 'chat2']);
    // Array order, not timestamp order: both chat1 rows carry the same instant.
    expect(messages[0].timestamp!.toISOString()).toBe(messages[1].timestamp!.toISOString());
    expect(messages.map((i) => i.metadata.Role)).toEqual(['user', 'assistant', 'user']);
    expect(messages.map((i) => i.metadata.From)).toEqual(['You', 'Grok', 'You']);
    expect(messages.map((i) => i.metadata.Direction)).toEqual(['outgoing', 'incoming', 'outgoing']);
    // Position within the chat is part of the id, so the pair cannot collapse.
    expect(messages[0].id!.startsWith('grok:chat1:0:')).toBe(true);
    expect(messages[1].id!.startsWith('grok:chat1:1:')).toBe(true);
    expect(messages[2].id!.startsWith('grok:chat2:0:')).toBe(true);
  });

  it("resolves a generated image by mediaId, despite the recorded filename's extension being wrong", async () => {
    const root = writeXArchive();

    const { items, drops } = await runImport(new GrokFileImporter(), root);
    const media = items.filter((i) => i.classification === 'media');

    expect(media).toHaveLength(1);
    expect(media[0].metadata.Source).toBe('Grok');
    expect(media[0].metadata.Type).toBe('Photo');
    // MIME comes from the file on disk (.jpg), not the .png the archive claims.
    expect(media[0].content.mediaType).toBe('image/jpeg');
    // X's own filter blocked this generation; the flag rides along.
    expect(media[0].metadata.Moderated).toBe(true);
    // ton.x.com is a retired host — it must never become a source address.
    expect(JSON.stringify(media[0].metadata)).not.toContain('ton.x.com');
    expect(drops.filter((d) => d.reason.startsWith('grok_'))).toEqual([]);
  });

  it('reports an attachment whose bytes the archive did not ship', async () => {
    const root = writeXArchive({ media: [] }); // referenced, but no file

    const { items, drops } = await runImport(new GrokFileImporter(), root);

    expect(items.filter((i) => i.classification === 'media')).toHaveLength(0);
    expect(drops).toContainEqual({ reason: 'grok_attachment_missing', detail: MEDIA_ID });
    // The messages still import — a missing image is not a lost conversation.
    expect(items.filter((i) => i.classification === 'message')).toHaveLength(3);
  });

  it('reports a sender it cannot classify instead of guessing a direction', async () => {
    const root = writeXArchive({
      rows: [{ chatId: 'chat1', createdAt: TURN_AT, sender: { name: 'System' }, message: 'a system notice' }],
    });

    const { items, drops } = await runImport(new GrokFileImporter(), root);

    expect(items).toHaveLength(0);
    expect(drops).toContainEqual({ reason: 'grok_unknown_sender', detail: 'chat1 (System)' });
  });

  it('gives the Twitter card the same Grok rows, alongside its own', async () => {
    const root = writeXArchive({
      tweets: [
        {
          id: '9',
          id_str: '9',
          created_at: 'Sun Jan 05 18:15:00 +0000 2025',
          full_text: 'a tweet',
          favorite_count: '0',
          retweet_count: '0',
          entities: { urls: [], user_mentions: [] },
        },
      ],
    });

    const viaGrok = await runImport(new GrokFileImporter(), root);
    const viaTwitter = await runImport(new TwitterFileImporter(), root, {
      options: { includeReplies: true, includeRetweets: true },
    });

    // The Twitter card imports the archive AND the chats.
    expect(viaTwitter.items.some((i) => i.id === 'twitter:tweet:9')).toBe(true);
    const grokFromTwitter = viaTwitter.items.filter((i) => i.id!.startsWith('grok:'));
    // Identical ids from either card, so importing both ways dedupes rather
    // than duplicating every Grok message.
    expect(grokFromTwitter.map((i) => i.id!)).toEqual(viaGrok.items.map((i) => i.id!));
    expect(grokFromTwitter.every((i) => i.metadata?.Source === 'Grok')).toBe(true);
  });

  it('imports nothing extra from an archive with no Grok store at all', async () => {
    const data = path.join(dir, 'data');
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(
      path.join(data, 'account.js'),
      `window.YTD.account.part0 = ${JSON.stringify([{ account: { accountId: '1', username: 'tester' } }])}`,
    );

    const grok = await new GrokFileImporter().recognize({}, { filename: path.basename(dir), fullPath: dir });
    expect(grok.confidence).toBe(0);

    const { items, drops } = await runImport(new TwitterFileImporter(), dir);
    expect(items.filter((i) => i.id!.startsWith('grok:'))).toHaveLength(0);
    expect(drops.filter((d) => d.reason.startsWith('grok_'))).toEqual([]);
  });

  describe('parser loss reporting (reconciliation)', () => {
    async function runWithPipeline(pipeline: TestPipeline, root: string): Promise<void> {
      await new GrokFileImporter().fileImport({}, { filename: path.basename(root), fullPath: root }, {
        timeframe: {},
        log: () => {},
        options: {},
        pipeline,
      } as unknown as ImportParams);
    }

    it('reports every row via consumed(), plus one extra unit for the one attachment', async () => {
      // The default fixture: 3 grok-chat-item.js rows, one of which also
      // carries an attachment reference that resolves successfully (by
      // mediaId, despite its recorded filename not matching — see the
      // "resolves a generated image" test above) — a fourth pushed item.
      const root = writeXArchive();
      const pipeline: TestPipeline = Object.assign([] as EmittedGraph[], {
        drop: jest.fn(),
        consumed: jest.fn(),
      });

      await runWithPipeline(pipeline, root);

      const consumedSum = (pipeline.consumed as jest.Mock).mock.calls.reduce(
        (sum: number, [n]: [number]) => sum + n,
        0,
      );
      const producedCount = pipeline.filter((g) => g.item).length;
      const droppedCount = (pipeline.drop as jest.Mock).mock.calls.length;

      expect(producedCount).toBe(4); // 3 messages + 1 resolved media item
      expect(droppedCount).toBe(0);
      expect(consumedSum).toBe(producedCount + droppedCount);
      // 3 base rows + 1 extra for the one attachment = 4.
      expect(consumedSum).toBe(4);
    });

    it('drops a row with no chatId instead of silently skipping it', async () => {
      const root = writeXArchive({
        rows: [{ createdAt: TURN_AT, sender: { name: 'User' }, message: 'no chatId on this row' }],
      });
      const pipeline: TestPipeline = Object.assign([] as EmittedGraph[], {
        drop: jest.fn(),
        consumed: jest.fn(),
      });

      await runWithPipeline(pipeline, root);

      expect(pipeline.length).toBe(0);
      expect(pipeline.drop).toHaveBeenCalledWith('grok_unknown_conversation');
      expect(pipeline.consumed).toHaveBeenCalledWith(1);
    });

    it('drops a timeframe-excluded row instead of silently skipping it', async () => {
      const root = writeXArchive({
        rows: [{ chatId: 'chat1', createdAt: TURN_AT, sender: { name: 'User' }, message: 'old news' }],
      });
      const pipeline: TestPipeline = Object.assign([] as EmittedGraph[], {
        drop: jest.fn(),
        consumed: jest.fn(),
      });

      await new GrokFileImporter().fileImport({}, { filename: path.basename(root), fullPath: root }, {
        timeframe: { since: new Date('2027-01-01T00:00:00Z') },
        log: () => {},
        options: {},
        pipeline,
      } as unknown as ImportParams);

      expect(pipeline.length).toBe(0);
      expect(pipeline.drop).toHaveBeenCalledWith('outside_timeframe');
      expect(pipeline.consumed).toHaveBeenCalledWith(1);
    });

    it('drops a row with no text and no attachments instead of silently skipping it', async () => {
      const root = writeXArchive({
        rows: [{ chatId: 'chat1', createdAt: TURN_AT, sender: { name: 'User' }, message: '' }],
      });
      const pipeline: TestPipeline = Object.assign([] as EmittedGraph[], {
        drop: jest.fn(),
        consumed: jest.fn(),
      });

      await runWithPipeline(pipeline, root);

      expect(pipeline.length).toBe(0);
      expect(pipeline.drop).toHaveBeenCalledWith('empty_after_parse');
      expect(pipeline.consumed).toHaveBeenCalledWith(1);
    });

    it('does not drop empty_after_parse for a row with no text but a real attachment', async () => {
      // An image-only turn is not an empty record — its attachment fully
      // accounts for the row via its own consumed()/drop() unit.
      const root = writeXArchive({
        rows: [
          {
            chatId: 'chat1',
            createdAt: TURN_AT,
            sender: { name: 'Agent' },
            message: '',
            attachments: [{ url: `https://ton.x.com/grok-attachment/${MEDIA_ID}`, mediaId: MEDIA_ID }],
          },
        ],
      });
      const pipeline: TestPipeline = Object.assign([] as EmittedGraph[], {
        drop: jest.fn(),
        consumed: jest.fn(),
      });

      await runWithPipeline(pipeline, root);

      expect(pipeline.filter((g) => g.item?.classification === 'media')).toHaveLength(1);
      expect(pipeline.drop).not.toHaveBeenCalledWith('empty_after_parse');
      // 1 base row unit + 1 attachment unit = 2, both spent on the media push.
      const consumedSum = (pipeline.consumed as jest.Mock).mock.calls.reduce(
        (sum: number, [n]: [number]) => sum + n,
        0,
      );
      expect(consumedSum).toBe(2);
    });
  });
});

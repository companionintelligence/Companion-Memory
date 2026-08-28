import fs from 'fs';
import os from 'os';
import path from 'path';

import type { Graph, ImportParams } from '../timeline';
import { WhatsAppFileImporter } from '../whatsapp';

import type { EmittedGraph, TestPipeline } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

describe('WhatsApp datasource', () => {
  it('recognizes directory containing _chat.txt', async () => {
    const root = path.join(FIXTURES_DIR, 'whatsapp-export');
    const fi = new WhatsAppFileImporter();
    const rec = await fi.recognize({}, { filename: 'whatsapp-export', fullPath: root });
    expect(rec.confidence).toBeGreaterThan(0.9);
  });

  it('recognizes _chat.txt file directly', async () => {
    const fpath = path.join(FIXTURES_DIR, 'whatsapp-export', '_chat.txt');
    const fi = new WhatsAppFileImporter();
    const rec = await fi.recognize({}, { filename: '_chat.txt', fullPath: fpath });
    expect(rec.confidence).toBeGreaterThan(0.9);
  });

  it('imports messages with correct classification', async () => {
    const root = path.join(FIXTURES_DIR, 'whatsapp-export');
    const fi = new WhatsAppFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'whatsapp-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    expect(pipeline.length).toBe(7);
    expect(pipeline.every((p) => p.item.classification === 'message')).toBe(true);
  });

  it('gives the same message the same id however the archive arrived', async () => {
    // The identity bug: uploading sanitises spaces to underscores while the
    // inbox keeps them, so the SAME export produced two different ids per
    // message and a re-import duplicated the whole chat instead of deduping it.
    const fixture = path.join(FIXTURES_DIR, 'whatsapp-export');
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-arrival-'));

    const idsFrom = async (directoryName: string): Promise<string[]> => {
      const root = path.join(staging, directoryName);
      fs.mkdirSync(root, { recursive: true });
      fs.copyFileSync(path.join(fixture, '_chat.txt'), path.join(root, '_chat.txt'));

      const pipeline: EmittedGraph[] = [];
      await new WhatsAppFileImporter().fileImport({}, { filename: directoryName, fullPath: root }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);

      return pipeline.map((entry) => entry.item.id as string);
    };

    try {
      // Left: how the inbox presents it. Right: how an upload sanitises it.
      const viaInbox = await idsFrom('WhatsApp Chat - LITA _ Companion Tech Team');
      const viaUpload = await idsFrom('WhatsApp_Chat_-_LITA___Companion_Tech_Team');

      expect(viaInbox).toEqual(viaUpload);
      // And the chat is named after the chat, not after the container: the
      // `WhatsApp Chat -` prefix is not part of anybody's conversation name.
      expect(viaInbox[0]).toContain('LITA Companion Tech Team');
      expect(viaInbox[0]).not.toContain('WhatsApp');
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  });

  it('captures sender and message content', async () => {
    const root = path.join(FIXTURES_DIR, 'whatsapp-export');
    const fi = new WhatsAppFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'whatsapp-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const aliceMsg = pipeline.find((p) => p.item.metadata?.Sender === 'Alice');
    expect(aliceMsg).toBeDefined();
    expect(aliceMsg!.item.metadata.Source).toBe('WhatsApp');
    expect(aliceMsg!.item.timestamp).toBeDefined();
  });

  it('filters by timeframe', async () => {
    const fpath = path.join(FIXTURES_DIR, 'whatsapp-export', '_chat.txt');
    const fi = new WhatsAppFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: '_chat.txt', fullPath: fpath }, {
      pipeline,
      timeframe: { since: new Date('2021-01-01T12:00:00Z'), until: new Date('2021-01-02T00:00:00Z') },
      log: () => {},
    } as unknown as ImportParams);

    // Only messages from Jan 1 after midnight UTC should pass
    expect(pipeline.length).toBeLessThan(7);
  });

  it('assigns unique, stable, idempotent ids for same-minute messages', async () => {
    // Android export: HH:MM only (no seconds) — many messages share a clock
    // minute, so the legacy minute-precision timestamp hash collapses them.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-dedup-'));
    fs.writeFileSync(
      path.join(dir, '_chat.txt'),
      '01/01/2021, 08:15 - Alice: first\n' +
        '01/01/2021, 08:15 - Bob: second\n' +
        '01/01/2021, 08:15 - Alice: third\n' +
        '01/01/2021, 08:15 - Bob: fourth\n',
    );

    const run = async () => {
      const fi = new WhatsAppFileImporter();
      const pipeline: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: '_chat.txt', fullPath: path.join(dir, '_chat.txt') }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);

      return pipeline;
    };

    const pipeline = await run();
    expect(pipeline.length).toBe(4);

    const ids = pipeline.map((p) => p.item.id!);
    expect(ids.every((id) => !!id)).toBe(true);
    expect(new Set(ids).size).toBe(pipeline.length);

    // Re-import the same export → identical ids (idempotent).
    const ids2 = (await run()).map((p) => p.item.id!);
    expect(ids2).toEqual(ids);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not merge a header line with no space after the colon into the previous sender', async () => {
    // Real WhatsApp exports emit "[ts] Sender:" with nothing after the colon
    // when the body starts on the next physical line. The old regex required a
    // literal ": " (colon+space), so that header failed to match at all and
    // got appended as a continuation line onto whatever message was still
    // open — silently attributing another sender's text to the wrong person.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-headeronly-'));
    fs.writeFileSync(
      path.join(dir, '_chat.txt'),
      '[1/1/21, 12:00:00 AM] Alice: Hello\n' +
        '[1/1/21, 12:01:00 AM] Bob:\n' +
        "This is Bob's reply\n" +
        '[1/1/21, 12:02:00 AM] Alice: Thanks\n',
    );

    const fi = new WhatsAppFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: '_chat.txt', fullPath: path.join(dir, '_chat.txt') }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    expect(pipeline.length).toBe(3);
    const [first, second, third] = pipeline.map((p) => p.item);
    expect(first.metadata.Sender).toBe('Alice');
    expect(first.metadata.Text).not.toContain('Bob');
    expect(second.metadata.Sender).toBe('Bob');
    expect(second.metadata.Text).toContain("This is Bob's reply");
    expect(third.metadata.Sender).toBe('Alice');
    expect(third.metadata.Text).toBe('Thanks');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('parses a U+200E-prefixed line as its own message, not merged into the previous sender', async () => {
    // Reproduces the real cross-sender-merge bug: WhatsApp's iOS export
    // prefixes many lines (overwhelmingly attachment/omitted-media
    // announcements) with an invisible U+200E LEFT-TO-RIGHT MARK before the
    // leading '['. Unstripped, IOS_RE's literal '[' anchor fails to match,
    // so the line falls through to the continuation-line branch and gets
    // silently appended onto the PREVIOUS (wrong-sender) message.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-invisible-'));
    const LRM = '‎';
    fs.writeFileSync(
      path.join(dir, '_chat.txt'),
      '[1/1/21, 12:00:00 AM] Alice: Hey, check this out\n' +
        `${LRM}[1/1/21, 12:01:00 AM] Bob: <attached: 00000048-PHOTO.jpg>\n`,
    );

    const pushed: EmittedGraph[] = [];
    const fi = new WhatsAppFileImporter();
    await fi.fileImport({}, { filename: '_chat.txt', fullPath: path.join(dir, '_chat.txt') }, {
      pipeline: { push: (g: Graph) => pushed.push(g as EmittedGraph), drop: () => {} },
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const messages = pushed.filter((g) => g.item.classification === 'message');
    expect(messages.length).toBe(2);

    const aliceMsg = messages.find((g) => g.item.metadata.Sender === 'Alice');
    const bobMsg = messages.find((g) => g.item.metadata.Sender === 'Bob');
    expect(aliceMsg).toBeDefined();
    expect(bobMsg).toBeDefined();

    // Before the fix, Bob's U+200E-prefixed line silently became a raw
    // continuation of Alice's message instead of parsing as its own message
    // with the correct sender/timestamp.
    expect(aliceMsg!.item.metadata.Text).toBe('Hey, check this out');
    expect(aliceMsg!.item.metadata.Text).not.toContain('Bob');
    expect(aliceMsg!.item.metadata.Text).not.toContain('attached');
    expect(bobMsg!.item.metadata.Text).toContain('attached: 00000048-PHOTO.jpg');
    expect(bobMsg!.item.timestamp).toBeDefined();
    expect(bobMsg!.item.timestamp?.toISOString()).not.toBe(aliceMsg!.item.timestamp?.toISOString());

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves an iOS "<attached: X>" reference to a real media item', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-media-ios-'));
    fs.writeFileSync(path.join(dir, '00000048-PHOTO-2026-05-08-08-35-29.jpg'), Buffer.from('fake-jpg-bytes'));
    fs.writeFileSync(
      path.join(dir, '_chat.txt'),
      '[5/8/26, 8:35:29 AM] Alice: <attached: 00000048-PHOTO-2026-05-08-08-35-29.jpg>\n',
    );

    const pushed: EmittedGraph[] = [];
    const drops: Array<{ reason: string; detail?: string }> = [];
    const fi = new WhatsAppFileImporter();
    await fi.fileImport({}, { filename: '_chat.txt', fullPath: path.join(dir, '_chat.txt') }, {
      pipeline: {
        push: (g: Graph) => pushed.push(g as EmittedGraph),
        drop: (reason: string, detail?: string) => drops.push({ reason, detail }),
      },
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const mediaGraph = pushed.find((g) => g.item.classification === 'media');
    expect(mediaGraph).toBeDefined();
    expect(mediaGraph!.item.content.filename).toBe('00000048-PHOTO-2026-05-08-08-35-29.jpg');
    expect(mediaGraph!.item.content.mediaType).toBe('image/jpeg');
    expect(mediaGraph!.item.intermediateLocation).toBe(
      path.join(dir, '00000048-PHOTO-2026-05-08-08-35-29.jpg'),
    );
    const bytes: Buffer = await mediaGraph!.item.content.data!();
    expect(bytes.toString()).toBe('fake-jpg-bytes');

    // The text message survives alongside the resolved media item — nothing
    // is replaced, the real bytes are just added.
    expect(pushed.some((g) => g.item.classification === 'message')).toBe(true);
    expect(drops.length).toBe(0);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('links the attached file to the message that carried it', async () => {
    /**
     * The orphan case. WhatsApp's 172 `<attached: …>` lines DID upload — they
     * become standalone media items — but the message that carried each one kept
     * only the placeholder as its body and an empty `attachments` column, so the
     * file and its message were two unlinked rows. The descriptor is what joins
     * them; the media leg resolves both paths onto ONE stored file because they
     * are the same bytes.
     */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-media-link-'));
    const photo = path.join(dir, '00000048-PHOTO-2026-05-08-08-35-29.jpg');
    fs.writeFileSync(photo, Buffer.from('fake-jpg-bytes'));
    fs.writeFileSync(
      path.join(dir, '_chat.txt'),
      '[5/8/26, 8:35:29 AM] Alice: <attached: 00000048-PHOTO-2026-05-08-08-35-29.jpg>\n' +
        '[5/8/26, 8:36:00 AM] Bob: no photo here\n',
    );

    const pushed: EmittedGraph[] = [];
    const fi = new WhatsAppFileImporter();
    await fi.fileImport({}, { filename: '_chat.txt', fullPath: path.join(dir, '_chat.txt') }, {
      pipeline: { push: (g: Graph) => pushed.push(g as EmittedGraph), drop: () => {} },
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const messages = pushed.filter((g) => g.item.classification === 'message');
    const withPhoto = messages.find((g) => (g.item.metadata.Text as string).includes('attached'));
    const withoutPhoto = messages.find((g) => g.item.metadata.Text === 'no photo here');

    const attachments = withPhoto!.item.metadata.MediaAttachments as Array<Record<string, unknown>>;
    expect(attachments).toEqual([
      {
        path: photo,
        filename: '00000048-PHOTO-2026-05-08-08-35-29.jpg',
        type: 'image',
        mimetype: 'image/jpeg',
      },
    ]);
    // The SAME path the standalone media item carries, which is what makes the
    // object store's content hash collapse them onto one file.
    const mediaGraph = pushed.find((g) => g.item.classification === 'media');
    expect(mediaGraph!.item.intermediateLocation).toBe(attachments[0].path);

    // No content opt-in: the standalone media item already catalogues these
    // bytes, and opting in would mint a second ci.content row over them.
    expect(withPhoto!.item.metadata.AttachmentContent).toBeUndefined();

    // The descriptor must not leak onto the next message in the transcript.
    expect(withoutPhoto!.item.metadata.MediaAttachments).toBeUndefined();

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves an Android "X (file attached)" reference to a real media item', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-media-android-'));
    fs.writeFileSync(path.join(dir, 'IMG-20260508-WA0001.jpg'), Buffer.from('fake-jpg-bytes'));
    fs.writeFileSync(
      path.join(dir, '_chat.txt'),
      '08/05/2026, 08:36 - Bob: IMG-20260508-WA0001.jpg (file attached)\n',
    );

    const pushed: EmittedGraph[] = [];
    const fi = new WhatsAppFileImporter();
    await fi.fileImport({}, { filename: '_chat.txt', fullPath: path.join(dir, '_chat.txt') }, {
      pipeline: { push: (g: Graph) => pushed.push(g as EmittedGraph), drop: () => {} },
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const mediaGraph = pushed.find((g) => g.item.classification === 'media');
    expect(mediaGraph).toBeDefined();
    expect(mediaGraph!.item.content.filename).toBe('IMG-20260508-WA0001.jpg');
    expect(mediaGraph!.item.content.mediaType).toBe('image/jpeg');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports a drop instead of silently losing a reference to a missing attached file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-media-missing-'));
    fs.writeFileSync(
      path.join(dir, '_chat.txt'),
      '[5/8/26, 8:35:29 AM] Alice: <attached: does-not-exist.jpg>\n',
    );

    const pushed: EmittedGraph[] = [];
    const drops: Array<{ reason: string; detail?: string }> = [];
    const fi = new WhatsAppFileImporter();
    await fi.fileImport({}, { filename: '_chat.txt', fullPath: path.join(dir, '_chat.txt') }, {
      pipeline: {
        push: (g: Graph) => pushed.push(g as EmittedGraph),
        drop: (reason: string, detail?: string) => drops.push({ reason, detail }),
      },
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    expect(pushed.some((g) => g.item.classification === 'media')).toBe(false);
    expect(drops).toEqual([{ reason: 'whatsapp_attachment_missing', detail: 'does-not-exist.jpg' }]);
    // The text message is still imported — the attachment loss is reported,
    // not compounded by losing the rest of the message too.
    expect(pushed.some((g) => g.item.classification === 'message')).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('shared-location messages', () => {
    async function importLines(lines: string[]): Promise<EmittedGraph[]> {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-location-'));
      const chatPath = path.join(dir, '_chat.txt');
      fs.writeFileSync(chatPath, lines.join('\n') + '\n');
      const pushed: EmittedGraph[] = [];
      try {
        await new WhatsAppFileImporter().fileImport({}, { filename: '_chat.txt', fullPath: chatPath }, {
          pipeline: pushed,
          timeframe: {},
          log: () => {},
        } as unknown as ImportParams);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }

      return pushed;
    }

    it('classifies a maps.google.com "?q=" link as location and extracts the coordinates', async () => {
      const pushed = await importLines([
        '[1/1/21, 12:00:00 AM] Alice: location: https://maps.google.com/?q=37.7749,-122.4194',
      ]);

      expect(pushed.length).toBe(1);
      const [graph] = pushed;
      expect(graph.item.classification).toBe('location');
      expect(graph.item.location).toEqual({ latitude: 37.7749, longitude: -122.4194 });
      expect(graph.item.metadata.Location).toBe('37.7749, -122.4194');
      // The original transcript text is still preserved in content/metadata.
      expect(graph.item.metadata.Text).toContain('maps.google.com');
    });

    it('extracts coordinates from a "maps/@lat,long" style link too', async () => {
      const pushed = await importLines([
        '[1/1/21, 12:00:00 AM] Bob: https://maps.google.com/maps/@37.77,-122.41,15z',
      ]);

      expect(pushed.length).toBe(1);
      expect(pushed[0].item.classification).toBe('location');
      expect(pushed[0].item.location).toEqual({ latitude: 37.77, longitude: -122.41 });
    });

    it('does not classify a plain-text mention of "location" with no coordinates as a location', async () => {
      const pushed = await importLines([
        '[1/1/21, 12:00:00 AM] Alice: Check out this location: my new place',
      ]);

      expect(pushed.length).toBe(1);
      expect(pushed[0].item.classification).toBe('message');
      expect(pushed[0].item.location).toBeUndefined();
    });

    it('rejects an out-of-range coordinate pair rather than pinning a bogus location', async () => {
      // Latitude 190 fits the regex's digit count but is not a real latitude.
      const pushed = await importLines([
        '[1/1/21, 12:00:00 AM] Alice: location: https://maps.google.com/?q=190.0,45.0',
      ]);

      expect(pushed.length).toBe(1);
      expect(pushed[0].item.classification).toBe('message');
      expect(pushed[0].item.location).toBeUndefined();
    });

    it('links a located message to its sender the same way an ordinary message does', async () => {
      const pushed = await importLines([
        '[1/1/21, 12:00:00 AM] Alice: location: https://maps.google.com/?q=37.7749,-122.4194',
      ]);

      expect(pushed[0].edges).toEqual([
        { relation: 'participant', to: { entity: { type: 'contact', name: 'Alice' } } },
      ]);
    });
  });
});

/**
 * Which half of the path names the chat.
 *
 * WhatsApp has two export shapes and `recognize` above accepts both: the
 * generic `_chat.txt` inside a folder named after the chat, and a file named
 * after the chat directly ("WhatsApp Chat with Alice.txt"). The name is
 * IDENTITY here — it is the thread id and half of every message id — and the
 * directory-first rule handled only the first shape: several per-chat .txt
 * files in one folder all took the FOLDER's name, so every chat in the export
 * collapsed onto a single thread and a single id namespace. Worse, only the
 * first of them was read at all.
 */
describe('WhatsApp chat identity across export shapes', () => {
  const importDir = async (root: string): Promise<EmittedGraph[]> => {
    const pipeline: EmittedGraph[] = [];
    await new WhatsAppFileImporter().fileImport({}, { filename: path.basename(root), fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    return pipeline;
  };

  const exportWith = (files: Record<string, string>): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-shape-'));
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(root, name), body);
    }

    return root;
  };

  const line = (sender: string, text: string): string => `[1/1/21, 12:00:00 AM] ${sender}: ${text}\n`;

  it('gives each per-chat .txt in one folder its own conversation, and imports them all', async () => {
    const root = exportWith({
      'WhatsApp Chat with Alice.txt': line('Alice', 'from alice'),
      'WhatsApp Chat with Bob.txt': line('Bob', 'from bob'),
    });

    const pushed = await importDir(root);
    const conversations = pushed.map((p) => p.item.metadata!.Conversation);

    expect(pushed).toHaveLength(2);
    expect(new Set(conversations)).toEqual(new Set(['Alice', 'Bob']));
    // and the ids are namespaced per chat, so two chats can never collide
    expect(new Set(pushed.map((p) => p.item.id)).size).toBe(2);
  });

  it('still takes the chat name from the folder for a _chat.txt export', async () => {
    // The unchanged half: `_chat` normalises to nothing, so the folder wins.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-shape-'));
    const chatDir = path.join(root, 'WhatsApp Chat - LITA _ Companion Tech Team');
    fs.mkdirSync(chatDir);
    fs.writeFileSync(path.join(chatDir, '_chat.txt'), line('Alice', 'hello'));

    const pushed = await importDir(chatDir);

    expect(pushed).toHaveLength(1);
    expect(pushed[0].item.metadata!.Conversation).toBe('LITA Companion Tech Team');
  });
});

describe('parser loss reporting (reconciliation)', () => {
  it('reports every logical message via consumed(), one per flush() not per physical line', async () => {
    // The fixture's 7 messages include at least one multi-line body, so this
    // also proves consumed() counts folded (logical) messages, not raw lines.
    const root = path.join(FIXTURES_DIR, 'whatsapp-export');
    const fi = new WhatsAppFileImporter();
    const pipeline: TestPipeline = Object.assign([] as EmittedGraph[], { consumed: jest.fn() });

    await fi.fileImport({}, { filename: 'whatsapp-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    expect(pipeline.consumed).toHaveBeenCalledTimes(1);
    expect(pipeline.consumed).toHaveBeenCalledWith(7);
  });

  it('drops a timeframe-excluded message instead of just omitting it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-reconcile-'));
    fs.writeFileSync(
      path.join(dir, '_chat.txt'),
      '[1/1/21, 8:00:00 AM] Alice: in range\n' + '[1/2/21, 8:00:00 AM] Alice: out of range\n',
    );

    try {
      const fi = new WhatsAppFileImporter();
      const pipeline: TestPipeline = Object.assign([] as EmittedGraph[], {
        drop: jest.fn(),
        consumed: jest.fn(),
      });

      await fi.fileImport({}, { filename: path.basename(dir), fullPath: dir }, {
        pipeline,
        timeframe: { since: new Date('2021-01-01T00:00:00Z'), until: new Date('2021-01-01T23:59:59Z') },
        log: () => {},
      } as unknown as ImportParams);

      expect(pipeline.length).toBe(1);
      expect(pipeline.drop).toHaveBeenCalledWith('outside_timeframe');
      expect(pipeline.consumed).toHaveBeenCalledWith(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * A message with a resolved attachment pushes TWO items — the message and
   * the media — from ONE flush(). `produced` counts every item push, so a
   * naive "one flush() = one consumed unit" undercounts by exactly the number
   * of resolved attachments: on the real corpus that motivated this,
   * `produced: 5385` against a naive `consumed: 5254` — 131 messages short,
   * one per resolved attachment. The attachment reference is a second thing
   * this flush offers the parser, and it always resolves to one push() or one
   * drop(), so it earns its own consumed() unit.
   */
  it('counts a message with a resolved attachment as 2 toward consumed(), matching its 2 pushes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-reconcile-media-'));
    fs.writeFileSync(path.join(dir, '00000048-PHOTO-2026-05-08-08-35-29.jpg'), Buffer.from('fake-jpg-bytes'));
    fs.writeFileSync(
      path.join(dir, '_chat.txt'),
      '[5/8/26, 8:35:29 AM] Alice: <attached: 00000048-PHOTO-2026-05-08-08-35-29.jpg>\n' +
        '[5/8/26, 8:36:00 AM] Alice: a plain text message with no attachment\n',
    );

    try {
      const fi = new WhatsAppFileImporter();
      const pipeline: TestPipeline = Object.assign([] as EmittedGraph[], { consumed: jest.fn() });

      await fi.fileImport({}, { filename: path.basename(dir), fullPath: dir }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);

      // 2 items pushed for the attached message (media + text) + 1 for the
      // plain one = 3 produced, 0 dropped — so consumed() must report 3.
      expect(pipeline.length).toBe(3);
      expect(pipeline.consumed).toHaveBeenCalledWith(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the system-line filter must not eat human messages', () => {
  const LRM = '\u200e';

  const importChat = async (body: string): Promise<EmittedGraph[]> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-sys-'));
    fs.writeFileSync(path.join(dir, '_chat.txt'), body);
    const pipeline: EmittedGraph[] = [];
    const drops: string[] = [];
    // `drop` hangs off the PIPELINE, not off params — that is where the parser
    // calls it (`params.pipeline.drop?.()`), and the real collaborator is
    // StagedWriter, which carries both `push` and `drop`.
    const collector = Object.assign(pipeline, { drop: (reason: string) => drops.push(reason) });

    await new WhatsAppFileImporter().fileImport({}, { filename: path.basename(dir), fullPath: dir }, {
      pipeline: collector,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);
    fs.rmSync(dir, { recursive: true, force: true });
    (pipeline as EmittedGraph[] & { drops?: string[] }).drops = drops;

    return pipeline;
  };

  const line = (text: string) => `[1/15/25, 9:30:00 AM] Dana Wu: ${text}\n`;
  const bodies = (p: EmittedGraph[]) => p.map((g) => String(g.item.metadata?.Text ?? ''));

  /**
   * `SYSTEM_VERB_RE` is right-unbounded — `.+ (added|removed|left|…)` matches
   * those words ANYWHERE in a body. On one real 5,254-message export it
   * destroyed 53 human messages (7,901 characters) alongside the 41 system
   * lines it meant to suppress. These five are verbatim from that corpus.
   */
  it.each([
    'btw there is a RS-232 cable in the box if needed for reading from the left side elevator motherboard',
    'We just wrapped up xmas here, everybody just left the house',
    'I changed the copyright to Lita from Clai on that web panel also.',
    'well i left the page anyway',
    'To be 100% clear - I have unplugged and removed their PI',
  ])('keeps a human message containing a system verb: %s', async (text) => {
    const pipeline = await importChat(line(text));

    expect(bodies(pipeline)).toEqual([text]);
  });

  it('still suppresses a genuine system line, which WhatsApp marks with U+200E', async () => {
    const pipeline = await importChat(line(`${LRM}Batis Samadian added you`));

    expect(pipeline).toHaveLength(0);
  });

  it('records the suppression instead of returning silently', async () => {
    const pipeline = await importChat(line(`${LRM}Batis Samadian added you`));

    expect((pipeline as EmittedGraph[] & { drops?: string[] }).drops).toEqual(['whatsapp_system_line']);
  });

  it('keeps a media placeholder, which carries the marker but is not a system line', async () => {
    // The marker alone cannot be the rule: WhatsApp puts it on every line it
    // generates, including these. 745 of one export's lines carry it and only
    // 41 are system lines.
    const pipeline = await importChat(line(`${LRM}image omitted`));

    expect(pipeline).toHaveLength(1);
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'path';

import { SnapchatFileImporter } from '../snapchat';
import type { Graph, ImportParams } from '../timeline';

import type { EmittedGraph, TestPipeline } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

describe('Snapchat datasource', () => {
  it('recognizes export directory by signature files in json/ subfolder', async () => {
    const root = path.join(FIXTURES_DIR, 'snapchat-export');
    const fi = new SnapchatFileImporter();
    const rec = await fi.recognize({}, { filename: 'snapchat-export', fullPath: root });
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('recognizes a single snap_history.json file directly', async () => {
    const fpath = path.join(FIXTURES_DIR, 'snapchat-export', 'json', 'snap_history.json');
    const fi = new SnapchatFileImporter();
    const rec = await fi.recognize({}, { filename: 'snap_history.json', fullPath: fpath });
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('returns confidence 0 for an unrelated directory', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-neg-'));
    try {
      fs.writeFileSync(path.join(tmp, 'random.txt'), 'nothing here');
      const fi = new SnapchatFileImporter();
      const rec = await fi.recognize({}, { filename: 'random', fullPath: tmp });
      expect(rec.confidence).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('imports snap and chat history into message items', async () => {
    const root = path.join(FIXTURES_DIR, 'snapchat-export');
    const fi = new SnapchatFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'snapchat-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    // 3 snaps (2 received, 1 sent) + 2 chats (1 received, 1 sent)
    expect(pipeline.length).toBe(5);
    for (const g of pipeline) {
      expect(g.item.classification).toBe('message');
      expect(g.item.metadata.Source).toBe('Snapchat');
    }

    // A received snap record.
    const recvSnap = pipeline.find(
      (g: EmittedGraph) =>
        g.item.metadata.Direction === 'Received' && g.item!.metadata!['Media Type'] === 'IMAGE',
    );
    expect(recvSnap).toBeDefined();
    expect(recvSnap!.item.metadata.From).toBe('alice_snaps');
    expect(recvSnap!.item.metadata.To).toBeUndefined();
    expect(recvSnap!.item.metadata.Text).toBeUndefined();
    expect(recvSnap!.item.timestamp).toBeInstanceOf(Date);
    expect(recvSnap!.item.timestamp!.toISOString()).toBe('2023-01-15T10:30:00.000Z');

    // A sent snap record.
    const sentSnap = pipeline.find(
      (g: EmittedGraph) => g.item.metadata.Direction === 'Sent' && g.item!.metadata['Media Type'] === 'VIDEO',
    );
    expect(sentSnap).toBeDefined();
    expect(sentSnap!.item.metadata.To).toBe('alice_snaps');
    expect(sentSnap!.item.metadata.From).toBeUndefined();
    // Text-less snap carries a title-bearing Subject (not the bare filename).
    expect(sentSnap!.item.metadata.Subject).toBe('Sent VIDEO to alice_snaps');
    expect(sentSnap!.item.metadata.Subject).not.toBe(sentSnap!.item.content.filename);

    // A received chat record carries Text.
    const recvChat = pipeline.find(
      (g: EmittedGraph) => g.item.metadata.Direction === 'Received' && g.item!.metadata!.Text,
    );
    expect(recvChat).toBeDefined();
    expect(recvChat!.item.metadata.From).toBe('alice_snaps');
    expect(recvChat!.item.metadata.Text).toBe('hey, you around?');
    // Records with real Text title off Text, so no synthetic Subject is set.
    expect(recvChat!.item.metadata.Subject).toBeUndefined();
    expect(recvChat!.item.timestamp!.toISOString()).toBe('2023-02-01T09:15:00.000Z');

    // Chat body data is the chat text itself.
    const buf = await recvChat!.item.content.data!();
    expect(buf.toString()).toBe('hey, you around?');
  });

  it('imports from a single file dropped directly', async () => {
    const fpath = path.join(FIXTURES_DIR, 'snapchat-export', 'json', 'chat_history.json');
    const fi = new SnapchatFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'chat_history.json', fullPath: fpath }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    expect(pipeline.length).toBe(2);
    expect(pipeline.every((g: Graph) => g.item!.classification === 'message')).toBe(true);
  });

  it('does not throw on empty/malformed JSON and emits nothing', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-bad-'));
    try {
      fs.writeFileSync(path.join(tmp, 'snap_history.json'), '{ this is not json');
      const fi = new SnapchatFileImporter();
      const pipeline: EmittedGraph[] = [];
      await fi.fileImport(
        {},
        { filename: 'snap_history.json', fullPath: path.join(tmp, 'snap_history.json') },
        {
          pipeline,
          timeframe: {},
          log: () => {},
        } as unknown as ImportParams,
      );
      expect(pipeline.length).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('assigns unique, idempotent ids to same-second records that would otherwise collapse', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-dedup-'));
    try {
      // Two received snaps from the same user in the SAME second, plus a sent one.
      // With no item.id these collapse on the dedup hash (same ts, constant filename).
      fs.writeFileSync(
        path.join(tmp, 'snap_history.json'),
        JSON.stringify({
          'Received Snap History': [
            { From: 'alice', 'Media Type': 'IMAGE', Created: '2023-01-15 10:30:00 UTC' },
            { From: 'alice', 'Media Type': 'IMAGE', Created: '2023-01-15 10:30:00 UTC' },
          ],
          'Sent Snap History': [{ To: 'alice', 'Media Type': 'VIDEO', Created: '2023-01-15 10:30:00 UTC' }],
        }),
      );
      const runImport = async () => {
        const fi = new SnapchatFileImporter();
        const pipeline: EmittedGraph[] = [];
        await fi.fileImport(
          {},
          { filename: 'snap_history.json', fullPath: path.join(tmp, 'snap_history.json') },
          {
            pipeline,
            timeframe: {},
            log: () => {},
          } as unknown as ImportParams,
        );

        return pipeline;
      };

      const pipeline = await runImport();
      expect(pipeline.length).toBe(3);
      const ids = pipeline.map((g: Graph) => g.item!.id);
      // (a) every id truthy, (b) all distinct.
      expect(ids.every((id: string | undefined) => !!id)).toBe(true);
      expect(new Set(ids).size).toBe(3);

      // (c) re-import yields identical ids (idempotent).
      const pipeline2 = await runImport();
      expect(pipeline2.map((g: Graph) => g.item!.id)).toEqual(ids);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('tolerates missing keys without throwing', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-partial-'));
    try {
      // Only a "Sent Snap History" array, records missing optional fields.
      fs.writeFileSync(
        path.join(tmp, 'snap_history.json'),
        JSON.stringify({ 'Sent Snap History': [{ Created: '2023-03-01 12:00:00 UTC' }] }),
      );
      const fi = new SnapchatFileImporter();
      const pipeline: EmittedGraph[] = [];
      await fi.fileImport(
        {},
        { filename: 'snap_history.json', fullPath: path.join(tmp, 'snap_history.json') },
        {
          pipeline,
          timeframe: {},
          log: () => {},
        } as unknown as ImportParams,
      );
      expect(pipeline.length).toBe(1);
      expect(pipeline[0].item.metadata.Direction).toBe('Sent');
      expect(pipeline[0].item.metadata.To).toBeUndefined();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  describe('conversation-keyed layout (current exports)', () => {
    // The shape current "My Data" exports ship: both files keyed by
    // conversation, a sender flag on every record, the text in "Content". A
    // group chat is keyed by an id and names itself in "Conversation Title".
    const chatHistory = {
      ottilie_b: [
        {
          From: 'ottilie_b',
          'Media Type': 'TEXT',
          Created: '2026-10-01 19:20:11 UTC',
          Content: 'Ferry at 9, do not be late',
          'Conversation Title': null,
          isSender: false,
          'Created(microseconds)': 1790871611000000,
          IsSaved: false,
          'Media IDs': '',
        },
        {
          From: 'zquill',
          'Media Type': 'TEXT',
          Created: '2026-10-01 19:22:40 UTC',
          Content: 'I will bring the thermos',
          'Conversation Title': null,
          isSender: true,
          'Created(microseconds)': 1790871760000000,
          IsSaved: false,
          'Media IDs': '',
        },
        {
          From: 'ottilie_b',
          'Media Type': 'MEDIA',
          Created: '2026-10-01 19:25:02 UTC',
          Content: null,
          'Conversation Title': null,
          isSender: false,
          'Created(microseconds)': 1790871902000000,
          IsSaved: false,
          'Media IDs': 'b~EiQSFUJ4c2RmM3E',
        },
      ],
      '1d6f2b9e-4c3a-4e8b-9a71-5d2c8e0f1a3b': [
        {
          From: 'casimir.thorn',
          'Media Type': 'TEXT',
          Created: '2026-10-04 08:41:00 UTC',
          Content: 'Summit by noon?',
          'Conversation Title': 'Lantern Hikers',
          isSender: false,
          'Created(microseconds)': 1791103260000000,
          IsSaved: false,
          'Media IDs': '',
        },
        {
          From: 'zquill',
          'Media Type': 'TEXT',
          Created: '2026-10-04 08:43:30 UTC',
          Content: 'Only if the fog lifts',
          'Conversation Title': 'Lantern Hikers',
          isSender: true,
          'Created(microseconds)': 1791103410000000,
          IsSaved: false,
          'Media IDs': '',
        },
      ],
    };
    const snapHistory = {
      ottilie_b: [
        {
          From: 'ottilie_b',
          'Media Type': 'IMAGE',
          Created: '2026-10-02 13:00:00 UTC',
          'Conversation Title': null,
          IsSender: false,
          'Created(microseconds)': 1790946000000000,
        },
        {
          From: 'zquill',
          'Media Type': 'VIDEO',
          Created: '2026-10-02 13:05:30 UTC',
          'Conversation Title': null,
          IsSender: true,
          'Created(microseconds)': 1790946330000000,
        },
      ],
    };

    async function importTree(files: Record<string, unknown>): Promise<TestPipeline & { drops: string[] }> {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-current-'));
      try {
        fs.mkdirSync(path.join(tmp, 'json'));
        for (const [name, body] of Object.entries(files)) {
          fs.writeFileSync(path.join(tmp, 'json', name), JSON.stringify(body));
        }

        const fi = new SnapchatFileImporter();
        expect((await fi.recognize({}, { filename: 'mydata', fullPath: tmp })).confidence).toBeGreaterThan(
          0.8,
        );

        const drops: string[] = [];
        const pipeline: TestPipeline = Object.assign([] as EmittedGraph[], {
          drop: (reason: string) => {
            drops.push(reason);
          },
        });
        await fi.fileImport({}, { filename: 'mydata', fullPath: tmp }, {
          pipeline,
          timeframe: {},
          log: () => {},
        } as unknown as ImportParams);

        return Object.assign(pipeline, { drops });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }

    it('reads every chat and snap with its direction, people and text', async () => {
      const pipeline = await importTree({
        'chat_history.json': chatHistory,
        'snap_history.json': snapHistory,
      });

      expect(pipeline.length).toBe(7);
      expect(pipeline.every((g) => g.item.classification === 'message')).toBe(true);

      const byText = (text: string) => pipeline.find((g) => g.item.metadata.Text === text)!;

      const received = byText('Ferry at 9, do not be late');
      expect(received.item.metadata.Direction).toBe('Received');
      expect(received.item.metadata.From).toBe('ottilie_b');
      expect(received.item.metadata.To).toBeUndefined();
      expect(received.item.metadata.Conversation).toBe('ottilie_b');
      expect(received.item.timestamp!.toISOString()).toBe('2026-10-01T19:20:11.000Z');
      expect((await received.item.content.data!()).toString()).toBe('Ferry at 9, do not be late');

      const sent = byText('I will bring the thermos');
      expect(sent.item.metadata.Direction).toBe('Sent');
      expect(sent.item.metadata.To).toBe('ottilie_b');
      expect(sent.item.metadata.From).toBeUndefined();

      // A photo with no text still lands, titled by what it was.
      const media = pipeline.find((g) => g.item.metadata.Subject === 'Received chat from ottilie_b');
      expect(media).toBeDefined();
      expect(media!.item.timestamp!.toISOString()).toBe('2026-10-01T19:25:02.000Z');

      // Group chat: threaded on its title; a sent message names no single recipient.
      const groupIn = byText('Summit by noon?');
      expect(groupIn.item.metadata.From).toBe('casimir.thorn');
      expect(groupIn.item.metadata.Conversation).toBe('Lantern Hikers');
      const groupOut = byText('Only if the fog lifts');
      expect(groupOut.item.metadata.Direction).toBe('Sent');
      expect(groupOut.item.metadata.To).toBeUndefined();
      expect(groupOut.item.metadata.Conversation).toBe('Lantern Hikers');

      // Snaps read the "IsSender" spelling.
      const snapOut = pipeline.find((g) => g.item.metadata['Media Type'] === 'VIDEO')!;
      expect(snapOut.item.metadata.Direction).toBe('Sent');
      expect(snapOut.item.metadata.Subject).toBe('Sent VIDEO to ottilie_b');
      const snapIn = pipeline.find((g) => g.item.metadata['Media Type'] === 'IMAGE')!;
      expect(snapIn.item.metadata.From).toBe('ottilie_b');

      expect(new Set(pipeline.map((g) => g.item.id)).size).toBe(7);
      expect(pipeline.drops).toEqual([]);
    });

    it('reads a conversation whose username contains "sent" as a conversation', async () => {
      const pipeline = await importTree({
        'chat_history.json': {
          absentee: [{ ...chatHistory.ottilie_b[0], From: 'absentee', Content: 'Back on Monday' }],
        },
      });

      expect(pipeline.length).toBe(1);
      expect(pipeline[0].item.metadata.Direction).toBe('Received');
      expect(pipeline[0].item.metadata.From).toBe('absentee');
      expect(pipeline[0].item.metadata.Text).toBe('Back on Monday');
    });

    it('counts records it cannot place instead of finishing empty without a word', async () => {
      const pipeline = await importTree({
        'chat_history.json': {
          ottilie_b: [{ From: 'ottilie_b', Created: '2026-10-01 19:20:11 UTC', Content: 'no sender flag' }],
        },
      });

      expect(pipeline.length).toBe(0);
      expect(pipeline.drops).toEqual(['snapchat_unknown_layout']);
    });
  });
});

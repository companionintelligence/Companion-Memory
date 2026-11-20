import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RobloxFileImporter } from '../roblox';
import type { ImportParams } from '../timeline';

import type { EmittedGraph } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const ROBLOX_DIR = path.join(FIXTURES_DIR, 'roblox-export');

function tmpFile(content: string, name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-roblox-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);

  return p;
}

async function run(fullPath: string) {
  const fi = new RobloxFileImporter();
  const pipeline: EmittedGraph[] = [];
  await fi.fileImport({}, { filename: path.basename(fullPath), fullPath }, {
    pipeline,
    timeframe: {},
    log: () => {},
  } as unknown as ImportParams);

  return pipeline;
}

describe('Roblox datasource', () => {
  it('recognizes a roblox-named report directory', async () => {
    const fi = new RobloxFileImporter();
    const rec = await fi.recognize({}, { filename: 'roblox-export', fullPath: ROBLOX_DIR });
    expect(rec.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('does not recognize an unrelated directory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-other-'));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello');
    const fi = new RobloxFileImporter();
    const rec = await fi.recognize({}, { filename: path.basename(dir), fullPath: dir });
    expect(rec.confidence).toBe(0);
  });

  it('ingests CSV and JSON files from the report', async () => {
    const pipeline = await run(ROBLOX_DIR);
    // 2 login rows + 2 purchases + 2 chat lines = 6 items
    expect(pipeline.length).toBe(6);
    expect(pipeline.every((p) => p.item.metadata.Source === 'Roblox')).toBe(true);
    expect(pipeline.every((p) => !!p.item.metadata.Kind)).toBe(true);
  });

  it('classifies chat as messages, purchases as purchase, and the rest as social', async () => {
    const pipeline = await run(ROBLOX_DIR);
    const messages = pipeline.filter((p) => p.item.classification === 'message');
    const purchases = pipeline.filter((p) => p.item.classification === 'purchase');
    const social = pipeline.filter((p) => p.item.classification === 'social');
    expect(messages.length).toBe(2); // ChatLogs.csv
    expect(purchases.length).toBe(2); // PurchaseHistory.json → things, not social.post
    expect(social.length).toBe(2); // LoginHistory.csv
    expect(messages[0].item.timestamp instanceof Date).toBe(true);
  });

  it('classifies by the file name, not by the directory path it was extracted to', async () => {
    // The report is a user-supplied folder — an inbox subfolder, a Downloads
    // directory, the checkout a test runs from. Words in ANY ancestor segment
    // must not decide the classification of every row inside it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-roblox-message-order-'));
    for (const name of fs.readdirSync(ROBLOX_DIR)) {
      fs.copyFileSync(path.join(ROBLOX_DIR, name), path.join(dir, name));
    }

    const pipeline = await run(dir);
    expect(pipeline.length).toBe(6);
    const byClass = (c: string) => pipeline.filter((p) => p.item.classification === c).length;
    // 'message' and 'order' both appear in the parent directory name above.
    expect(byClass('message')).toBe(2); // ChatLogs.csv
    expect(byClass('purchase')).toBe(2); // PurchaseHistory.json
    expect(byClass('social')).toBe(2); // LoginHistory.csv
  });

  it('malformed input does not throw', async () => {
    const p = tmpFile('{ broken json,,,\n\x00\x01', 'roblox.json');
    await expect(run(p)).resolves.toBeDefined();
  });

  it('empty input yields no items', async () => {
    const p = tmpFile('', 'roblox.csv');
    const pipeline = await run(p);
    expect(pipeline.length).toBe(0);
  });

  it('sets a title-bearing metadata key so rows do not display as the bare filename', async () => {
    const csv = 'Recipient,Message\n' + 'builderman,hello there\n';
    const p = tmpFile(csv, 'roblox-chat.csv');
    const pipeline = await run(p);
    expect(pipeline.length).toBe(1);
    const item = pipeline[0].item;
    // titleFor derives the title from Title (a title-bearing key), not the
    // constant 'roblox.txt' filename.
    expect(item.metadata.Title).toBe('hello there');
    expect(item.metadata.Title).not.toBe(item.content.filename);
  });

  it('falls back to a Kind-labelled title when no title-bearing column exists', async () => {
    const csv = 'Device,Location\n' + 'iPhone,127.0.0.1\n';
    const p = tmpFile(csv, 'roblox-login.csv');
    const pipeline = await run(p);
    expect(pipeline.length).toBe(1);
    // Device is one of the preferred keys; if it were absent it would label by Kind.
    expect(pipeline[0].item.metadata.Title).toBe('iPhone');
    expect(pipeline[0].item.metadata.Title).not.toBe('roblox.txt');
  });

  it('gives each row a unique, stable id even when no date column exists', async () => {
    // No date-like column → findDate returns undefined for every row, so the
    // old timestamp+filename hash collapsed all rows of one classification to one.
    const csv =
      'Recipient,Message\n' +
      'builderman,first message\n' +
      'builderman,second message\n' +
      'telamon,third message\n';
    const p = tmpFile(csv, 'roblox-chat.csv');
    const pipeline = await run(p);
    expect(pipeline.length).toBe(3);
    const ids = pipeline.map((g) => g.item.id!);
    expect(ids.every((id) => !!id)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    // Re-import the same file → identical ids (idempotent).
    const again = await run(p);
    expect(again.map((g) => g.item.id!)).toEqual(ids);
  });

  describe("telling the account holder's chat messages apart", () => {
    const CHAT =
      'Timestamp,Sender,Recipient,Message,Experience\n' +
      '2026-03-03T10:00:00Z,QuillfeatherZ,BramblewoodOtto,want to run the tower together?,Tower of Hell\n' +
      '2026-03-03T10:01:12Z,BramblewoodOtto,QuillfeatherZ,yes joining your server now,Tower of Hell\n';

    function report(files: Record<string, string>): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-roblox-owner-'));
      for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), content);
      }

      return dir;
    }

    async function directions(dir: string): Promise<unknown[]> {
      try {
        const pipeline = await run(dir);

        return pipeline
          .filter((p) => p.item.classification === 'message')
          .sort((a, b) => a.item.timestamp!.getTime() - b.item.timestamp!.getTime())
          .map((p) => p.item.metadata.Direction);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }

    it('marks rows sent by the username in the account file as sent', async () => {
      const dir = report({
        'AccountInformation.csv':
          'UserId,Username,DisplayName,Created\n4419028815,quillfeatherz,Zephyrine Q,2026-01-05T16:20:11Z\n',
        'ChatHistory.csv': CHAT,
      });

      expect(await directions(dir)).toEqual(['sent', 'received']);
    });

    it('reads the username from a JSON account file too', async () => {
      const dir = report({
        'AccountInformation.json': JSON.stringify({ UserId: 4419028815, Username: 'QuillfeatherZ' }),
        'ChatHistory.csv': CHAT,
      });

      expect(await directions(dir)).toEqual(['sent', 'received']);
    });

    it('leaves direction unset when the report names no account', async () => {
      expect(await directions(report({ 'ChatHistory.csv': CHAT }))).toEqual([undefined, undefined]);
    });

    it('does not take the owner from a file that lists other accounts', async () => {
      const dir = report({
        'AlternateAccounts.csv': 'UserId,Username\n5520017741,BramblewoodOtto\n',
        'BlockedAccounts.csv': 'UserId,Username\n5520017741,BramblewoodOtto\n6620017742,Marigold_Penhallow\n',
        'AccountInformation.csv': 'UserId,Username\n4419028815,QuillfeatherZ\n',
        'ChatHistory.csv': CHAT,
      });

      expect(await directions(dir)).toEqual(['sent', 'received']);
    });

    it('leaves direction unset when only a list of other accounts names anyone', async () => {
      const dir = report({
        'LinkedAccounts.csv': 'UserId,Username\n5520017741,BramblewoodOtto\n',
        'ChatHistory.csv': CHAT,
      });

      expect(await directions(dir)).toEqual([undefined, undefined]);
    });
  });
});

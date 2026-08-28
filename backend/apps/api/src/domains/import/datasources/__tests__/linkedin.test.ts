import fs from 'fs';
import os from 'os';
import path from 'path';

import { LinkedInFileImporter } from '../linkedin';
import type { EntityAttribute, ImportParams } from '../timeline';

import type { EmittedGraph, TestPipeline } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

describe('LinkedIn datasource', () => {
  it('recognizes a LinkedIn export directory', async () => {
    const root = path.join(FIXTURES_DIR, 'linkedin-export');
    const fi = new LinkedInFileImporter();
    const rec = await fi.recognize({}, { filename: 'linkedin-export', fullPath: root });
    expect(rec.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('recognizes a lone Connections.csv (past the Notes: preamble)', async () => {
    const fpath = path.join(FIXTURES_DIR, 'linkedin-export', 'Connections.csv');
    const fi = new LinkedInFileImporter();
    const rec = await fi.recognize({}, { filename: 'Connections.csv', fullPath: fpath });
    expect(rec.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('recognizes a lone messages.csv', async () => {
    const fpath = path.join(FIXTURES_DIR, 'linkedin-export', 'messages.csv');
    const fi = new LinkedInFileImporter();
    const rec = await fi.recognize({}, { filename: 'messages.csv', fullPath: fpath });
    expect(rec.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('imports connection entities and connection social events', async () => {
    const fpath = path.join(FIXTURES_DIR, 'linkedin-export', 'Connections.csv');
    const fi = new LinkedInFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'Connections.csv', fullPath: fpath }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const entities = pipeline.filter((p) => p.entity);
    const items = pipeline.filter((p) => p.item);
    expect(entities.length).toBe(2);
    expect(items.length).toBe(2);

    const ada = entities.find((e) => e.entity!.name === 'Ada Lovelace');
    expect(ada).toBeDefined();
    // Typed `contact` so graph-sync sends it to CI-Server as a Person.
    expect(ada!.entity!.type).toBe('contact');
    expect(
      ada!.entity!.attributes!.some(
        (a: EntityAttribute) => a.name === 'email' && a.value === 'ada@example.com' && a.identity,
      ),
    ).toBe(true);
    expect(ada!.entity!.metadata!.Company).toBe('Analytical Engines');
    expect(ada!.entity!.metadata!.Source).toBe('LinkedIn');

    // Turing has no email -> no email attribute, but is STILL typed `contact`
    // so the (vast majority of) email-less connections reach the graph.
    const alan = entities.find((e) => e.entity!.name === 'Alan Turing');
    expect(alan!.entity!.type).toBe('contact');
    expect(alan!.entity!.attributes!.length).toBe(0);

    const connEvent = items.find((p) => p.item.metadata.Person === 'Ada Lovelace');
    expect(connEvent!.item.classification).toBe('social');
    // Title-bearing keys so titleFor renders a human title, not 'connection.txt'.
    expect(connEvent!.item.metadata.Title).toBe('Connected with Ada Lovelace');
    expect(connEvent!.item.metadata.Name).toBe('Ada Lovelace');
    expect(connEvent!.item.metadata.Kind).toBe('connection');
    expect(connEvent!.item.metadata.Source).toBe('LinkedIn');
    expect(connEvent!.item.timestamp instanceof Date).toBe(true);
    expect(connEvent!.item.timestamp!.getUTCFullYear()).toBe(2021);
    expect(connEvent!.item.timestamp!.getUTCMonth()).toBe(2); // March
    expect(connEvent!.item.timestamp!.getUTCDate()).toBe(15);
  });

  it('imports messages with sender, conversation and source; quoted comma/newline intact', async () => {
    const fpath = path.join(FIXTURES_DIR, 'linkedin-export', 'messages.csv');
    const fi = new LinkedInFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'messages.csv', fullPath: fpath }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    expect(pipeline.length).toBe(2);
    expect(pipeline.every((p) => p.item.classification === 'message')).toBe(true);
    expect(pipeline[0].item.metadata.Sender).toBe('Ada Lovelace');
    expect(pipeline[0].item.metadata.To).toBe('Liam Broza');
    expect(pipeline[1].item.metadata.Sender).toBe('Liam Broza');
    expect(pipeline[1].item.metadata.To).toBe('Ada Lovelace');
    expect(pipeline[0].item.metadata.Conversation).toBe('Project Chat');
    expect(pipeline[0].item.metadata.Source).toBe('LinkedIn');
    expect(pipeline[0].item.timestamp instanceof Date).toBe(true);

    const body = (await pipeline[0].item.content!.data!()).toString();
    expect(body).toContain('item one, with a comma');
    expect(body).toContain('\n');

    // Owner (Liam Broza) resolved from the sibling Invitations.csv: messages he
    // sent are outgoing, messages sent to him are incoming.
    expect(pipeline[0].item.metadata.Direction).toBe('incoming');
    expect(pipeline[1].item.metadata.Direction).toBe('outgoing');
  });

  it('derives message direction from Invitations.csv when importing the export directory', async () => {
    const root = path.join(FIXTURES_DIR, 'linkedin-export');
    const fi = new LinkedInFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'linkedin-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);
    const messages = pipeline.filter((p) => p.item?.classification === 'message');
    expect(messages.length).toBe(2);
    expect(messages!.find((m) => m.item.metadata.Sender === 'Ada Lovelace')!.item.metadata.Direction).toBe(
      'incoming',
    );
    expect(messages!.find((m) => m.item.metadata.Sender === 'Liam Broza')!.item.metadata.Direction).toBe(
      'outgoing',
    );
  });

  it('infers the owner from messages.csv alone when Invitations.csv is absent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkedin-owner-infer-'));
    // Two conversations; the only participant common to both is the owner.
    const csv = [
      'CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,RECIPIENT PROFILE URLS,DATE,SUBJECT,CONTENT,FOLDER',
      'conv-1,Chat A,Liam Broza,https://www.linkedin.com/in/liambroza,Ada Lovelace,https://www.linkedin.com/in/adalovelace,2024-01-01 12:00:00 UTC,,Hello Ada,INBOX',
      'conv-2,Chat B,Alan Turing,https://www.linkedin.com/in/alanturing,Liam Broza,https://www.linkedin.com/in/liambroza,2024-01-03 08:00:00 UTC,,Hello Liam,INBOX',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'messages.csv'), csv);
    const fi = new LinkedInFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'messages.csv', fullPath: path.join(dir, 'messages.csv') }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);
    expect(pipeline.length).toBe(2);
    expect(pipeline[0].item.metadata.Direction).toBe('outgoing'); // Liam sent
    expect(pipeline[1].item.metadata.Direction).toBe('incoming'); // Alan sent
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('leaves direction unset when the owner cannot be determined', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkedin-owner-unknown-'));
    // A single conversation is ambiguous — either participant could be the owner.
    const csv = [
      'CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,RECIPIENT PROFILE URLS,DATE,SUBJECT,CONTENT,FOLDER',
      'conv-1,Chat A,Liam Broza,https://www.linkedin.com/in/liambroza,Ada Lovelace,https://www.linkedin.com/in/adalovelace,2024-01-01 12:00:00 UTC,,Hello Ada,INBOX',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'messages.csv'), csv);
    const fi = new LinkedInFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'messages.csv', fullPath: path.join(dir, 'messages.csv') }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);
    expect(pipeline.length).toBe(1);
    expect(pipeline[0].item.metadata.Direction).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('identifies the owner from a draft row (drafts are always authored by the owner)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkedin-owner-draft-'));
    const csv = [
      'CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,RECIPIENT PROFILE URLS,DATE,SUBJECT,CONTENT,FOLDER,IS MESSAGE DRAFT',
      'conv-1,Chat A,Ada Lovelace,https://www.linkedin.com/in/adalovelace,Liam Broza,https://www.linkedin.com/in/liambroza,2024-01-01 12:00:00 UTC,,Hello Liam,INBOX,No',
      'conv-1,Chat A,Liam Broza,https://linkedin.com/in/LiamBroza/,Ada Lovelace,https://www.linkedin.com/in/adalovelace,2024-01-02 09:00:00 UTC,,Unsent reply,INBOX,Yes',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'messages.csv'), csv);
    const fi = new LinkedInFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'messages.csv', fullPath: path.join(dir, 'messages.csv') }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);
    // URL normalization: the draft's non-www, trailing-slash, mixed-case URL
    // still matches the owner.
    expect(pipeline[0].item.metadata.Direction).toBe('incoming'); // Ada → owner
    expect(pipeline[1].item.metadata.Direction).toBe('outgoing'); // owner's draft
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('imports both files when given the directory', async () => {
    const root = path.join(FIXTURES_DIR, 'linkedin-export');
    const fi = new LinkedInFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'linkedin-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);
    // 2 connection entities + 2 connection events + 2 messages.
    expect(pipeline.length).toBe(6);
  });

  it('malformed / binary input does not throw', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkedin-malformed-'));
    fs.writeFileSync(
      path.join(dir, 'Connections.csv'),
      Buffer.from([0x00, 0xff, 0x22, 0x2c, 0x0a, 0x99, 0xfe]),
    );
    fs.writeFileSync(path.join(dir, 'messages.csv'), 'garbage,,,"unterminated quote\nstuff');
    const fi = new LinkedInFileImporter();
    const pipeline: EmittedGraph[] = [];
    await expect(
      fi.fileImport({}, { filename: 'x', fullPath: dir }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams),
    ).resolves.toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('same-day connections get distinct, stable, idempotent ids (no dedup collapse)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkedin-dedup-'));
    const csv = [
      'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
      'Grace,Hopper,https://www.linkedin.com/in/gracehopper,,US Navy,Rear Admiral,15 Mar 2021',
      'Katherine,Johnson,https://www.linkedin.com/in/katherinejohnson,,NASA,Mathematician,15 Mar 2021',
      'Margaret,Hamilton,https://www.linkedin.com/in/margarethamilton,,MIT,Engineer,15 Mar 2021',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'Connections.csv'), csv);
    const fi = new LinkedInFileImporter();

    const run = async () => {
      const pipeline: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: 'Connections.csv', fullPath: path.join(dir, 'Connections.csv') }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);

      return pipeline.filter((p) => p.item).map((p) => p.item.id!);
    };

    const ids = await run();
    expect(ids.length).toBe(3);
    expect(ids.every((id: unknown) => !!id)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);

    const ids2 = await run();
    expect(ids2).toEqual(ids); // re-import yields identical ids
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('empty input yields no items', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkedin-empty-'));
    fs.writeFileSync(path.join(dir, 'Connections.csv'), '');
    fs.writeFileSync(path.join(dir, 'messages.csv'), '');
    const fi = new LinkedInFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'x', fullPath: dir }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);
    expect(pipeline.length).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('parser loss reporting (reconciliation)', () => {
    it('reports Connections.csv: 1 base unit per row + 1 extra for the always-attempted event', async () => {
      const fpath = path.join(FIXTURES_DIR, 'linkedin-export', 'Connections.csv');
      const fi = new LinkedInFileImporter();
      const pipeline: TestPipeline = Object.assign([] as EmittedGraph[], {
        drop: jest.fn(),
        consumed: jest.fn(),
      });
      await fi.fileImport({}, { filename: 'Connections.csv', fullPath: fpath }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);

      const consumedSum = (pipeline.consumed as jest.Mock).mock.calls.reduce(
        (sum: number, [n]: [number]) => sum + n,
        0,
      );
      const producedCount = pipeline.length; // 2 entities + 2 events
      const droppedCount = (pipeline.drop as jest.Mock).mock.calls.length;

      expect(producedCount).toBe(4);
      expect(droppedCount).toBe(0);
      expect(consumedSum).toBe(producedCount + droppedCount);
      expect(consumedSum).toBe(4); // 2 base rows + 2 extra (one event per named row)
    });

    it('drops an unnamed connection row instead of silently skipping it', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkedin-unnamed-'));
      const csv = [
        'First Name,Last Name,Email Address,Company,Position,Connected On',
        ',,noone@example.com,Acme,Eng,15 Mar 2021',
      ].join('\n');
      fs.writeFileSync(path.join(dir, 'Connections.csv'), csv);
      const fi = new LinkedInFileImporter();
      const pipeline: TestPipeline = Object.assign([] as EmittedGraph[], {
        drop: jest.fn(),
        consumed: jest.fn(),
      });

      await fi.fileImport({}, { filename: 'Connections.csv', fullPath: path.join(dir, 'Connections.csv') }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);

      expect(pipeline.length).toBe(0);
      expect(pipeline.drop).toHaveBeenCalledWith('unnamed_connection');
      expect(pipeline.consumed).toHaveBeenCalledWith(1);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('drops a timeframe-excluded connection event instead of silently skipping it', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkedin-tf-'));
      const csv = [
        'First Name,Last Name,Email Address,Company,Position,Connected On',
        'Ada,Lovelace,ada@example.com,Acme,Eng,15 Mar 2021',
      ].join('\n');
      fs.writeFileSync(path.join(dir, 'Connections.csv'), csv);
      const fi = new LinkedInFileImporter();
      const pipeline: TestPipeline = Object.assign([] as EmittedGraph[], {
        drop: jest.fn(),
        consumed: jest.fn(),
      });

      await fi.fileImport({}, { filename: 'Connections.csv', fullPath: path.join(dir, 'Connections.csv') }, {
        pipeline,
        timeframe: { since: new Date('2027-01-01T00:00:00Z') },
        log: () => {},
      } as unknown as ImportParams);

      // The entity still pushes (unconditional); only the event is excluded.
      expect(pipeline.filter((p) => p.entity).length).toBe(1);
      expect(pipeline.filter((p) => p.item).length).toBe(0);
      expect(pipeline.drop).toHaveBeenCalledWith('outside_timeframe');
      const consumedSum = (pipeline.consumed as jest.Mock).mock.calls.reduce(
        (sum: number, [n]: [number]) => sum + n,
        0,
      );
      expect(consumedSum).toBe(2); // 1 base + 1 extra for the (dropped) event
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('reports messages.csv via consumed(), one per row', async () => {
      const fpath = path.join(FIXTURES_DIR, 'linkedin-export', 'messages.csv');
      const fi = new LinkedInFileImporter();
      const pipeline: TestPipeline = Object.assign([] as EmittedGraph[], { consumed: jest.fn() });
      await fi.fileImport({}, { filename: 'messages.csv', fullPath: fpath }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);

      expect(pipeline.consumed).toHaveBeenCalledTimes(1);
      expect(pipeline.consumed).toHaveBeenCalledWith(2);
    });

    it('drops a message with empty content instead of silently skipping it', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkedin-empty-msg-'));
      const csv = [
        'CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,RECIPIENT PROFILE URLS,DATE,SUBJECT,CONTENT,FOLDER',
        'conv-1,Chat A,Ada Lovelace,https://www.linkedin.com/in/ada,Liam Broza,https://www.linkedin.com/in/liam,2024-01-01 12:00:00 UTC,,,INBOX',
      ].join('\n');
      fs.writeFileSync(path.join(dir, 'messages.csv'), csv);
      const fi = new LinkedInFileImporter();
      const pipeline: TestPipeline = Object.assign([] as EmittedGraph[], {
        drop: jest.fn(),
        consumed: jest.fn(),
      });

      await fi.fileImport({}, { filename: 'messages.csv', fullPath: path.join(dir, 'messages.csv') }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);

      expect(pipeline.length).toBe(0);
      expect(pipeline.drop).toHaveBeenCalledWith('empty_after_parse');
      expect(pipeline.consumed).toHaveBeenCalledWith(1);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('drops a timeframe-excluded message instead of silently skipping it', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkedin-tf-msg-'));
      const csv = [
        'CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,RECIPIENT PROFILE URLS,DATE,SUBJECT,CONTENT,FOLDER',
        'conv-1,Chat A,Ada Lovelace,https://www.linkedin.com/in/ada,Liam Broza,https://www.linkedin.com/in/liam,2024-01-01 12:00:00 UTC,,hello,INBOX',
      ].join('\n');
      fs.writeFileSync(path.join(dir, 'messages.csv'), csv);
      const fi = new LinkedInFileImporter();
      const pipeline: TestPipeline = Object.assign([] as EmittedGraph[], {
        drop: jest.fn(),
        consumed: jest.fn(),
      });

      await fi.fileImport({}, { filename: 'messages.csv', fullPath: path.join(dir, 'messages.csv') }, {
        pipeline,
        timeframe: { since: new Date('2027-01-01T00:00:00Z') },
        log: () => {},
      } as unknown as ImportParams);

      expect(pipeline.length).toBe(0);
      expect(pipeline.drop).toHaveBeenCalledWith('outside_timeframe');
      expect(pipeline.consumed).toHaveBeenCalledWith(1);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });
});

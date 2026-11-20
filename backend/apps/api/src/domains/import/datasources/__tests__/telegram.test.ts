import fs from 'fs';
import os from 'os';
import path from 'path';

import { TelegramFileImporter } from '../telegram';
import type { ImportParams } from '../timeline';

import type { EmittedGraph } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

describe('Telegram datasource', () => {
  it('recognizes directory containing result.json', async () => {
    const root = path.join(FIXTURES_DIR, 'telegram-export');
    const fi = new TelegramFileImporter();
    const rec = await fi.recognize({}, { filename: 'telegram-export', fullPath: root });
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('recognizes single result.json file', async () => {
    const fpath = path.join(FIXTURES_DIR, 'telegram-export', 'result.json');
    const fi = new TelegramFileImporter();
    const rec = await fi.recognize({}, { filename: 'result.json', fullPath: fpath });
    expect(rec.confidence).toBeGreaterThan(0.9);
  });

  it('imports contacts as entities and messages as items', async () => {
    const fpath = path.join(FIXTURES_DIR, 'telegram-export', 'result.json');
    const fi = new TelegramFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'result.json', fullPath: fpath }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const entities = pipeline.filter((p) => p.entity);
    const items = pipeline.filter((p) => p.item);

    // 1 contact entity, 2 message items (service message skipped)
    expect(entities.length).toBe(1);
    expect(items.length).toBe(2);

    expect(entities[0].entity!.name).toBe('Steve Berry');
    expect(entities[0].entity!.attributes![0]!.name).toBe('phone');
    expect(entities[0].entity!.attributes![0]!.value).toBe('+15559876543');
    expect(entities[0].entity!.attributes![0]!.identity).toBe(true);
    expect(entities[0].entity!.metadata!.Source).toBe('Telegram');
  });

  it("keeps a contact's number as Telegram wrote it, country code included", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-phones-'));
    const fpath = path.join(dir, 'result.json');
    fs.writeFileSync(
      fpath,
      JSON.stringify({
        personal_information: { user_id: 1, first_name: 'Zephyrine', phone_number: '+1 206 555 0147' },
        contacts: {
          list: [{ user_id: 5530912876, first_name: 'Mirabeau', last_name: 'Telfaire', phone_number: '+44 20 7946 0321' }],
        },
        chats: { list: [] },
      }),
    );
    const pipeline: EmittedGraph[] = [];

    try {
      await new TelegramFileImporter().fileImport({}, { filename: 'result.json', fullPath: fpath }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    const entity = pipeline.find((p) => p.entity)!.entity!;
    expect(entity.name).toBe('Mirabeau Telfaire');
    expect(entity.metadata).toMatchObject({ Source: 'Telegram', Phones: ['+44 20 7946 0321'] });
    expect(entity.accumulate).toEqual(['Phones']);
  });

  it('parses message metadata and joins text entity arrays', async () => {
    const fpath = path.join(FIXTURES_DIR, 'telegram-export', 'result.json');
    const fi = new TelegramFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'result.json', fullPath: fpath }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const items = pipeline.filter((p) => p.item);
    expect(items[0].item.classification).toBe('message');
    expect(items[0].item.metadata.Sender).toBe('Steve Berry');
    expect(items[0].item.metadata.Conversation).toBe('Steve Berry');
    expect(items[0].item.metadata.Source).toBe('Telegram');
    expect(items[0].item.timestamp).toBeDefined();

    // inbound: from the contact, To resolves to the owner, direction inbound
    expect(items[0].item.metadata.Direction).toBe('inbound');
    expect(items[0].item.metadata.To).toBe('Liam Broza');
    // outbound: from the owner, To resolves to the counterpart, direction outbound
    expect(items[1].item.metadata.Sender).toBe('Liam Broza');
    expect(items[1].item.metadata.Direction).toBe('outbound');
    expect(items[1].item.metadata.To).toBe('Steve Berry');

    // text array joined into a single string
    const text = (await items[1].item.content!.data!()).toString();
    expect(text).toBe('Yes — see https://example.com/agenda for the agenda.');
  });

  it('malformed input does not throw', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-'));
    const fpath = path.join(tmp, 'result.json');
    fs.writeFileSync(fpath, '{ this is not valid json \x00\xff [garbage');
    const fi = new TelegramFileImporter();
    const pipeline: EmittedGraph[] = [];
    await expect(
      fi.fileImport({}, { filename: 'result.json', fullPath: fpath }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams),
    ).resolves.toBeUndefined();
    expect(pipeline.length).toBe(0);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('assigns stable unique ids so same-second messages do not collapse', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-'));
    const fpath = path.join(tmp, 'result.json');
    const export1 = {
      about: 'x',
      personal_information: {},
      contacts: { list: [] },
      chats: {
        list: [
          {
            name: 'Steve Berry',
            type: 'personal_chat',
            id: 987654321,
            messages: [
              { id: 10, type: 'message', date_unixtime: '1723485300', from: 'A', text: 'first' },
              { id: 11, type: 'message', date_unixtime: '1723485300', from: 'B', text: 'second' },
              { id: 12, type: 'message', date_unixtime: '1723485300', from: 'A', text: 'third' },
            ],
          },
        ],
      },
    };
    fs.writeFileSync(fpath, JSON.stringify(export1));

    const fi = new TelegramFileImporter();
    const run = async () => {
      const pipeline: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: 'result.json', fullPath: fpath }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);

      return pipeline.filter((p) => p.item).map((p) => p.item.id!);
    };

    const ids = await run();
    expect(ids.length).toBe(3);
    // (a) every id truthy
    expect(ids.every((id) => !!id)).toBe(true);
    // (b) all ids distinct despite identical timestamp/filename/classification
    expect(new Set(ids).size).toBe(ids.length);
    // (c) re-import yields identical ids (idempotent)
    const ids2 = await run();
    expect(ids2).toEqual(ids);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('empty input yields no items', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-'));
    const fpath = path.join(tmp, 'result.json');
    fs.writeFileSync(
      fpath,
      JSON.stringify({ about: 'x', personal_information: {}, contacts: { list: [] }, chats: { list: [] } }),
    );
    const fi = new TelegramFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'result.json', fullPath: fpath }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);
    expect(pipeline.length).toBe(0);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

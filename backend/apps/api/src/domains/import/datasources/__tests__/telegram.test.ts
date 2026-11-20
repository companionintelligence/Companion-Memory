import fs from 'fs';
import os from 'os';
import path from 'path';

import '..';
import { dataSourcesRecognize } from '../registry';
import { TelegramFileImporter } from '../telegram';
import type { ImportParams } from '../timeline';

import { metaAttachments } from './support/emitted';
import type { EmittedGraph, TestPipeline } from './support/emitted';

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

describe('Telegram media messages', () => {
  // Telegram Desktop's JSON export: `photo` and `file` are paths relative to
  // the folder holding result.json, or a note when the export left them out.
  let root: string;

  /** A file beside the export folder, which a crafted reference could reach with `../`. */
  const outsideName = () => `${path.basename(root)}-outside.pdf`;

  const message = (id: number, extra: Record<string, unknown>) => ({
    id,
    type: 'message',
    date: '2026-07-14T19:22:05',
    date_unixtime: String(1784056925 + id),
    from: 'Ivo Brackenridge',
    from_id: 'user7311982204',
    text: '',
    text_entities: [],
    ...extra,
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-media-'));
    fs.mkdirSync(path.join(root, 'chats', 'chat_001', 'files'), { recursive: true });
    fs.mkdirSync(path.join(root, 'chats', 'chat_002', 'photos'), { recursive: true });
    fs.writeFileSync(path.join(root, 'chats', 'chat_001', 'files', 'ferry_timetable.pdf'), '%PDF-1.4');
    fs.writeFileSync(path.join(root, 'chats', 'chat_002', 'photos', 'photo_1@14-07-2026_19-22-05.jpg'), 'jpeg');
    fs.writeFileSync(path.join(root, 'chats', 'chat_002', 'photos', 'photo_2@14-07-2026_19-30-00.jpg'), 'jpeg');
    fs.writeFileSync(
      path.join(root, 'result.json'),
      JSON.stringify({
        about: 'Here is the data you requested.',
        personal_information: { user_id: 6120034581, first_name: 'Owner', last_name: 'Person' },
        chats: {
          list: [
            {
              name: 'Allotment Committee',
              type: 'private_group',
              id: 2002,
              messages: [
                message(1, {
                  text: 'plot 7 squash photo',
                  photo: 'chats/chat_002/photos/photo_1@14-07-2026_19-22-05.jpg',
                  width: 64,
                  height: 48,
                }),
                message(2, { photo: 'chats/chat_002/photos/photo_2@14-07-2026_19-30-00.jpg' }),
                message(3, {
                  text: 'timetable attached',
                  file: 'chats/chat_001/files/ferry_timetable.pdf',
                  file_name: 'ferry_timetable.pdf',
                  mime_type: 'application/pdf',
                }),
                message(4, {
                  file: '(File not included. Change data exporting settings to download.)',
                  media_type: 'sticker',
                  sticker_emoji: '👍',
                  mime_type: 'image/webp',
                }),
                message(5, { file: `../${outsideName()}`, file_name: 'outside.pdf', mime_type: 'application/pdf' }),
                message(6, {}),
              ],
            },
          ],
        },
      }),
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const run = async () => {
    const drops: string[] = [];
    const pipeline: TestPipeline = Object.assign([] as EmittedGraph[], {
      drop: (reason: string) => {
        drops.push(reason);
      },
    });
    await new TelegramFileImporter().fileImport({}, { filename: 'result.json', fullPath: path.join(root, 'result.json') }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const byId = new Map(pipeline.filter((p) => p.item).map((p) => [p.item.id, p.item]));

    return { byId, drops };
  };

  it('attaches the photo and the file to the messages they came with', async () => {
    const { byId } = await run();

    const photo = byId.get('telegram:2002:1')!;
    expect(photo.metadata.Text).toBe('plot 7 squash photo');
    expect(metaAttachments(photo.metadata.MediaAttachments)).toEqual([
      {
        path: path.join(root, 'chats', 'chat_002', 'photos', 'photo_1@14-07-2026_19-22-05.jpg'),
        filename: 'photo_1@14-07-2026_19-22-05.jpg',
        type: 'image',
        mimetype: 'image/jpeg',
      },
    ]);
    expect(photo.metadata.AttachmentContent).toBe(true);

    const pdf = byId.get('telegram:2002:3')!;
    expect(metaAttachments(pdf.metadata.MediaAttachments)).toEqual([
      {
        path: path.join(root, 'chats', 'chat_001', 'files', 'ferry_timetable.pdf'),
        filename: 'ferry_timetable.pdf',
        type: 'file',
        mimetype: 'application/pdf',
      },
    ]);
  });

  it('keeps a photo sent without a caption, and a sticker the export left out', async () => {
    const { byId, drops } = await run();

    const uncaptioned = byId.get('telegram:2002:2')!;
    expect(uncaptioned.metadata.Text).toBeUndefined();
    expect(metaAttachments(uncaptioned.metadata.MediaAttachments)[0]?.path).toBe(
      path.join(root, 'chats', 'chat_002', 'photos', 'photo_2@14-07-2026_19-30-00.jpg'),
    );

    // No bytes to upload, but the message says what was sent.
    expect(metaAttachments(byId.get('telegram:2002:4')!.metadata.MediaAttachments)).toEqual([
      { type: 'image', mimetype: 'image/webp' },
    ]);

    // Only the message with neither text nor media is dropped.
    expect(byId.has('telegram:2002:6')).toBe(false);
    expect(drops).toEqual(['empty_after_parse']);
  });

  it('never points an attachment outside the export folder', async () => {
    const outside = path.join(root, '..', outsideName());
    fs.writeFileSync(outside, '%PDF-1.4');
    try {
      const { byId } = await run();

      expect(metaAttachments(byId.get('telegram:2002:5')!.metadata.MediaAttachments)).toEqual([
        { filename: 'outside.pdf', type: 'file', mimetype: 'application/pdf' },
      ]);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('is recognized as the whole export folder, so its media are not imported again as loose files', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-upload-'));
    try {
      fs.renameSync(root, path.join(parent, 'DataExport_2026-11-18'));
      root = path.join(parent, 'DataExport_2026-11-18');

      const matches = await dataSourcesRecognize(
        undefined,
        { filename: path.basename(parent), fullPath: parent, fsRoot: parent },
        {},
        { descend: true },
      );
      const telegram = matches.filter((m) => m.data_source.name === 'telegram');

      expect(telegram.map((m) => m.matchedPath)).toEqual([root]);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

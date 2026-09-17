import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import type { StagedItem } from '../../entities/StagedItemEntity';
import { destinationsFor, toCanonical } from '../../push/canonical';
import { toBrowserActivityInput, toCommunicationInput, toEventInput } from '../../push/inputs';
import { MacosActivityFileImporter } from '../macos_activity';
import { appleDate } from '../macosActivityRecords';
import type { Item } from '../timeline';

const START = (Date.parse('2026-09-01T10:45:00Z') - Date.UTC(2001, 0, 1)) / 1000;
const DEVICE = 'a'.repeat(64);
const importer = new MacosActivityFileImporter();
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'ci-macos-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function manifest(sources = [{ name: 'knowledge', status: 'ok' }], deviceId = DEVICE) {
  await writeFile(
    path.join(root, 'macos-activity.json'),
    JSON.stringify({
      format: 'ci-macos-activity',
      version: 1,
      deviceId,
      exportedAt: '2026-09-15T12:00:00+00:00',
      sources,
    }),
  );
}

function database(name: string, sql: string) {
  const db = new Database(path.join(root, `${name}.sqlite`));
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

function knowledge() {
  database(
    'knowledge',
    `CREATE TABLE ZOBJECT (Z_PK INTEGER, ZSTREAMNAME TEXT,
    ZSTARTDATE REAL, ZENDDATE REAL, ZVALUESTRING TEXT, ZVALUEINTEGER INTEGER);
    INSERT INTO ZOBJECT VALUES (1, '/app/usage', ${START}, ${START + 1800}, 'com.apple.Xcode', NULL);`,
  );
}

function canonical(item: Item) {
  return toCanonical({
    dataSource: 'macos_activity',
    contentHash: item.id!,
    classification: item.classification!,
    occurredAt: item.timestamp!,
    timespanEnd: item.timespanEnd ?? null,
    createdAt: new Date('2026-09-15T12:00:00Z'),
    metadata: item.metadata ?? {},
    filename: null,
    mediaType: null,
    latitude: null,
    longitude: null,
    originalLocation: null,
    intermediateLocation: null,
  } as StagedItem);
}

function capture() {
  const items: Item[] = [];
  const drop = jest.fn();
  const consumed = jest.fn();

  return {
    items,
    params: {
      pipeline: {
        push: (g: { item?: Item }) => {
          if (g.item) {
            items.push(g.item);
          }
        },
        drop,
        consumed,
      },
    },
  };
}

it('recognizes a versioned snapshot and routes original app spans into events', async () => {
  await manifest();
  knowledge();
  const entry = { filename: 'snapshot', fullPath: root };
  expect((await importer.recognize(null, entry)).confidence).toBe(1);
  const { items, params } = capture();
  await importer.fileImport(null, entry, params);
  const record = canonical(items[0]);
  expect(destinationsFor(record)).toEqual(['events']);
  expect(toEventInput(record)).toMatchObject({
    title: 'App usage: com.apple.Xcode',
    start_time: new Date('2026-09-01T10:45:00Z'),
    end_time: new Date('2026-09-01T11:15:00Z'),
    event_type: 'macos_activity',
    source_system: 'macos_activity',
    metadata: { Stream: '/app/usage', DurationSeconds: 1800, DeviceId: DEVICE },
  });
  expect(params.pipeline.consumed).toHaveBeenCalledWith(1);
  const again = capture();
  await importer.fileImport(null, entry, again.params);
  expect(again.items[0].id).toBe(items[0].id);
  await manifest(undefined, 'b'.repeat(64));
  const otherDevice = capture();
  await importer.fileImport(null, entry, otherDevice.params);
  expect(otherDevice.items[0].id).not.toBe(items[0].id);
});

it('routes Safari visits and call durations to existing summary sources', async () => {
  await manifest([
    { name: 'safari', status: 'ok' },
    { name: 'calls', status: 'ok' },
  ]);
  database(
    'safari',
    `CREATE TABLE history_items (id INTEGER, url TEXT);
    CREATE TABLE history_visits (id INTEGER, history_item INTEGER, visit_time REAL, title TEXT);
    INSERT INTO history_items VALUES (1, 'https://developer.apple.com/');
    INSERT INTO history_visits VALUES (2, 1, ${START}, 'Apple Developer');`,
  );
  database(
    'calls',
    `CREATE TABLE ZCALLRECORD (Z_PK INTEGER, ZDATE REAL, ZDURATION REAL,
    ZORIGINATED INTEGER, ZANSWERED INTEGER, ZADDRESS TEXT);
    INSERT INTO ZCALLRECORD VALUES (3, ${START}, 120, 1, 1, '+15550100000');`,
  );
  const { items, params } = capture();
  await importer.fileImport(null, { filename: root }, params);
  expect(destinationsFor(canonical(items[0]))).toEqual(['browser_activity']);
  expect(toBrowserActivityInput(canonical(items[0]))).toMatchObject({
    title: 'Apple Developer',
    url: 'https://developer.apple.com/',
  });
  expect(destinationsFor(canonical(items[1]))).toEqual(['communications']);
  expect(toCommunicationInput(canonical(items[1]))).toMatchObject({
    communication_type: 'call',
    direction: 'outbound',
    duration_seconds: 120,
  });
});

it('reports invalid dates, unknown streams, and timeframe exclusions without inventing events', async () => {
  await manifest();
  knowledge();
  const db = new Database(path.join(root, 'knowledge.sqlite'));
  db.exec(`INSERT INTO ZOBJECT VALUES (2, '/app/usage', NULL, NULL, 'bad', NULL);
    INSERT INTO ZOBJECT VALUES (3, '/unknown', ${START}, NULL, 'unknown', NULL);`);
  db.close();
  const { items, params } = capture();
  await importer.fileImport(
    null,
    { filename: root },
    { ...params, timeframe: { since: new Date('2026-09-02') } },
  );
  expect(items).toHaveLength(0);
  expect(params.pipeline.drop.mock.calls.map(([reason]) => reason)).toEqual([
    'outside_timeframe',
    'invalid_timestamp',
    'macos_unsupported_stream',
  ]);
  for (const value of [null, undefined, '', '100', Number.NaN, Infinity, -1, 1e20]) {
    expect(appleDate(value)).toBeUndefined();
  }
});

it('preserves good sources but fails visibly on a missing schema or unavailable source', async () => {
  await manifest([
    { name: 'calls', status: 'ok' },
    { name: 'knowledge', status: 'ok' },
    { name: 'safari', status: 'unavailable' },
  ]);
  knowledge();
  database('calls', 'CREATE TABLE unexpected (id INTEGER)');
  const { items, params } = capture();
  await expect(importer.fileImport(null, { filename: root }, params)).rejects.toThrow(
    /Unsupported macOS schema.*safari: unavailable/,
  );
  expect(items).toHaveLength(1);
});

it('keeps optional web domains and readable zero-valued device states', async () => {
  await manifest();
  database(
    'knowledge',
    `CREATE TABLE ZOBJECT (Z_PK INTEGER, ZSTREAMNAME TEXT,
    ZSTARTDATE REAL, ZENDDATE REAL, ZVALUESTRING TEXT, ZVALUEINTEGER INTEGER, ZSTRUCTUREDMETADATA INTEGER);
    CREATE TABLE ZSTRUCTUREDMETADATA (Z_PK INTEGER, Z_DKDIGITALHEALTHMETADATAKEY__WEBDOMAIN TEXT);
    INSERT INTO ZSTRUCTUREDMETADATA VALUES (1, 'developer.apple.com');
    INSERT INTO ZOBJECT VALUES (1, '/app/webUsage', ${START}, ${START + 60}, 'com.apple.Safari', NULL, 1);
    INSERT INTO ZOBJECT VALUES (2, '/device/isLocked', ${START}, NULL, NULL, 0, NULL);
    INSERT INTO ZOBJECT VALUES (3, '/display/isBacklit', ${START}, NULL, NULL, 1, NULL);
    INSERT INTO ZOBJECT VALUES (4, '/app/usage', ${START}, ${START - 60}, 'invalid span', NULL, NULL);`,
  );
  const { items, params } = capture();
  await importer.fileImport(null, { filename: root }, params);
  expect(items.map((item) => item.metadata?.Title)).toEqual([
    'Web usage: developer.apple.com',
    'Device locked state: unlocked',
    'Display backlight state: on',
  ]);
  expect(params.pipeline.drop).toHaveBeenCalledWith('invalid_timestamp');
});

it('rejects a database symlink escaping the snapshot', async () => {
  await manifest();
  await symlink(path.join(root, '..'), path.join(root, 'knowledge.sqlite'));
  const { params } = capture();
  await expect(importer.fileImport(null, { filename: root }, params)).rejects.toThrow(
    'Snapshot database must be inside the export directory',
  );
});

it('claims an unsupported version so import fails instead of falling back to raw-file ingestion', async () => {
  await writeFile(
    path.join(root, 'macos-activity.json'),
    JSON.stringify({ format: 'ci-macos-activity', version: 2 }),
  );
  expect((await importer.recognize(null, { filename: root })).confidence).toBe(1);
  await expect(importer.fileImport(null, { filename: root }, capture().params)).rejects.toThrow();
  await writeFile(path.join(root, 'macos-activity.json'), '{}');
  expect((await importer.recognize(null, { filename: root })).confidence).toBe(0);
});

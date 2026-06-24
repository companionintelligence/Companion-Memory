import { Readable, Writable } from 'node:stream';

import type { DataSource } from 'typeorm';

import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';

import { CommunicationCreatedEvent } from '../../events';
import { type BulkEventEmitter, BulkIngestService } from '../../services/BulkIngestService';
import { communicationsBulkSpec } from '../../services/bulkTableSpecs';

// --- Mock pg-copy-streams so the COPY "sink" is an in-memory collector that
// finishes on its own (real pg drives the CopyStreamQuery; here we don't have a
// socket). We capture everything written so we can assert the COPY payload.
const copyChunks: string[] = [];
jest.mock('pg-copy-streams', () => ({
  from: jest.fn((text: string) => {
    const sink = new Writable({
      write(chunk, _enc, cb) {
        copyChunks.push(chunk.toString());
        cb();
      },
    });
    (sink as unknown as { copyText: string }).copyText = text;

    return sink;
  }),
}));

const USER = '11111111-1111-1111-1111-111111111111';

const emitter: BulkEventEmitter<typeof CommunicationCreatedEvent> = {
  event: CommunicationCreatedEvent,
  payload: (id) => ({ communicationId: id }),
};

interface Harness {
  service: BulkIngestService;
  send: jest.Mock;
  queries: { sql: string; params?: unknown[] }[];
  released: () => boolean;
  rolledBack: () => boolean;
  committed: () => boolean;
}

function makeHarness(opts: { insertReturning?: Record<string, string>[]; failCopy?: boolean }): Harness {
  const queries: { sql: string; params?: unknown[] }[] = [];
  let released = false;
  let rolledBack = false;
  let committed = false;

  // The raw pg client backing the query runner. Its .query(copyStream) returns
  // the same writable so stream/promises.pipeline can drive it to 'finish'.
  const client = {
    query: (copyStream: Writable) => {
      if (opts.failCopy) {
        // Surface a write error the same way a broken COPY would.
        process.nextTick(() => copyStream.destroy(new Error('copy failed')));
      }

      return copyStream;
    },
  };

  const queryRunner = {
    connect: jest.fn(async () => client),
    startTransaction: jest.fn(async () => undefined),
    commitTransaction: jest.fn(async () => {
      committed = true;
    }),
    rollbackTransaction: jest.fn(async () => {
      rolledBack = true;
    }),
    release: jest.fn(async () => {
      released = true;
    }),
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (/INSERT INTO ci\.communications/.test(sql)) {
        return opts.insertReturning ?? [];
      }

      return [];
    }),
  };

  const dataSource = {
    createQueryRunner: () => queryRunner,
  } as unknown as DataSource;

  const send = jest.fn(async () => ['job-id']);
  const signalling = { send } as unknown as EventService;
  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as LoggerService;

  return {
    service: new BulkIngestService(dataSource, signalling, logger),
    send,
    queries,
    released: () => released,
    rolledBack: () => rolledBack,
    committed: () => committed,
  };
}

const ndjson = (lines: string[]) => Readable.from([lines.join('\n')]);

const comm = (sourceId: string | null) =>
  JSON.stringify({
    time: '2026-01-02T03:04:05.000Z',
    communication_type: 'email',
    direction: 'inbound',
    content: `body ${sourceId}`,
    ...(sourceId ? { source_type: 'import', source_system: 'gmail', source_id: sourceId } : {}),
  });

beforeEach(() => {
  copyChunks.length = 0;
});

describe('BulkIngestService.ingest', () => {
  it('copies valid rows, runs the fold with $1=userId, and counts inserted', async () => {
    const h = makeHarness({ insertReturning: [{ id: 'c1' }, { id: 'c2' }] });

    const res = await h.service.ingest(USER, ndjson([comm('a'), comm('b')]), communicationsBulkSpec, emitter);

    expect(res.received).toBe(2);
    expect(res.inserted).toBe(2);
    expect(res.deduped).toBe(0);
    expect(res.rejected).toEqual([]);

    // Staging table created, COPY ran, fold bound userId as $1.
    const insert = h.queries.find((q) => /INSERT INTO ci\.communications/.test(q.sql));
    expect(insert?.params).toEqual([USER]);
    expect(h.queries.some((q) => /CREATE TEMP TABLE bulk_stage_communications/.test(q.sql))).toBe(true);

    // COPY payload carries both encoded rows.
    const copied = copyChunks.join('');
    expect(copied).toContain('email\tinbound\tbody a');
    expect(copied).toContain('email\tinbound\tbody b');

    expect(h.committed()).toBe(true);
    expect(h.released()).toBe(true);
  });

  it('emits one CommunicationCreatedEvent per newly-inserted row (post-commit)', async () => {
    const h = makeHarness({ insertReturning: [{ id: 'c1' }, { id: 'c2' }] });

    await h.service.ingest(USER, ndjson([comm('a'), comm('b')]), communicationsBulkSpec, emitter);

    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.send).toHaveBeenCalledWith(CommunicationCreatedEvent, { communicationId: 'c1' });
    expect(h.send).toHaveBeenCalledWith(CommunicationCreatedEvent, { communicationId: 'c2' });
  });

  it('counts ON CONFLICT skips as deduped and emits no event for them', async () => {
    // 2 valid rows in, only 1 returned by INSERT (the other hit the triple).
    const h = makeHarness({ insertReturning: [{ id: 'c1' }] });

    const res = await h.service.ingest(USER, ndjson([comm('a'), comm('b')]), communicationsBulkSpec, emitter);

    expect(res.received).toBe(2);
    expect(res.inserted).toBe(1);
    expect(res.deduped).toBe(1);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('records a malformed line in rejected but still loads the rest', async () => {
    const h = makeHarness({ insertReturning: [{ id: 'c1' }] });

    const res = await h.service.ingest(
      USER,
      ndjson(['not json', comm('a')]),
      communicationsBulkSpec,
      emitter,
    );

    expect(res.received).toBe(2);
    expect(res.rejected).toEqual([{ line: 1, reason: 'invalid JSON' }]);
    expect(res.inserted).toBe(1);
    // Only the valid row was copied.
    expect(copyChunks.join('')).toContain('body a');
    expect(copyChunks.join('')).not.toContain('not json');
  });

  it('rejects a schema-invalid line (bad enum) without aborting the batch', async () => {
    const h = makeHarness({ insertReturning: [{ id: 'c1' }] });
    const bad = JSON.stringify({
      time: '2026-01-02T03:04:05.000Z',
      communication_type: 'telepathy',
      direction: 'inbound',
      content: 'x',
    });

    const res = await h.service.ingest(USER, ndjson([bad, comm('a')]), communicationsBulkSpec, emitter);

    expect(res.received).toBe(2);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0].line).toBe(1);
    expect(res.inserted).toBe(1);
  });

  it('tolerates blank lines (not counted as received)', async () => {
    const h = makeHarness({ insertReturning: [{ id: 'c1' }] });

    const res = await h.service.ingest(USER, ndjson(['', comm('a'), '']), communicationsBulkSpec, emitter);

    expect(res.received).toBe(1);
    expect(res.inserted).toBe(1);
  });

  it('rolls back and rethrows if the COPY stream fails; emits nothing', async () => {
    const h = makeHarness({ failCopy: true });

    await expect(
      h.service.ingest(USER, ndjson([comm('a')]), communicationsBulkSpec, emitter),
    ).rejects.toThrow('copy failed');

    expect(h.rolledBack()).toBe(true);
    expect(h.released()).toBe(true);
    expect(h.send).not.toHaveBeenCalled();
  });
});

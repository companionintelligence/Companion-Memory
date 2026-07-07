import { Readable } from 'node:stream';

import { BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';

import { NDJSON_MAX_REJECTED_DETAILS, ingestNdjsonStream, isNdjsonRequest } from '../ndjson';

const recordSchema = z.object({ n: z.number() });

/** Build a fake streaming request from raw body chunks. */
function reqFrom(chunks: (string | Buffer)[]): Request {
  const req = Readable.from(
    chunks.map((chunk) => (typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk)),
    { objectMode: false },
  );

  return Object.assign(req, { headers: { 'content-type': 'application/x-ndjson' } }) as unknown as Request;
}

const line = (n: number) => `${JSON.stringify({ n })}\n`;

describe('isNdjsonRequest', () => {
  it('matches application/x-ndjson, with or without parameters, case-insensitively', () => {
    expect(isNdjsonRequest({ headers: { 'content-type': 'application/x-ndjson' } })).toBe(true);
    expect(isNdjsonRequest({ headers: { 'content-type': 'Application/X-NDJSON; charset=utf-8' } })).toBe(
      true,
    );
  });

  it('does not match JSON or absent content types', () => {
    expect(isNdjsonRequest({ headers: { 'content-type': 'application/json' } })).toBe(false);
    expect(isNdjsonRequest({ headers: {} })).toBe(false);
  });
});

describe('ingestNdjsonStream', () => {
  it('flushes batches of batchSize as the stream arrives and sums the summary', async () => {
    const flush = jest.fn(async (records: { n: number }[]) => records.length);
    const body = Array.from({ length: 2500 }, (_, i) => line(i)).join('');

    const res = await ingestNdjsonStream(reqFrom([body]), recordSchema, flush, { batchSize: 1000 });

    expect(flush).toHaveBeenCalledTimes(3);
    expect(flush.mock.calls.map((call) => call[0].length)).toEqual([1000, 1000, 500]);
    // Batches arrive in stream order.
    expect(flush.mock.calls[0][0][0]).toEqual({ n: 0 });
    expect(flush.mock.calls[2][0][499]).toEqual({ n: 2499 });
    expect(res).toEqual({ ingested: 2500, duplicate: 0, rejected: [] });
  });

  it('reassembles records split across chunk boundaries', async () => {
    const flush = jest.fn(async (records: unknown[]) => records.length);
    // Split mid-record and mid-number.
    const chunks = ['{"n"', ': 1}\n{"n": 2', '2}\n{"n": 3}'];

    const res = await ingestNdjsonStream(reqFrom(chunks), recordSchema, flush);

    expect(res).toEqual({ ingested: 3, duplicate: 0, rejected: [] });
    expect(flush.mock.calls[0][0]).toEqual([{ n: 1 }, { n: 22 }, { n: 3 }]);
  });

  it('counts records the flush did not accept as duplicate', async () => {
    const flush = jest.fn(async (records: unknown[]) => records.length - 1);

    const res = await ingestNdjsonStream(reqFrom([line(1) + line(1) + line(2)]), recordSchema, flush);

    expect(res).toEqual({ ingested: 2, duplicate: 1, rejected: [] });
  });

  it('rejects malformed and schema-invalid lines with 1-based numbers and continues', async () => {
    const flush = jest.fn(async (records: unknown[]) => records.length);
    const body = [line(1), 'not json\n', '{"n":"NaN"}\n', line(4)].join('');

    const res = await ingestNdjsonStream(reqFrom([body]), recordSchema, flush);

    expect(res.ingested).toBe(2);
    expect(res.rejected).toEqual([
      { line: 2, reason: expect.stringContaining('invalid JSON') },
      { line: 3, reason: expect.stringContaining('validation failed: n:') },
    ]);
  });

  it('tolerates blank lines and CRLF while still counting them toward line numbers', async () => {
    const flush = jest.fn(async (records: unknown[]) => records.length);
    const body = `${JSON.stringify({ n: 1 })}\r\n\r\n\nbad\n${JSON.stringify({ n: 2 })}`;

    const res = await ingestNdjsonStream(reqFrom([body]), recordSchema, flush);

    expect(res.ingested).toBe(2);
    // Lines: 1 = record, 2 = blank (CR), 3 = blank, 4 = bad, 5 = record (no trailing newline).
    expect(res.rejected).toEqual([{ line: 4, reason: expect.stringContaining('invalid JSON') }]);
  });

  it('processes a final line that has no trailing newline', async () => {
    const flush = jest.fn(async (records: unknown[]) => records.length);

    const res = await ingestNdjsonStream(reqFrom(['{"n": 1}\n{"n": 2}']), recordSchema, flush);

    expect(res.ingested).toBe(2);
  });

  it('rejects an oversized line without buffering it and keeps streaming', async () => {
    const flush = jest.fn(async (records: unknown[]) => records.length);
    // maxLineLength 32; the oversized line spans several chunks.
    const oversized = `{"n": 1, "pad": "${'x'.repeat(100)}"}`;
    const chunks = [
      line(1),
      oversized.slice(0, 40),
      oversized.slice(40, 80),
      `${oversized.slice(80)}\n`,
      line(3),
    ];

    const res = await ingestNdjsonStream(reqFrom(chunks), recordSchema, flush, { maxLineLength: 32 });

    expect(res.ingested).toBe(2);
    expect(res.rejected).toEqual([{ line: 2, reason: expect.stringContaining('exceeds') }]);
  });

  it('rejects an oversized line that arrives complete within one chunk', async () => {
    const flush = jest.fn(async (records: unknown[]) => records.length);
    const body = `${line(1)}{"n": 2, "pad": "${'x'.repeat(100)}"}\n${line(3)}`;

    const res = await ingestNdjsonStream(reqFrom([body]), recordSchema, flush, { maxLineLength: 32 });

    expect(res.ingested).toBe(2);
    expect(res.rejected).toEqual([{ line: 2, reason: expect.stringContaining('exceeds') }]);
  });

  it('rejects the lines of a failed batch and continues with later batches', async () => {
    const flush = jest
      .fn(async (records: unknown[]) => records.length)
      .mockRejectedValueOnce(new Error('deadlock detected'));
    const body = Array.from({ length: 5 }, (_, i) => line(i)).join('');

    const res = await ingestNdjsonStream(reqFrom([body]), recordSchema, flush, { batchSize: 2 });

    expect(flush).toHaveBeenCalledTimes(3);
    expect(res.ingested).toBe(3);
    expect(res.rejected).toEqual([
      { line: 1, reason: expect.stringContaining('deadlock detected') },
      { line: 2, reason: expect.stringContaining('deadlock detected') },
    ]);
  });

  it('caps stored rejection details and flags truncation', async () => {
    const flush = jest.fn(async (records: unknown[]) => records.length);
    const body = Array.from({ length: NDJSON_MAX_REJECTED_DETAILS + 5 }, () => 'bad\n').join('');

    const res = await ingestNdjsonStream(reqFrom([body]), recordSchema, flush);

    expect(res.rejected).toHaveLength(NDJSON_MAX_REJECTED_DETAILS);
    expect(res.rejectedTruncated).toBe(true);
  });

  it('unwinds (no hang, no final flush) when the client aborts mid-stream', async () => {
    const flush = jest.fn(async (records: unknown[]) => records.length);

    let pushed = false;
    const req = new Readable({
      read() {
        if (!pushed) {
          pushed = true;
          this.push(line(1));
          // Simulate the socket dying before the stream ends.
          process.nextTick(() => this.destroy(new Error('socket hang up')));
        }
      },
    });
    Object.assign(req, { headers: { 'content-type': 'application/x-ndjson' } });

    await expect(ingestNdjsonStream(req as unknown as Request, recordSchema, flush)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    // The buffered partial batch is NOT flushed — the client retries the whole
    // stream, which is safe because flushes are idempotent.
    expect(flush).not.toHaveBeenCalled();
  });

  it("treats an 'aborted' event followed by a quiet stream end as premature", async () => {
    const flush = jest.fn(async (records: unknown[]) => records.length);
    const req = new Readable({ read() {} });
    Object.assign(req, { headers: { 'content-type': 'application/x-ndjson' } });

    const promise = ingestNdjsonStream(req as unknown as Request, recordSchema, flush);

    // Older-Node abort behavior: 'aborted' fires, then the stream just ends
    // without an error.
    req.push(line(1));
    req.emit('aborted');
    req.push(null);

    await expect(promise).rejects.toBeInstanceOf(BadRequestException);
    expect(flush).not.toHaveBeenCalled();
  });

  it('returns an empty summary for an empty stream', async () => {
    const flush = jest.fn(async (records: unknown[]) => records.length);

    const res = await ingestNdjsonStream(reqFrom([]), recordSchema, flush);

    expect(res).toEqual({ ingested: 0, duplicate: 0, rejected: [] });
    expect(flush).not.toHaveBeenCalled();
  });
});

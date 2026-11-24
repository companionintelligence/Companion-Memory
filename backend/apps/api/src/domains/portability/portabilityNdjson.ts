import type { Writable } from 'node:stream';

import { BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod/v3';

/** Same content type as bulk ingest — BodyParserMiddleware leaves the stream raw. */
export const PORTABILITY_NDJSON_CONTENT_TYPE = 'application/x-ndjson';

/** ~3 MiB raw bytes → ~4 MiB base64, kept under typical line limits. */
export const FILE_CHUNK_BYTES = 3 * 1024 * 1024;

/** Per-line ceiling for NDJSON portability streams (base64 file chunks). */
export const PORTABILITY_MAX_LINE_LENGTH = 8 * 1024 * 1024;

/**
 * The NDJSON archive version this server writes. Version 2 ends with an `end`
 * record and an import refuses a version-2 archive that stops before it.
 * Version 1 (no end record) is still read, so older exports keep importing.
 */
export const PORTABILITY_NDJSON_VERSION = 2 as const;

export const portabilityManifestSchema = z.object({
  type: z.literal('manifest'),
  // Every version an import reads, spelled out: tying the last one to
  // PORTABILITY_NDJSON_VERSION would drop version 2 the day the constant moves on.
  version: z.union([z.literal(1), z.literal(2)]),
  format: z.literal('ndjson'),
  exportedAt: z.string(),
  userId: z.string().uuid(),
  profile: z.record(z.string(), z.unknown()).nullable(),
});

export const portabilityRowSchema = z.object({
  type: z.literal('row'),
  table: z.string().min(1),
  row: z.record(z.string(), z.unknown()),
});

export const portabilityFileChunkSchema = z.object({
  type: z.literal('file-chunk'),
  id: z.string().min(1),
  bucket: z.string().min(1),
  key: z.string().min(1),
  index: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  data: z.string(),
});

/**
 * The last record of a version-2 archive, with how many rows and whole files
 * came before it. Without it a download cut between two records still parses
 * as a complete, smaller archive.
 */
export const portabilityEndSchema = z.object({
  type: z.literal('end'),
  rows: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
});

export const portabilityStreamRecordSchema = z.discriminatedUnion('type', [
  portabilityManifestSchema,
  portabilityRowSchema,
  portabilityFileChunkSchema,
  portabilityEndSchema,
]);

export type PortabilityStreamRecord = z.infer<typeof portabilityStreamRecordSchema>;

export function serializePortabilityLine(record: PortabilityStreamRecord): string {
  return JSON.stringify(record);
}

/**
 * Write one record as a line. When the stream's buffer is full, wait until it
 * drains. Rejects once the stream is closed or destroyed (the download was
 * cancelled or the connection dropped), so a writer looping over records stops
 * instead of queueing the rest of the archive in memory.
 */
export async function writePortabilityLine(out: Writable, record: PortabilityStreamRecord): Promise<void> {
  if (out.destroyed || out.writableEnded) {
    throw new Error('The export stream is closed');
  }

  if (out.write(`${serializePortabilityLine(record)}\n`)) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const onDrain = () => {
      out.off('close', onClose);
      resolve();
    };

    const onClose = () => {
      out.off('drain', onDrain);
      reject(new Error('The export stream closed before it drained'));
    };

    out.once('drain', onDrain);
    out.once('close', onClose);
  });
}

/**
 * Re-cut a byte stream into pieces of exactly `size` bytes, the last one
 * shorter. Holds at most one piece in memory, whatever the stream's length.
 */
export async function* fixedSizeChunks(
  source: AsyncIterable<Uint8Array>,
  size: number,
): AsyncGenerator<Buffer> {
  // A size of 0 never shrinks what is left of a piece, so the loop below would
  // yield empty buffers forever.
  if (!Number.isInteger(size) || size <= 0) {
    throw new RangeError(`Chunk size must be a positive whole number of bytes, got ${size}`);
  }

  let pending: Buffer[] = [];
  let pendingBytes = 0;

  for await (const piece of source) {
    let rest = Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength);

    while (pendingBytes + rest.length >= size) {
      const take = size - pendingBytes;

      pending.push(rest.subarray(0, take));
      yield Buffer.concat(pending, size);
      pending = [];
      pendingBytes = 0;
      rest = rest.subarray(take);
    }

    if (rest.length > 0) {
      pending.push(rest);
      pendingBytes += rest.length;
    }
  }

  if (pendingBytes > 0) {
    yield Buffer.concat(pending, pendingBytes);
  }
}

export function isPortabilityNdjsonImport(req: Pick<Request, 'headers'>): boolean {
  const contentType = req.headers['content-type'];

  return (
    typeof contentType === 'string' &&
    contentType.split(';')[0].trim().toLowerCase() === PORTABILITY_NDJSON_CONTENT_TYPE
  );
}

export async function readPortabilityNdjsonStream(
  req: Request,
  onRecord: (record: PortabilityStreamRecord, line: number) => Promise<void>,
): Promise<{ lines: number }> {
  let currentLine = 1;
  let buffer = '';
  const discardingOversized = false;
  let lines = 0;

  const processCompleteLine = async (text: string) => {
    if (text.length > PORTABILITY_MAX_LINE_LENGTH) {
      throw new BadRequestException(`Export line ${currentLine} exceeds the size limit`);
    }

    const trimmed = text.trim();

    if (trimmed.length === 0) {
      return;
    }

    let parsedJson: unknown;

    try {
      parsedJson = JSON.parse(trimmed);
    } catch (err) {
      throw new BadRequestException(
        `Invalid JSON on line ${currentLine}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const result = portabilityStreamRecordSchema.safeParse(parsedJson);

    if (!result.success) {
      const issue = result.error.issues[0];
      throw new BadRequestException(
        `Invalid export record on line ${currentLine}: ${issue.path.join('.')}: ${issue.message}`,
      );
    }

    await onRecord(result.data, currentLine);
    lines += 1;
  };

  req.setEncoding('utf8');

  for await (const chunk of req as AsyncIterable<string>) {
    let start = 0;

    for (;;) {
      const newline = chunk.indexOf('\n', start);

      if (newline === -1) {
        if (!discardingOversized) {
          buffer += chunk.slice(start);

          if (buffer.length > PORTABILITY_MAX_LINE_LENGTH) {
            throw new BadRequestException(`Export line ${currentLine} exceeds the size limit`);
          }
        }

        break;
      }

      if (!discardingOversized) {
        const text = buffer + chunk.slice(start, newline);
        buffer = '';
        await processCompleteLine(text);
      }

      currentLine += 1;
      start = newline + 1;
    }
  }

  if (buffer.length > 0) {
    await processCompleteLine(buffer);
  }

  return { lines };
}

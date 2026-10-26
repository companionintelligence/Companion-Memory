import { BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod/v3';

/** Same content type as bulk ingest — BodyParserMiddleware leaves the stream raw. */
export const PORTABILITY_NDJSON_CONTENT_TYPE = 'application/x-ndjson';

/** ~3 MiB raw bytes → ~4 MiB base64, kept under typical line limits. */
export const FILE_CHUNK_BYTES = 3 * 1024 * 1024;

/** Per-line ceiling for NDJSON portability streams (base64 file chunks). */
export const PORTABILITY_MAX_LINE_LENGTH = 8 * 1024 * 1024;

export const portabilityManifestSchema = z.object({
  type: z.literal('manifest'),
  version: z.literal(1),
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

export const portabilityStreamRecordSchema = z.discriminatedUnion('type', [
  portabilityManifestSchema,
  portabilityRowSchema,
  portabilityFileChunkSchema,
]);

export type PortabilityStreamRecord = z.infer<typeof portabilityStreamRecordSchema>;

export function serializePortabilityLine(record: PortabilityStreamRecord): string {
  return JSON.stringify(record);
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

import { BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import type { z } from 'zod';

/**
 * NDJSON streaming for the `/v1` bulk-ingest routes.
 *
 * `Content-Type: application/x-ndjson` is the DEFAULT bulk contract: one JSON
 * record per line (the same per-kind record schema the `{ records: [...] }`
 * envelope validates), parsed incrementally off the raw request stream and
 * flushed to the destination bulk service in batches of
 * {@link NDJSON_BATCH_SIZE} — so memory stays bounded no matter how long the
 * stream runs, and rows start landing while the client is still sending.
 *
 * The raw stream reaches the route handler because BodyParserMiddleware
 * explicitly bypasses `application/x-ndjson` on `/v1/*` (and the Nest default
 * body parser is disabled globally in main.ts), so nothing upstream has
 * consumed `req` when the handler starts iterating it. Auth still runs first:
 * Nest middleware → guards → route handler, and the middleware never reads the
 * body, so a 401 from JwtOrApiKeyAuthGuard is issued before a single byte of
 * the stream is consumed.
 */

/** Content type that switches the /v1 bulk routes into streaming mode. */
export const NDJSON_CONTENT_TYPE = 'application/x-ndjson';

/**
 * Records buffered before each service flush. 1,000 sits well under the
 * envelope path's 10,000-record cap and keeps every flush comfortably inside
 * the services' internal bind-param chunking.
 */
export const NDJSON_BATCH_SIZE = 1000;

/**
 * Defensive per-line ceiling (in UTF-16 code units — ~1 MB for ASCII payloads).
 * NDJSON requests carry no overall size cap (that's the point of streaming),
 * so this is what stops a single pathological line from buffering unbounded
 * memory. Oversized lines are rejected and skipped; the stream continues.
 */
export const NDJSON_MAX_LINE_LENGTH = 1024 * 1024;

/**
 * Cap on stored per-line rejection details, so a pathological stream (every
 * line malformed, unbounded length) can't grow the response without bound.
 * Overflow is signalled via `rejectedTruncated: true`.
 */
export const NDJSON_MAX_REJECTED_DETAILS = 1000;

/**
 * Summary returned once the stream ends. Same accounting as the envelope
 * path's BulkIngestResponse, but rejections are keyed by 1-based LINE number
 * (blank lines count toward line numbers but are skipped without rejection).
 */
export interface NdjsonIngestResponse {
  ingested: number;
  duplicate: number;
  rejected: { line: number; reason: string }[];
  /** Present (true) only when more than {@link NDJSON_MAX_REJECTED_DETAILS} lines were rejected. */
  rejectedTruncated?: true;
}

/** True when the request declares `application/x-ndjson` (parameters tolerated). */
export function isNdjsonRequest(req: Pick<Request, 'headers'>): boolean {
  const contentType = req.headers['content-type'];

  return (
    typeof contentType === 'string' && contentType.split(';')[0].trim().toLowerCase() === NDJSON_CONTENT_TYPE
  );
}

/**
 * Drive one NDJSON bulk-ingest stream: split the raw request into lines,
 * validate each against `recordSchema`, buffer valid records into batches, and
 * hand each batch to `flushBatch` (which calls the kind's bulk service and
 * returns how many records the service ACCEPTED — created or found
 * pre-existing; the remainder of the batch is counted as intra-request
 * `duplicate`, mirroring the envelope path).
 *
 * Failure containment, in line with the services being idempotent on the
 * provenance triple (client retries are safe):
 *   - a malformed / schema-invalid / oversized line is rejected (with its
 *     1-based line number) and the stream CONTINUES;
 *   - a flushBatch error rejects the lines of that batch and the stream
 *     CONTINUES;
 *   - a client abort or stream error unwinds the handler with a
 *     BadRequestException (nobody is left to read a summary) — no hanging
 *     handler, no final partial flush.
 *
 * Memory stays bounded: at most one batch of parsed records, one in-flight
 * line buffer (≤ maxLineLength), and the capped rejected list. Backpressure is
 * inherent — the `for await` loop doesn't pull the next chunk while a flush is
 * awaited.
 */
export async function ingestNdjsonStream<S extends z.ZodTypeAny>(
  req: Request,
  recordSchema: S,
  flushBatch: (records: z.infer<S>[]) => Promise<{ ingested: number; duplicate: number }>,
  options: { batchSize?: number; maxLineLength?: number } = {},
): Promise<NdjsonIngestResponse> {
  const batchSize = options.batchSize ?? NDJSON_BATCH_SIZE;
  const maxLineLength = options.maxLineLength ?? NDJSON_MAX_LINE_LENGTH;

  let ingested = 0;
  let duplicate = 0;
  const rejected: { line: number; reason: string }[] = [];
  let rejectedTruncated = false;

  const reject = (line: number, reason: string) => {
    if (rejected.length < NDJSON_MAX_REJECTED_DETAILS) {
      rejected.push({ line, reason });
    } else {
      rejectedTruncated = true;
    }
  };

  let batch: z.infer<S>[] = [];
  let batchLines: number[] = [];

  const flush = async () => {
    if (batch.length === 0) {
      return;
    }

    const records = batch;
    const lines = batchLines;
    batch = [];
    batchLines = [];

    try {
      // The flush runs the capture->materialize->link pipeline and reports
      // real counts (duplicate = already-captured + within-request repeats),
      // not a shortfall derivation.
      const res = await flushBatch(records);
      ingested += res.ingested;
      duplicate += res.duplicate;
    } catch (err) {
      // The services are all-or-nothing per batch, so the whole batch's lines
      // are rejected together; the stream continues with the next batch.
      const reason = `batch failed: ${err instanceof Error ? err.message : String(err)}`;

      for (const line of lines) {
        reject(line, reason);
      }
    }
  };

  // 1-based physical line counter (blank lines included).
  let currentLine = 1;
  // Partial line carried across chunk boundaries.
  let buffer = '';
  // True while skipping the remainder of an already-rejected oversized line.
  let discardingOversized = false;

  const processCompleteLine = async (text: string) => {
    const line = currentLine;

    if (text.length > maxLineLength) {
      reject(line, `line exceeds the ${maxLineLength}-character limit`);

      return;
    }

    // Tolerate blank lines (and the \r of CRLF-delimited streams).
    const trimmed = text.trim();

    if (trimmed.length === 0) {
      return;
    }

    let parsedJson: unknown;

    try {
      parsedJson = JSON.parse(trimmed);
    } catch (err) {
      reject(line, `invalid JSON: ${err instanceof Error ? err.message : String(err)}`);

      return;
    }

    const result = recordSchema.safeParse(parsedJson);

    if (!result.success) {
      const issue = result.error.issues[0];
      const path = issue.path.join('.');
      reject(line, `validation failed: ${path.length > 0 ? `${path}: ` : ''}${issue.message}`);

      return;
    }

    batch.push(result.data);
    batchLines.push(line);

    if (batch.length >= batchSize) {
      await flush();
    }
  };

  // On a client abort Node destroys the IncomingMessage, which makes the async
  // iterator below reject — but track it explicitly too, so an abort that
  // surfaces as a plain stream end (no error) is still treated as premature.
  let aborted = false;
  const onAborted = () => {
    aborted = true;
  };

  req.once('aborted', onAborted);

  try {
    req.setEncoding('utf8');

    for await (const chunk of req as AsyncIterable<string>) {
      let start = 0;

      for (;;) {
        const newline = chunk.indexOf('\n', start);

        if (newline === -1) {
          // No line end in the remainder of this chunk: carry it over (unless
          // we're mid-discard of an oversized line) and enforce the line cap.
          if (!discardingOversized) {
            buffer += chunk.slice(start);

            if (buffer.length > maxLineLength) {
              reject(currentLine, `line exceeds the ${maxLineLength}-character limit`);
              discardingOversized = true;
              buffer = '';
            }
          }

          break;
        }

        if (discardingOversized) {
          // Reached the end of the oversized line (already rejected).
          discardingOversized = false;
        } else {
          const text = buffer + chunk.slice(start, newline);
          buffer = '';
          await processCompleteLine(text);
        }

        currentLine += 1;
        start = newline + 1;
      }
    }
  } catch (err) {
    // Mid-stream client abort / connection error: unwind instead of hanging.
    // The response (if any socket remains) is an error, and NO final partial
    // flush happens — the client will retry the whole stream, which is safe
    // because every flush is idempotent on the provenance triple.
    throw new BadRequestException(
      `NDJSON stream ended prematurely: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    req.removeListener('aborted', onAborted);
  }

  if (aborted) {
    throw new BadRequestException('NDJSON stream aborted by client');
  }

  // Final line may legally arrive without a trailing newline.
  if (!discardingOversized && buffer.length > 0) {
    await processCompleteLine(buffer);
  }

  await flush();

  return {
    ingested,
    duplicate,
    rejected,
    ...(rejectedTruncated ? { rejectedTruncated: true as const } : {}),
  };
}

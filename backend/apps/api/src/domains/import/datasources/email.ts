/* Generic Email datasource (.mbox / .eml).
   Parses RFC-5322 messages from mbox archives and .eml files (attachments simplified). */
import fs from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import { extractAttachmentToFile, attachmentMediaKind } from './attachment_extract';
import { mboxFromLineDate, receivedDate } from './email_date';
import { emailDirection, isDraft } from './email_direction';
import { decodeHeaderField, parseMime, readableBody, type ParsedMimeResult } from './email_mime';
import {
  extractReceiptFields,
  isLikelyReceipt,
  receiptHeaderSignal,
  receiptImportEnabled,
} from './receipt_detect';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams, Graph, EntityAttribute, Relationship } from './timeline';
import { timeframeContains } from './timeline';

// Marker type: this importer takes no options yet (future: skip labels,
// preferHTML, …). Record<string, never> rather than {} so it means "no
// options", not "any non-nullish value".
type EmailOptions = Record<string, never>;

// Read whole-file only for archives comfortably below Node's max string length
// (~512MB). Larger .mbox files are streamed line-by-line so we never hold the
// entire file — or all messages — in memory at once. (Same scheme as gmail.ts.)
const WHOLE_FILE_LIMIT = 256 * 1024 * 1024; // 256 MB

export class EmailFileImporter implements FileImporter {
  async recognize(_ctx: unknown, entry: DirEntry): Promise<Recognition> {
    const full = entry.fullPath || entry.fsRoot || entry.filename;
    if (!full) {
      return { confidence: 0 };
    }

    try {
      const st = await stat(full);
      if (st.isFile()) {
        const ext = path.extname(full).toLowerCase();
        if (ext === '.mbox' || ext === '.eml') {
          return { confidence: 0.95 };
        }

        // lightweight sniff: first 5 bytes 'From ' implies mbox
        if (!ext && st.size > 10 && (await sniffIsMbox(full))) {
          return { confidence: 0.7 };
        }
      } else if (st.isDirectory()) {
        const ents = await readdir(full);
        if (ents.some((e) => e.toLowerCase().endsWith('.mbox') || e.toLowerCase().endsWith('.eml'))) {
          return { confidence: 0.6, dir_threshold: 0.9 };
        }
      }
    } catch {
      /* ignore */
    }

    return { confidence: 0 };
  }

  async fileImport(_ctx: unknown, entry: DirEntry, params: ImportParams): Promise<void> {
    const start = entry.fullPath || entry.fsRoot || entry.filename;
    if (!start) {
      return;
    }

    const st = fs.statSync(start);
    if (st.isDirectory()) {
      for await (const f of this.walkDir(start)) {
        await this.importOne(f, params);
      }
    } else {
      await this.importOne(start, params);
    }
  }

  // Dispatch by extension, falling back to the same 'From ' sniff recognize()
  // uses: Thunderbird's ImportExportTools NG and profile-folder copies name mbox
  // files after the mail folder ("Inbox", "Sent") with no extension, so an
  // extension-only dispatch accepted them at recognize time then imported zero
  // records ("no records found" with the files sitting right in the inbox dir).
  private async importOne(fpath: string, params: ImportParams): Promise<void> {
    const ext = path.extname(fpath).toLowerCase();
    if (ext === '.mbox') {
      await this.processMbox(fpath, params);
    } else if (ext === '.eml') {
      await this.processEml(fpath, params);
    } else if (!ext && (await sniffIsMbox(fpath))) {
      await this.processMbox(fpath, params);
    }
  }

  private async *walkDir(root: string): AsyncGenerator<string> {
    const ents = await fs.promises.readdir(root, { withFileTypes: true });
    for (const e of ents) {
      if (e.name.startsWith('.')) {
        continue;
      }

      const full = path.join(root, e.name);
      if (e.isDirectory()) {
        yield* this.walkDir(full);
      } else if (e.isFile()) {
        yield full;
      }
    }
  }

  private async processEml(fpath: string, params: ImportParams): Promise<void> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', 'read eml failed', { file: fpath, error: (e as Error).message });

      return;
    }

    raw = raw.replace(/\r\n/g, '\n');
    this.processRawMessage(raw, fpath, 0, params);
  }

  private async processMbox(fpath: string, params: ImportParams): Promise<void> {
    let size = 0;
    try {
      size = fs.statSync(fpath).size;
    } catch {
      /* fall through to streaming */
    }

    // Small archives keep the original whole-file behavior; large ones are
    // streamed. readFile('utf8') throws ERR_STRING_TOO_LONG past ~512MB, so
    // without the streaming path a big export imported zero records.
    if (size > 0 && size <= WHOLE_FILE_LIMIT) {
      let raw: string;
      try {
        raw = await fs.promises.readFile(fpath, 'utf8');
      } catch (e) {
        params.log?.('error', 'read mbox failed', { file: fpath, error: (e as Error).message });

        return;
      }

      raw = raw.replace(/\r\n/g, '\n');
      const chunks = raw.split(/\nFrom /).map((m, i) => (i === 0 ? m : 'From ' + m));
      chunks.forEach((chunk, idx) => this.processRawMessage(chunk, fpath, idx, params));

      return;
    }

    await this.streamMbox(fpath, params);
  }

  // Stream a (potentially multi-GB) mbox line-by-line: accumulate lines for the
  // current message and flush it when the next column-0 "From " separator
  // appears, so memory stays bounded to a single message. Same scheme as
  // gmail.ts#streamMbox; the per-message index feeds the Message-ID-less id
  // fallback exactly like the whole-file path's chunk index.
  private async streamMbox(fpath: string, params: ImportParams): Promise<void> {
    let stream: fs.ReadStream;
    try {
      stream = fs.createReadStream(fpath, { encoding: 'utf8' });
    } catch (e) {
      params.log?.('error', 'read mbox failed', { file: fpath, error: (e as Error).message });

      return;
    }

    try {
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      let current: string[] = [];
      let started = false;
      let index = 0;
      const flush = () => {
        if (!started) {
          return;
        }

        const chunk = current.join('\n').replace(/\r\n/g, '\n');
        current = [];
        try {
          this.processRawMessage(chunk, fpath, index++, params);
        } catch (e) {
          params.log?.('error', 'parse message failed', { file: fpath, error: (e as Error).message });
        }
      };

      for await (const line of rl) {
        // A "From " at column 0 marks the start of a new mbox record.
        if (line.startsWith('From ')) {
          flush();
          started = true;
          current.push(line);
        } else if (started) {
          current.push(line);
        }
        // Lines before the first "From " separator are leading noise; skip them.
      }

      flush();
    } catch (e) {
      params.log?.('error', 'read mbox failed', { file: fpath, error: (e as Error).message });
    } finally {
      stream.destroy();
    }
  }

  private processRawMessage(raw: string, location: string, index: number, params: ImportParams) {
    const parts = raw.split(/\n\n/);
    if (parts.length < 2) {
      params.pipeline.drop?.('non_message');

      return;
    }

    const headersRaw = parts[0].replace(/\n[ \t]+/g, ' '); // unfold
    const bodyRaw = parts.slice(1).join('\n\n');
    const headers = parseHeaders(headersRaw);
    if (!headers.Date && !headers.Subject) {
      params.pipeline.drop?.('non_message');

      return;
    } // likely not a real message

    // Never-sent drafts aren't correspondence — skip them entirely.
    if (isDraft(headers)) {
      params.pipeline.drop?.('draft');

      return;
    }

    // Timestamp: Date header (the author's send time) → first Received stamp
    // (final delivery) → mbox separator-line date. Bulk senders omit Date:
    // entirely, and without the fallbacks those messages landed dated at
    // import wall-clock (see email_date.ts).
    let ts: Date | undefined;
    if (headers.Date) {
      const d = new Date(headers.Date);
      if (!isNaN(d.getTime())) {
        ts = d;
      }
    }

    if (!ts) {
      ts = receivedDate(headersRaw) ?? mboxFromLineDate(raw);
    }

    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    // MIME parsing (single-level) for body + attachments. `readableBody`
    // flattens an HTML-only message to text (see email_mime.htmlToText) — the
    // raw markup it used to hand back was unreadable to every consumer, and to
    // the receipt detector below.
    const mime: ParsedMimeResult = parseMime(headersRaw, bodyRaw);
    const bodyText = readableBody(mime);

    // Is this a receipt / order confirmation / invoice? The generic email
    // importer has no bulk gate to override (that is gmail.ts), but the
    // classification still matters: 'receipt' routes to the receipts
    // destination instead of landing as one more undifferentiated
    // communication.
    const isReceipt =
      receiptImportEnabled() &&
      receiptHeaderSignal(headers, headers.Subject) !== 'none' &&
      isLikelyReceipt(headers, headers.Subject, bodyText);

    // Participants hang off the email graph as edges (relation 'from'/'to'/'cc')
    // so persistGraph records an item→entity relationship for each — pushed as
    // separate top-level graphs they persisted as orphan entities with no link
    // back to the email (same defect as gmail.ts).
    const edges: Relationship[] = [];
    const seenParticipants = new Set<string>();
    const addParticipants = (line: string | undefined, attr: string) => {
      if (!line) {
        return;
      }

      for (const addr of line.split(/,/)) {
        const parsed = parseEmailAddress(addr.trim());
        if (!parsed.email) {
          continue;
        }

        // Bare addresses use the address as the name: entity dedup keys on
        // (type, name), so nameless participants would merge into one blank row.
        const name = parsed.name || parsed.email;
        const dedupKey = `${attr}|${parsed.email.toLowerCase()}`;
        if (seenParticipants.has(dedupKey)) {
          continue;
        }

        seenParticipants.add(dedupKey);
        edges.push({
          relation: attr,
          to: {
            entity: {
              name,
              attributes: [{ name: attr, value: parsed.email, identity: true } as EntityAttribute],
            },
          },
        });
      }
    };

    addParticipants(headers.From, 'from');
    addParticipants(headers.To, 'to');
    addParticipants(headers.Cc, 'cc');

    const cleanMsgID = headers['Message-ID'] ? headers['Message-ID'].replace(/[<>]/g, '') : undefined;

    // Direction: inbound iff the message carries receiving-MTA delivery-trace
    // headers (Return-Path etc. — see email_direction.ts); a copy filed at
    // submission has none → outbound. The canonical mapping reads `Direction`
    // (mapping.ts#directionFor).
    const direction = emailDirection(headers);
    // Attachments ride the communication itself as metadata.MediaAttachments —
    // the descriptor lane the push's comms media leg reads (upload + content
    // row + the message's attachments column; see graphql.ts
    // withCommunicationMedia). They used to be separate sub-items routed by
    // MIME to events, which minted one ci.events row per attachment at the
    // email's timestamp titled by the email's subject — pure duplication of
    // the communication (a live ci.events held nothing but such rows).
    // `path` is the attachment's OWN extracted bytes — never the mbox/eml
    // container, which retention/push would otherwise copy whole per
    // attachment (see attachment_extract.ts for the 95 GB incident detail).
    // Extraction failure (or zero bytes) → no descriptor: nothing on disk to
    // upload.
    const mediaAttachments = mime.attachments.flatMap((att, attIdx) => {
      const extracted = extractAttachmentToFile(location, att, params.log);
      if (!extracted) {
        return [];
      }

      const kind = attachmentMediaKind(att.mediaType);

      return [
        {
          path: extracted,
          filename: att.filename || `attachment-${attIdx}`,
          // A non-media attachment on a RECEIPT is the receipt document (the
          // PDF invoice), not an anonymous 'file'.
          type: isReceipt && kind === 'file' ? ('receipt_document' as const) : kind,
          mimetype: att.mediaType,
        },
      ];
    });

    // 4000 chars for correspondence, 32000 for a receipt: an itemised order
    // confirmation IS its body, and a 4k clip cuts the line items and the total
    // off the end of every multi-item order.
    const bodyCap = isReceipt ? 32000 : 4000;
    const receiptFields = isReceipt ? extractReceiptFields(headers, bodyText) : undefined;

    const item = {
      id: cleanMsgID ? `email:${cleanMsgID}` : `email:${path.basename(location)}#${index}`,
      classification: isReceipt ? 'receipt' : 'email',
      timestamp: ts,
      intermediateLocation: location,
      content: {
        filename: path.basename(location),
        mediaType: 'text/plain',
        data: async () => Buffer.from(bodyText || ''),
      },
      // Body snippet so the canonical mapping carries text to CI-Server; capped
      // to keep metadata/embeddings sane (full body still lives in content.data).
      // From/To ride along so the comms mapping can fill participants_metadata.
      metadata: {
        Subject: headers.Subject,
        From: headers.From,
        To: headers.To,
        Cc: headers.Cc,
        Direction: direction,
        MessageID: cleanMsgID,
        Text: bodyText ? bodyText.slice(0, bodyCap) : undefined,
        MediaAttachments: mediaAttachments.length ? mediaAttachments : undefined,
        // Receipt facts under the CANONICAL commerce keys (push/commerceKeys.ts).
        Merchant: receiptFields?.merchant,
        'Order ID': receiptFields?.orderId,
        Total: receiptFields?.total,
        Currency: receiptFields?.currency,
        // The generic email importer has no bulk gate, so every message it
        // keeps is correspondence it would have kept anyway: a receipt here
        // ADDS a receipt row and keeps its communications home. See
        // push/canonical.ts destinationsFor.
        HumanCorrespondence: isReceipt ? true : undefined,
        CommunicationType: isReceipt ? 'email' : undefined,
      },
    };

    const g: Graph = { item, edges: edges.length ? edges : undefined };
    params.pipeline.push(g);
  }
}

/** First 5 bytes 'From ' implies mbox (the column-0 record separator). */
async function sniffIsMbox(fpath: string): Promise<boolean> {
  try {
    const fd = await fs.promises.open(fpath, 'r');
    const buf = Buffer.alloc(5);
    await fd.read(buf, 0, 5, 0);
    await fd.close();

    return buf.toString() === 'From ';
  } catch {
    return false;
  }
}

function parseHeaders(raw: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of raw.split(/\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) {
      continue;
    }

    const key = line.slice(0, idx).trim();
    // decodeHeaderField is a cheap no-op (one .includes('=?') check) unless a
    // value actually carries a `=?charset?…?=` encoded-word — see gmail.ts's
    // parseHeaders for why decoding unconditionally here is safe.
    const val = decodeHeaderField(line.slice(idx + 1).trim());
    if (!map[key]) {
      map[key] = val;
    } else {
      map[key] += ', ' + val;
    }
  }

  return map;
}

function parseEmailAddress(raw: string): { name?: string; email?: string } {
  // Linear indexOf/slice, NOT a regex — the prior
  // /^(?:"?([^"<]+)"?\s*)?<([^>]+)>$/ backtracks quadratically and hung the whole
  // mbox import on one pathological address header (see gmail.ts for the detail).
  const lt = raw.indexOf('<');
  if (lt !== -1) {
    const gt = raw.indexOf('>', lt + 1);
    if (gt !== -1) {
      const email = raw.slice(lt + 1, gt).trim();
      const name = raw.slice(0, lt).trim().replace(/^"|"$/g, '').trim() || undefined;

      return { name, email };
    }
  }

  if (/^[^@\s]+@[^@\s]+$/.test(raw)) {
    return { email: raw.trim() };
  }

  return { name: raw };
}

registerDataSource({
  name: 'email',
  title: 'Email',
  icon: 'email.png',
  description: 'Generic email .mbox / .eml files',
  newOptions: () => ({}) as EmailOptions,
  newFileImporter: () => new EmailFileImporter(),
});

/* Gmail datasource (stub TypeScript port) */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import { extractAttachmentToFile, attachmentMediaKind } from './attachment_extract';
import { mboxFromLineDate, receivedDate } from './email_date';
import { emailDirection, isDraft } from './email_direction';
import { decodeHeaderField, parseMime, readableBody, type ParsedMimeResult } from './email_mime';
import { emailThreadId } from './email_thread';
import { isHumanCorrespondence } from './human_correspondence';
import {
  extractReceiptFields,
  isLikelyReceipt,
  receiptHeaderSignal,
  receiptImportEnabled,
} from './receipt_detect';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams, Graph, Entity, EntityAttribute, Metadata, Relationship } from './timeline';
import { timeframeContains } from './timeline';

// Read whole-file only for archives comfortably below Node's max string length
// (~512MB). Larger .mbox files are streamed line-by-line so we never hold the
// entire file — or all messages — in memory at once.
const WHOLE_FILE_LIMIT = 256 * 1024 * 1024; // 256 MB

type GmailOptions = Record<string, never>;

export class GmailFileImporter implements FileImporter {
  async recognize(_ctx: unknown, entry: DirEntry): Promise<Recognition> {
    const full = entry.fullPath || entry.fsRoot || entry.filename;
    if (!full) {
      return { confidence: 0 };
    }

    let st: fs.Stats;
    try {
      st = await stat(full);
    } catch {
      return { confidence: 0 };
    }

    if (st.isFile()) {
      const ext = path.extname(full).toLowerCase();
      if (ext === '.mbox') {
        // Boost to 1.0 when the path contains Takeout markers — outranks generic email@0.95.
        const lp = full.toLowerCase();
        if (lp.includes('takeout') || lp.includes('google') || lp.includes('gmail')) {
          return { confidence: 1.0 };
        }

        return { confidence: 0.9 };
      }

      try {
        const fd = await fs.promises.open(full, 'r');
        const buf = Buffer.alloc(5);
        await fd.read(buf, 0, 5, 0);
        await fd.close();
        if (buf.toString() === 'From ') {
          return { confidence: 0.7 };
        }
      } catch {
        /* ignore */
      }
    }

    if (st.isDirectory()) {
      // Gmail Takeout folder often contains "All mail Including Spam and Trash.mbox"
      const entries = await readdir(full);
      const lp = full.toLowerCase();
      const isTakeout = lp.includes('takeout') || lp.includes('google') || lp.includes('gmail');
      if (entries.some((e) => e.toLowerCase().endsWith('.mbox'))) {
        return { confidence: isTakeout ? 0.95 : 0.6, dir_threshold: 0.9 };
      }
    }

    return { confidence: 0 };
  }

  async fileImport(_ctx: unknown, entry: DirEntry, params: ImportParams): Promise<void> {
    const start = entry.fullPath || entry.fsRoot || entry.filename;
    if (!start) {
      return;
    }

    const stat = fs.statSync(start);
    if (stat.isDirectory()) {
      for await (const f of this.walkDir(start)) {
        if (f.toLowerCase().endsWith('.mbox')) {
          await this.processMbox(f, params);
        }
      }
    } else if (start.toLowerCase().endsWith('.mbox')) {
      await this.processMbox(start, params);
    }
  }

  private async *walkDir(root: string): AsyncGenerator<string> {
    const ents = await fs.promises.readdir(root, { withFileTypes: true });
    for (const e of ents) {
      const full = path.join(root, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('.')) {
          continue;
        }

        yield* this.walkDir(full);
      } else if (e.isFile()) {
        yield full;
      }
    }
  }

  private async processMbox(fpath: string, params: ImportParams): Promise<void> {
    let size = 0;
    try {
      size = fs.statSync(fpath).size;
    } catch {
      /* fall through to streaming */
    }

    // Small archives: keep the original whole-file behavior (fast, simple, and
    // exercised by the unit tests). Large archives are streamed so a multi-GB
    // .mbox never has to fit in a single string/Buffer.
    if (size > 0 && size <= WHOLE_FILE_LIMIT) {
      let raw: string;
      try {
        raw = await fs.promises.readFile(fpath, 'utf8');
      } catch (e) {
        params.log?.('error', 'read mbox failed', {
          file: path.basename(fpath),
          error: (e as Error).message,
        });

        return;
      }

      // Normalize CRLF to LF
      raw = raw.replace(/\r\n/g, '\n');
      // Split on "\nFrom " separators (mbox) but keep first if starts that way
      const chunks = raw.split(/\nFrom /).map((m, i) => (i === 0 ? m : 'From ' + m));
      for (const chunk of chunks) {
        this.parseMessage(chunk, fpath, params);
      }

      return;
    }

    await this.streamMbox(fpath, params);
  }

  // Stream a (potentially multi-GB) mbox line-by-line. Each mbox record begins
  // with a "From " separator line at column 0; we accumulate lines for the
  // current message and flush it the moment the next separator appears, parsing
  // and pushing each message before reading the next. Memory stays bounded to a
  // single message regardless of total file size.
  private async streamMbox(fpath: string, params: ImportParams): Promise<void> {
    let stream: fs.ReadStream;
    try {
      stream = fs.createReadStream(fpath, { encoding: 'utf8' });
    } catch (e) {
      params.log?.('error', 'read mbox failed', { file: path.basename(fpath), error: (e as Error).message });

      return;
    }

    try {
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      let current: string[] = [];
      let started = false;
      const flush = () => {
        if (!started) {
          return;
        }

        const chunk = current.join('\n');
        current = [];
        try {
          this.parseMessage(chunk, fpath, params);
        } catch (e) {
          params.log?.('error', 'parse message failed', {
            file: path.basename(fpath),
            error: (e as Error).message,
          });
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
      params.log?.('error', 'read mbox failed', { file: path.basename(fpath), error: (e as Error).message });
    } finally {
      stream.destroy();
    }
  }

  // Parse a single raw mbox message (one record, "From "-separator included or
  // not) and push the resulting item + entities. Shared by both the whole-file
  // and streaming code paths so behavior is identical regardless of file size.
  private parseMessage(chunk: string, fpath: string, params: ImportParams): void {
    // Normalize CRLF in case a streamed line carried a stray \r.
    chunk = chunk.replace(/\r\n/g, '\n');
    // Separate headers and body; allow folded headers per RFC 5322 (continuation lines start with space or tab)
    // Every early return below MUST report to pipeline.drop: a 5GB Takeout mbox
    // loses ~90% of its messages to the bulk filter, and without ledger entries
    // that entire funnel is invisible in the job record (the "89k collected,
    // 15k inserted, drops={dedup:62}" mystery).
    const parts = chunk.split(/\n\n/);
    if (parts.length < 2) {
      params.pipeline.drop?.('non_message');

      return;
    }

    let headersRaw = parts[0];
    const bodyRaw = parts.slice(1).join('\n\n');
    // Unfold headers: replace CRLF + WSP with single space
    headersRaw = headersRaw.replace(/\n[ \t]+/g, ' ');
    const headersMap = parseHeaders(headersRaw);
    if (!headersMap.Subject && !headersMap.Date) {
      params.pipeline.drop?.('non_message');

      return;
    } // skip non-message chunks

    // Timestamp: Date header (the author's send time) → first Received stamp
    // (final delivery) → mbox separator-line date. Bulk senders omit Date:
    // entirely, and without the fallbacks those messages landed dated at
    // import wall-clock (see email_date.ts).
    let ts: Date | undefined;
    if (headersMap.Date) {
      const d = new Date(headersMap.Date);
      if (!isNaN(d.getTime())) {
        ts = d;
      }
    }

    if (!ts) {
      ts = receivedDate(headersRaw) ?? mboxFromLineDate(chunk);
    }

    if (!timeframeContains(params.timeframe, ts)) {
      params.pipeline.drop?.('outside_timeframe');

      return;
    }

    // Never-sent drafts aren't correspondence — skip them entirely.
    if (isDraft(headersMap)) {
      params.pipeline.drop?.('draft');

      return;
    }

    const subject = headersMap.Subject;

    // RECEIPT DISCOVERY, and it must happen BEFORE the bulk gate below.
    //
    // Order confirmations, receipts and invoices arrive as exactly what
    // isHumanCorrespondence rejects: Category Promotions/Updates,
    // List-Unsubscribe, Precedence: bulk, no-reply@ senders. So the single
    // richest commerce source in a mailbox was landing in the drop ledger and
    // never reaching ci.* at all. A message that shows positive receipt
    // evidence (see receipt_detect.ts) OVERRIDES the gate and is classified
    // 'receipt' — kind commerce.receipt, which routes to the receipts
    // destination rather than to communications: an order confirmation the mail
    // gate rejected is not correspondence.
    //
    // The body is parsed lazily: an HTML-only receipt needs its markup
    // flattened before the body signal can see the total, but a 5 GB mbox must
    // not pay a MIME parse per message just to ask the question. The cheap
    // header verdict gates that.
    let mime: ParsedMimeResult | undefined;
    let bodyText = '';
    const readBody = (): string => {
      if (!mime) {
        mime = parseMime(headersRaw, bodyRaw);
        bodyText = readableBody(mime);
      }

      return bodyText;
    };

    const isReceipt =
      receiptImportEnabled() &&
      receiptHeaderSignal(headersMap, subject) !== 'none' &&
      isLikelyReceipt(headersMap, subject, readBody());

    // Keep only real human correspondence: drop spam, newsletters, promotions,
    // social/forum/update notifications, and other bulk/automated mail. Set
    // CI_GMAIL_INCLUDE_BULK=1 to import everything. See isHumanCorrespondence.
    const human = isHumanCorrespondence(headersMap);
    if (!human && !isReceipt && process.env.CI_GMAIL_INCLUDE_BULK !== '1') {
      params.pipeline.drop?.('bulk_filtered');

      return;
    }

    // The volume delta: exactly the messages the bulk gate WOULD have dropped
    // and the receipt rule KEPT. It goes in the KEEP ledger, never the drop
    // ledger — these records DO become staged rows, and counting them as drops
    // corrupts the run's loss report with its own opposite.
    if (isReceipt && !human) {
      params.pipeline.keep?.('receipt_kept_from_bulk');
    }

    // MIME parse (single-level) for body + attachments — already done above
    // when the receipt check needed the body.
    readBody();

    // Participants
    const from = headersMap.From;
    const to = headersMap.To;
    const cc = headersMap.Cc;
    const msgID = headersMap['Message-ID'];
    const refs = headersMap.References;
    const inReply = headersMap['In-Reply-To'];
    // Participants hang off the email graph as edges (relation 'from'/'to'/'cc')
    // so persistGraph records an item→entity relationship for each. They used to
    // be pushed as SEPARATE top-level entity-only graphs, which persisted the
    // people but never a single email↔person relationship row (a live full-mbox
    // import recorded relationships_inserted=0 against 12k entities).
    const edges: Relationship[] = [];
    const seenParticipants = new Set<string>();
    const addParticipants = (line: string | undefined, kind: string) => {
      if (!line) {
        return;
      }

      for (const addr of line.split(/,/)) {
        const parsed = parseEmailAddress(addr.trim());
        // Bare addresses use the address as the name: entity dedup in persistence
        // keys on (type, name), so nameless participants would all merge into one
        // blank 'contact' row — and every relationship would point at it.
        const name = parsed.name || parsed.email;
        if (!name) {
          continue;
        }

        const dedupKey = `${kind}|${(parsed.email ?? name).toLowerCase()}`;
        if (seenParticipants.has(dedupKey)) {
          continue;
        }

        seenParticipants.add(dedupKey);
        edges.push({
          relation: kind,
          to: {
            entity: {
              name,
              attributes: [{ name: kind, value: parsed.email, identity: true } as EntityAttribute],
            },
          },
        });
      }
    };

    addParticipants(from, 'from');
    addParticipants(to, 'to');
    addParticipants(cc, 'cc');

    const cleanMsgID = msgID ? msgID.replace(/[<>]/g, '') : undefined;
    // Direction: outbound when this is the user's own mail — Gmail tags it with
    // a `Sent` label, and a submission-filed copy carries no receiving-MTA
    // delivery-trace headers (see email_direction.ts); else inbound. The
    // canonical mapping reads `Direction` (mapping.ts#directionFor), so the
    // communication row carries it through to CI-Server.
    const direction = emailDirection(headersMap);
    // Body snippet so the canonical mapping carries text to CI-Server; capped to
    // keep metadata/embeddings sane (full body still lives in content.data).
    // From/To ride along too so the comms mapping can fill participants_metadata.
    // Attachments ride the communication itself as metadata.MediaAttachments —
    // the descriptor lane the push's comms media leg reads (upload + content
    // row + the message's attachments column; see graphql.ts
    // withCommunicationMedia). They used to be separate sub-items routed by
    // MIME to events, which minted one ci.events row per attachment at the
    // email's timestamp titled by the email's subject — pure duplication of
    // the communication (a live ci.events held nothing but such rows).
    // `path` is the attachment's OWN extracted bytes — NEVER the mbox
    // container. Pointing at the container made the media-retention pass copy
    // (and the push upload) the entire multi-GB mbox once per media attachment
    // (a live import copied 5.3 GB × 18 attachments = 95 GB before freezing).
    // Extraction failure (or zero bytes) → no descriptor: nothing on disk to
    // upload.
    const mediaAttachments = (mime?.attachments ?? []).flatMap((att, attIdx) => {
      const extracted = extractAttachmentToFile(fpath, att, params.log);
      if (!extracted) {
        return [];
      }

      const kind = attachmentMediaKind(att.mediaType);

      return [
        {
          path: extracted,
          filename: att.filename || `attachment-${attIdx}`,
          // A non-media attachment on a RECEIPT is the receipt document (the
          // PDF invoice), not an anonymous 'file'. Photos stay photos — a
          // picture attached to an order confirmation is still a picture.
          type: isReceipt && kind === 'file' ? ('receipt_document' as const) : kind,
          mimetype: att.mediaType,
        },
      ];
    });
    // Body cap: 4000 chars for correspondence (a snippet is enough to embed and
    // preview), 32000 for a receipt — an itemised order confirmation IS its
    // body, and clipping at 4k cuts the line items and the total off the end of
    // every multi-item order.
    const bodyCap = isReceipt ? 32000 : 4000;
    // What the receipt states about itself: merchant, order id, total. Written
    // under the CANONICAL commerce keys (push/commerceKeys.ts) so the receipt
    // mapper reads them without a per-source special case.
    const receiptFields = isReceipt ? extractReceiptFields(headersMap, bodyText) : undefined;
    const itemMetadata: Metadata = {
      Source: 'GmailMbox',
      Subject: subject,
      From: from,
      To: to,
      Cc: cc,
      Direction: direction,
      MessageID: cleanMsgID,
      InReplyTo: inReply?.replace(/[<>]/g, ''),
      References: refs?.replace(/[<>]/g, ' '),
      // Conversation key — References root / In-Reply-To / own Message-ID.
      // Without ThreadId, toCommunicationInput falls through to MessageID and
      // every archive row becomes its own thread.
      ThreadId: emailThreadId(headersMap),
      Text: bodyText ? bodyText.slice(0, bodyCap) : undefined,
      MediaAttachments: mediaAttachments.length ? mediaAttachments : undefined,
      Merchant: receiptFields?.merchant,
      'Order ID': receiptFields?.orderId,
      Total: receiptFields?.total,
      Currency: receiptFields?.currency,
      // Did the human-correspondence gate pass this message on its own merits?
      // A receipt that would have been KEPT as mail must keep its
      // communications home as well as gaining a receipt — the receipt lane
      // only ever adds (see push/canonical.ts destinationsFor). A receipt
      // RESCUED from the bulk filter was being dropped entirely, so it becomes
      // a receipt alone.
      HumanCorrespondence: isReceipt && human ? true : undefined,
      CommunicationType: isReceipt && human ? 'email' : undefined,
    };
    // The body AS `parseMime` hands it back — RAW markup for an HTML-only
    // message — and NOT the flattened `bodyText` above.
    //
    // This feeds the Message-ID-less fallback id below, and an id must outlive
    // a change to how a body is READ. `bodyText` used to be
    // `mime.textBody || mime.htmlBody`; it is now flattened by `readableBody`,
    // so hashing it would give every HTML-only message with no Message-ID a
    // different id than a previous import produced — forking each one into a
    // duplicate on the next re-import, with no migration to undo it.
    const dedupBody = mime ? mime.textBody || mime.htmlBody || '' : bodyText;
    const item = {
      // Message-ID is the natural unique key. Without it the dedup hash collapses
      // to (dataSource, 'email', mbox basename, timestamp-second), so distinct
      // emails sharing a second would silently overwrite each other.
      id: cleanMsgID
        ? `gmail:${cleanMsgID}`
        : `gmail:nomid:${crypto
            .createHash('sha1')
            .update(headersRaw + '\0' + dedupBody)
            .digest('hex')}`,
      // 'receipt' → kind commerce.receipt → the receipts destination.
      classification: isReceipt ? 'receipt' : 'email',
      timestamp: ts,
      intermediateLocation: fpath,
      content: {
        filename: path.basename(fpath),
        mediaType: 'text/plain',
        data: async () => Buffer.from(bodyText || ''),
      },
      metadata: itemMetadata,
    };
    const g: Graph = { item, edges: edges.length ? edges : undefined };
    const threadID = emailThreadId(headersMap);
    if (threadID) {
      g.entity = { name: threadID, type: 'email_thread' } as Entity;
    }

    params.pipeline.push(g);
  }
}

export { isHumanCorrespondence } from './human_correspondence';

function parseHeaders(raw: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of raw.split(/\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) {
      continue;
    }

    const key = line.slice(0, idx).trim();
    // decodeHeaderField is a cheap no-op (one .includes('=?') check) unless a
    // value actually carries a `=?charset?…?=` encoded-word — Subject and a
    // display name inside From/To/Cc are the fields real mail actually
    // encodes this way, and nothing else legitimately contains the marker, so
    // decoding unconditionally is safe and keeps this one map correct
    // end-to-end rather than requiring every reader to remember to decode.
    const val = decodeHeaderField(line.slice(idx + 1).trim());
    if (!map[key]) {
      map[key] = val;
    } else {
      map[key] += ', ' + val;
    } // combine duplicates
  }

  return map;
}

function parseEmailAddress(raw: string): { name?: string; email?: string } {
  // Formats: Name <email@domain>, "Name" <email@domain>, bare email@domain.
  // Linear indexOf/slice — NOT a regex. The previous
  // /^(?:"?([^"<]+)"?\s*)?<([^>]+)>$/ overlaps [^"<]+ and \s* on whitespace and
  // backtracks quadratically: a 120k-char address header took 8.5s, and a longer
  // one hung the ENTIRE mbox import on a single pathological message (CPU-spun at
  // 94% with zero progress, no way to skip it).
  const lt = raw.indexOf('<');
  if (lt !== -1) {
    const gt = raw.indexOf('>', lt + 1);
    if (gt !== -1) {
      const email = raw.slice(lt + 1, gt).trim();
      const name = raw.slice(0, lt).trim().replace(/^"|"$/g, '').trim() || undefined;

      return { name, email };
    }
  }

  if (/^[^@]+@[^@]+$/.test(raw)) {
    return { email: raw };
  }

  return { name: raw };
}

registerDataSource({
  name: 'gmail',
  title: 'Gmail (mbox)',
  icon: 'gmail.svg',
  description: 'Gmail Takeout .mbox files (minimal stub)',
  newOptions: () => ({}) as GmailOptions,
  newFileImporter: () => new GmailFileImporter(),
});

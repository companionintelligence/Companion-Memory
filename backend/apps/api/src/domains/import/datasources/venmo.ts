/* Venmo — transaction history from an account statement CSV.
   The Venmo statement CSV has preamble/summary lines before the real header.
   The header row contains "Datetime" and "Amount (total)". Rows after the
   header with an empty ID are running-balance/summary rows and are skipped.
*/
import fs from 'node:fs';
import { open, readdir, stat as fsStat } from 'node:fs/promises';
import path from 'node:path';

import { parseCSVRows } from './csv';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams, LineItemRecord, Relationship } from './timeline';
import { timeframeContains } from './timeline';

// A Venmo header row is one that contains both "Datetime" and "Amount (total)".
function isVenmoHeaderRow(cells: string[]): boolean {
  const trimmed = cells.map((c) => c.trim());

  return trimmed.includes('Datetime') && trimmed.includes('Amount (total)');
}

// Quick textual sniff over the first chunk: a line containing both signature columns.
function textHasVenmoHeader(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    if (line.includes('Datetime') && line.includes('Amount (total)')) {
      return true;
    }
  }

  return false;
}

function stripBOM(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

interface VenmoTxn {
  id: string;
  datetime?: Date;
  type: string;
  status: string;
  note: string;
  from: string;
  to: string;
  amountTotal: string;
}

// Locate the header row, then map each subsequent data row by header name.
// Rows with an empty ID (running-balance / summary rows) are dropped.
function parseVenmo(text: string): VenmoTxn[] {
  const rows = parseCSVRows(text);
  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (isVenmoHeaderRow(rows[i])) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx === -1) {
    return [];
  }

  const headers = rows[headerIdx].map((h) => h.trim());
  const col = (name: string): number => headers.indexOf(name);
  const idIdx = col('ID');
  const dtIdx = col('Datetime');
  const typeIdx = col('Type');
  const statusIdx = col('Status');
  const noteIdx = col('Note');
  const fromIdx = col('From');
  const toIdx = col('To');
  const amtIdx = col('Amount (total)');

  const txns: VenmoTxn[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const cell = (idx: number): string => (idx >= 0 ? (r[idx] ?? '').trim() : '');
    const id = cell(idIdx);
    if (!id) {
      continue;
    } // skip running-balance / summary rows with no transaction ID

    const dtRaw = cell(dtIdx);
    let datetime: Date | undefined = dtRaw ? new Date(dtRaw) : undefined;
    if (datetime && isNaN(datetime.getTime())) {
      datetime = undefined;
    }

    txns.push({
      id,
      datetime,
      type: cell(typeIdx),
      status: cell(statusIdx),
      note: cell(noteIdx),
      from: cell(fromIdx),
      to: cell(toIdx),
      amountTotal: cell(amtIdx),
    });
  }

  return txns;
}

export class VenmoFileImporter implements FileImporter {
  async recognize(_ctx: unknown, entry: DirEntry): Promise<Recognition> {
    const root = entry.fullPath || entry.fsRoot || entry.filename;
    if (!root) {
      return { confidence: 0 };
    }

    let stat: fs.Stats;
    try {
      stat = await fsStat(root);
    } catch {
      return { confidence: 0 };
    }

    if (stat.isFile()) {
      if (path.extname(root).toLowerCase() !== '.csv') {
        return { confidence: 0 };
      }

      return (await this.headerMatches(root)) ? { confidence: 0.9 } : { confidence: 0 };
    }

    if (stat.isDirectory()) {
      try {
        const names = await readdir(root);
        for (const name of names) {
          if (path.extname(name).toLowerCase() !== '.csv') {
            continue;
          }

          if (await this.headerMatches(path.join(root, name))) {
            return { confidence: 0.9 };
          }
        }
      } catch {
        /* ignore */
      }

      return { confidence: 0, dir_threshold: 0.7 };
    }

    return { confidence: 0 };
  }

  // Read only the first ~8KB to inspect for the Venmo header line (it lives
  // after a few preamble lines, so a single header line check is not enough).
  private async headerMatches(fpath: string): Promise<boolean> {
    try {
      const fh = await open(fpath, 'r');
      try {
        const buf = Buffer.alloc(8192);
        const { bytesRead } = await fh.read(buf, 0, 8192, 0);

        return textHasVenmoHeader(stripBOM(buf.toString('utf8', 0, bytesRead)));
      } finally {
        await fh.close().catch(() => {});
      }
    } catch {
      return false;
    }
  }

  async fileImport(_ctx: unknown, entry: DirEntry, params: ImportParams): Promise<void> {
    const root = entry.fullPath || entry.fsRoot || entry.filename;
    if (!root) {
      return;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(root);
    } catch {
      return;
    }

    if (stat.isFile()) {
      await this.processFile(root, params);
    } else if (stat.isDirectory()) {
      let names: string[];
      try {
        names = fs.readdirSync(root);
      } catch {
        return;
      }

      for (const name of names) {
        if (path.extname(name).toLowerCase() !== '.csv') {
          continue;
        }

        const fpath = path.join(root, name);
        if (await this.headerMatches(fpath)) {
          await this.processFile(fpath, params);
        }
      }
    }
  }

  private async processFile(fpath: string, params: ImportParams): Promise<void> {
    const base = path.basename(fpath);
    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', `Failed to read ${base}`, { error: (e as Error).message });

      return;
    }

    let txns: VenmoTxn[];
    try {
      txns = parseVenmo(raw);
    } catch (e) {
      params.log?.('error', `Failed to parse ${base}`, { error: (e as Error).message });

      return;
    }

    for (const t of txns) {
      try {
        this.pushTxn(t, params);
      } catch (e) {
        params.log?.('error', `Failed to import transaction in ${base}`, { error: (e as Error).message });
      }
    }
  }

  // Type × amount-sign → direction-aware classification (same slugs as
  // paypal.ts; mapping.ts routes them to the commerce.* kinds). Undefined = a
  // combination outside the known set (the statement columns give no basis to
  // place it), handled by the caller.
  private classificationFor(t: VenmoTxn): string | undefined {
    const sign = t.amountTotal.startsWith('-') ? '-' : t.amountTotal.startsWith('+') ? '+' : undefined;
    if (t.type === 'Payment') {
      if (sign === '-') {
        return 'payment';
      }

      if (sign === '+') {
        return 'credit';
      }

      return undefined;
    }

    if (t.type === 'Standard Transfer') {
      return 'transfer';
    }

    if (t.type === 'Card Payment' && sign === '+') {
      return 'credit';
    }

    return undefined;
  }

  private pushTxn(t: VenmoTxn, params: ImportParams): void {
    if (!timeframeContains(params.timeframe, t.datetime)) {
      return;
    }

    const classification = this.classificationFor(t);
    if (!classification) {
      params.log?.(
        'warn',
        `Unmapped Venmo transaction type "${t.type}" (${t.amountTotal || 'no amount'}); importing as generic transaction`,
        { id: t.id },
      );
    }

    // The counterparty person: the To name on an outgoing Payment, the From
    // name on an incoming one. Only Payments name a real person — Standard
    // Transfers carry no names and Card Payments put the card scheme in From.
    const edges: Relationship[] = [];
    if (t.type === 'Payment') {
      const counterparty = t.amountTotal.startsWith('-')
        ? { relation: 'to', name: t.to }
        : t.amountTotal.startsWith('+')
          ? { relation: 'from', name: t.from }
          : undefined;
      if (counterparty?.name) {
        edges.push({
          relation: counterparty.relation,
          to: { entity: { type: 'person', name: counterparty.name } },
        });
      }
    }

    const amount = t.amountTotal.replace(/^([+-])\s+/, '$1');
    // A payment OUT is a purchase with one unnamed line — the note is the only
    // description Venmo records. Money in (a credit, a bank transfer) is not a
    // purchase, so it mints no line and therefore no receipt. See
    // push/canonical.ts destinationsFor: a commerce.* record with LineItems
    // also routes to `receipts`.
    const numericAmount = Number(amount.replace(/[^0-9.-]/g, ''));
    const lineTotal = Number.isFinite(numericAmount) ? Math.abs(numericAmount) : undefined;
    const lineItems: LineItemRecord[] | undefined =
      classification === 'payment'
        ? [
            {
              LineNumber: 1,
              Product: t.note || `Venmo payment${t.to ? ` to ${t.to}` : ''}`,
              Quantity: 1,
              Total: lineTotal,
              IsDigital: undefined,
            },
          ]
        : undefined;
    params.pipeline.push({
      item: {
        id: `venmo-${t.id}`,
        classification: classification ?? 'transaction',
        timestamp: t.datetime,
        // No content: a money transfer isn't tied to any document or media
        // we could definitively attach. All facts ride in metadata.
        metadata: {
          // Statement amounts come as "- $12.00" / "+ $74.00"; the sign is
          // collapsed onto the value ("-$12.00") for Title and Amount alike.
          Title:
            [t.note, amount].filter(Boolean).join(': ') || `${t.type} ${t.from}→${t.to}`.trim() || undefined,
          Type: t.type || undefined,
          Status: t.status || undefined,
          Note: t.note || undefined,
          From: t.from || undefined,
          To: t.to || undefined,
          Amount: amount || undefined,
          'Transaction ID': t.id,
          // CANONICAL commerce keys (push/commerceKeys.ts). Venmo has no order
          // id — its transaction id is the reference — and on an outgoing
          // payment the counterparty is who was paid.
          'Order ID': t.id,
          Merchant: classification === 'payment' ? t.to || undefined : undefined,
          Total: lineTotal,
          LineItems: lineItems,
          Source: 'Venmo',
        },
      },
      edges: edges.length ? edges : undefined,
    });
  }
}

registerDataSource({
  name: 'venmo',
  title: 'Venmo',
  icon: '',
  description: 'Transaction history from a Venmo account statement CSV.',
  newFileImporter: () => new VenmoFileImporter(),
});

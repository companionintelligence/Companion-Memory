/* PayPal — CSV download (Activity → Statements → Download). */
import fs from 'node:fs';
import { open, readdir, stat as fsStat } from 'node:fs/promises';
import path from 'node:path';

import { parseCSV } from './csv';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams, LineItemRecord } from './timeline';
import { timeframeContains } from './timeline';

// The PayPal CSV has a BOM and may have metadata rows before the real header.
// The header is the first row whose first cell is "Date".
function parsePayPalCSV(text: string): Record<string, string>[] {
  return parseCSV(text, { findHeader: (r) => (r[0] ?? '').trim() === 'Date' });
}

// Combine "MM/DD/YYYY" date and "HH:MM:SS" time into a Date.
function parsePayPalDate(date: string, time: string): Date | undefined {
  if (!date) {
    return undefined;
  }

  // Reformat MM/DD/YYYY → YYYY-MM-DD
  const parts = date.split('/');
  if (parts.length !== 3) {
    return undefined;
  }

  const [mm, dd, yyyy] = parts;
  const iso = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T${time || '00:00:00'}`;
  const d = new Date(iso);

  return isNaN(d.getTime()) ? undefined : d;
}

/**
 * How far apart a General Card Deposit and the payment it funds may sit and
 * still be treated as one purchase. In observed exports the pair lands on the
 * same second; the window only absorbs clock jitter.
 */
const PAIR_WINDOW_MS = 120_000;

function sniffPayPalHeader(text: string): boolean {
  // Look within first 2 KB for a line containing both "Date" and "Transaction ID"
  const sample = text.slice(0, 2048);

  return sample.includes('"Date"') && sample.includes('"Transaction ID"');
}

export class PayPalFileImporter implements FileImporter {
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
      const base = path.basename(root).toLowerCase();
      if (path.extname(base) !== '.csv') {
        return { confidence: 0 };
      }

      // "download.csv" used to get a moderate confidence bump on the filename
      // alone, no header read at all — but it's a very common browser default
      // filename for ANY CSV saved via a download button, completely
      // unrelated to PayPal. Require the same header check (a "Date" and
      // "Transaction ID" column) every recognized file needs; a same-named
      // file that fails it now correctly returns 0.
      if (await this.headerMatches(root)) {
        return { confidence: 0.9 };
      }

      return { confidence: 0 };
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

  private async headerMatches(fpath: string): Promise<boolean> {
    try {
      const fh = await open(fpath, 'r');
      try {
        const buf = Buffer.alloc(2048);
        const { bytesRead } = await fh.read(buf, 0, 2048, 0);

        return sniffPayPalHeader(buf.toString('utf8', 0, bytesRead));
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

      return;
    }

    if (stat.isDirectory()) {
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

    let rows: Record<string, string>[];
    try {
      rows = parsePayPalCSV(raw);
    } catch (e) {
      params.log?.('error', `Failed to parse ${base}`, { error: (e as Error).message });

      return;
    }

    const completed = rows.filter((r) => !r['Status'] || r['Status'] === 'Completed');
    // When a payment is funded by card, PayPal books a same-instant
    // "General Card Deposit" for the covering amount. That deposit is billing
    // plumbing, not money arriving — suppress any card deposit that sits within
    // PAIR_WINDOW_MS of a payment. Paired on time alone: the amounts can differ
    // when a currency conversion sits between the two legs (EUR payment funded
    // by a USD deposit).
    const paymentTimes: number[] = [];
    for (const r of completed) {
      if (!/payment/i.test(r['Type'] || '')) {
        continue;
      }

      const t = parsePayPalDate(r['Date'], r['Time']);
      if (t) {
        paymentTimes.push(t.getTime());
      }
    }

    for (const row of completed) {
      try {
        this.pushRow(row, paymentTimes, params);
      } catch (e) {
        params.log?.('error', `Failed to import row in ${base}`, { error: (e as Error).message });
      }
    }
  }

  private pushRow(row: Record<string, string>, paymentTimes: number[], params: ImportParams): void {
    const type = row['Type'] || '';
    // An authorization is bookkeeping riding along with the payment it holds
    // funds for (and its Completed row often shares the payment's Transaction
    // ID) — not a money movement of its own.
    if (/authorization/i.test(type)) {
      return;
    }

    // A currency conversion is likewise plumbing: its two legs (-EUR/+USD)
    // just restate a payment that already imports in its own currency.
    if (/currency conversion/i.test(type)) {
      return;
    }

    const ts = parsePayPalDate(row['Date'], row['Time']);
    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    if (/card deposit/i.test(type) && ts) {
      const t = ts.getTime();
      if (paymentTimes.some((p) => Math.abs(p - t) <= PAIR_WINDOW_MS)) {
        return;
      }
    }

    const name = row['Name'] || '';
    // PayPal has two CSV dialects: Activity downloads use Gross/Fee/Net,
    // Statement downloads use Amount/Fees/Total for the same three columns.
    const gross = row['Gross'] || row['Amount'] || '';
    const fee = row['Fee'] || row['Fees'] || '';
    const net = row['Net'] || row['Total'] || '';
    const currency = row['Currency'] || '';
    // Title fallback for rows with neither Name nor Type.
    const summary = name
      ? `${name} ${gross} ${currency}`.trim()
      : `${gross} ${currency}`.trim() || 'PayPal transaction';

    // Direction-aware classification (event_type / commerce.* kind): the bare
    // 'transaction' kind hid whether money came in or went out.
    const amount = parseFloat(gross.replace(/,/g, ''));
    let classification = 'transaction';
    if (/withdrawal/i.test(type)) {
      classification = 'withdrawal';
    } else if (/payment/i.test(type) && amount > 0) {
      classification = 'credit';
    } else if (amount < 0) {
      classification = 'payment';
    }

    // A SPEND row (money left the account) is a purchase with exactly one
    // unnamed line: PayPal records who was paid and how much, never what for.
    // That one line is still worth emitting — it is what turns the row into a
    // receipt with a merchant and a total (push/canonical.ts destinationsFor
    // routes a commerce.* record carrying LineItems to `receipts` as well as
    // `events`). Money COMING IN (a credit, a withdrawal to the bank) is not a
    // purchase and gets no line, so no receipt is minted for it.
    const isSpend = classification === 'payment' || (classification === 'transaction' && amount < 0);
    const lineTotal = Number.isFinite(amount) ? Math.abs(amount) : undefined;
    const lineItems: LineItemRecord[] | undefined = isSpend
      ? [
          {
            LineNumber: 1,
            Product: row['Name'] || row['Type'] || 'PayPal payment',
            Quantity: 1,
            Total: lineTotal,
            Currency: row['Currency'] || undefined,
            // PayPal describes a payment, never a product: nothing here says an
            // object changed hands, so the line cannot claim one did and the
            // digital/physical rule falls back to its own evidence.
            IsDigital: undefined,
          },
        ]
      : undefined;

    params.pipeline.push({
      item: {
        id: row['Transaction ID']
          ? `paypal-${row['Transaction ID']}`
          : `paypal-${row['Date'] || ''}-${row['Time'] || ''}-${gross}-${row['Name'] || ''}`,
        classification,
        timestamp: ts,
        metadata: {
          Name: row['Name'] || undefined,
          Title: row['Name'] || row['Type'] || summary,
          Type: row['Type'] || undefined,
          Status: row['Status'] || undefined,
          Gross: gross || undefined,
          Fee: fee || undefined,
          Net: net || undefined,
          Currency: row['Currency'] || undefined,
          'Transaction ID': row['Transaction ID'] || undefined,
          // CANONICAL commerce keys (push/commerceKeys.ts). PayPal has no order
          // id of its own — the transaction id IS the order reference — and the
          // counterparty is the merchant.
          'Order ID': row['Transaction ID'] || undefined,
          Merchant: isSpend ? row['Name'] || undefined : undefined,
          Total: lineTotal,
          LineItems: lineItems,
          Source: 'PayPal',
        },
      },
    });
  }
}

registerDataSource({
  name: 'paypal',
  title: 'PayPal',
  icon: '',
  description: 'Transaction history from a PayPal Activity CSV download.',
  newFileImporter: () => new PayPalFileImporter(),
});

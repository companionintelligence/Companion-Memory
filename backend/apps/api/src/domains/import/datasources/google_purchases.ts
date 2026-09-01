/* Google Purchases & Reservations — Takeout "Purchases & Reservations" tree.
   One item per action_*.json. Real export ships dining/booking + waitlist
   reservations (-> event); purchase/order variants (-> purchase) are handled
   tolerantly since Google's shapes vary across accounts. Every field is guarded.
*/
import fs from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams, Graph, LineItemRecord } from './timeline';
import { timeframeContains } from './timeline';

// action_<digits>.json — the per-record file Google Takeout emits under
// "Purchases & Reservations".
const ACTION_FILE = /^action_[\w-]+\.json$/i;

function isPurchasesDir(name: string): boolean {
  return /purchases?\s*&?\s*reservations?/i.test(name) || /reservations?/i.test(name);
}

async function* walkActionFiles(root: string, depth = 0): AsyncGenerator<string> {
  if (depth > 5) {
    return;
  }

  let entries: fs.Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      yield* walkActionFiles(p, depth + 1);
    } else if (e.isFile() && ACTION_FILE.test(e.name)) {
      yield p;
    }
  }
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = v.trim();

    return t || undefined;
  }

  if (typeof v === 'number' && Number.isFinite(v)) {
    return String(v);
  }

  return undefined;
}

function numVal(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v;
  }

  if (typeof v === 'string') {
    const n = Number(v.replace(/[^0-9.+-]/g, ''));

    return Number.isFinite(n) ? n : undefined;
  }

  return undefined;
}

function parseDate(s: unknown): Date | undefined {
  const v = str(s);
  if (!v) {
    return undefined;
  }

  const d = new Date(v);

  return isNaN(d.getTime()) ? undefined : d;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export class GooglePurchasesFileImporter implements FileImporter {
  async recognize(_ctx: unknown, entry: DirEntry): Promise<Recognition> {
    const root = entry.fullPath || entry.fsRoot || entry.filename;
    if (!root) {
      return { confidence: 0 };
    }

    let st: fs.Stats;
    try {
      st = await stat(root);
    } catch {
      return { confidence: 0 };
    }

    if (st.isFile()) {
      if (!ACTION_FILE.test(path.basename(root))) {
        return { confidence: 0 };
      }

      // Confirm it's a Google action record (booking/waitlist/order/purchase),
      // not some other tool's action_*.json.
      try {
        const d = JSON.parse(await readFile(root, 'utf8'));
        if (
          d &&
          typeof d === 'object' &&
          (d.booking || d.waitlist || d.order || d.purchase || d.transaction || d.uniqueId)
        ) {
          return { confidence: 0.9 };
        }
      } catch {
        /* ignore */
      }

      return { confidence: 0 };
    }

    if (st.isDirectory()) {
      const base = path.basename(root);
      for await (const _ of walkActionFiles(root)) {
        return { confidence: isPurchasesDir(base) ? 0.95 : 0.85 };
      }

      return { confidence: 0, dir_threshold: 0.7 };
    }

    return { confidence: 0 };
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
      this.processFile(root, params);
    } else if (stat.isDirectory()) {
      for await (const f of walkActionFiles(root)) {
        this.processFile(f, params);
      }
    }
  }

  private processFile(fpath: string, params: ImportParams): void {
    const base = path.basename(fpath);
    let raw: string;
    try {
      raw = fs.readFileSync(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', 'Failed to read Google action file', { file: base, error: (e as Error).message });

      return;
    }

    let d: Record<string, unknown> | undefined;
    try {
      d = obj(JSON.parse(raw));
    } catch {
      return;
    }

    if (!d) {
      return;
    }

    // Stable natural key: Google's per-record uniqueId, falling back to the
    // filename's action_<id> stem so a malformed record still keeps a distinct
    // id (constant-filename items otherwise collapse in hashItem).
    const uid = str(d.uniqueId) || base.replace(/\.json$/i, '');
    const lastModified = parseDate(d.lastModifiedTime);

    const reservation = obj(d.booking) || obj(d.waitlist);
    if (reservation) {
      this.pushReservation(reservation, uid, lastModified, params, !!d.waitlist);

      return;
    }

    const purchase = obj(d.order) || obj(d.purchase) || obj(d.transaction);
    if (purchase) {
      this.pushPurchase(purchase, uid, lastModified, params);

      return;
    }
  }

  private pushReservation(
    b: Record<string, unknown>,
    uid: string,
    lastModified: Date | undefined,
    params: ImportParams,
    waitlist: boolean,
  ): void {
    // Waitlists carry createdTime instead of startTime.
    const ts = parseDate(b.startTime) || parseDate(b.createdTime) || lastModified;
    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    const name = str(b.name) || (waitlist ? 'Waitlist' : 'Reservation');
    const merchant = str(b.merchantName);
    const title = merchant ? `${name} — ${merchant}` : name;
    const g: Graph = {
      item: {
        id: `gpurchase:${uid}`,
        classification: 'event',
        timestamp: ts,
        timespanEnd: parseDate(b.endTime),
        content: {
          filename: 'reservation.txt',
          mediaType: 'text/plain',
          data: async () => Buffer.from(title),
        },
        metadata: {
          Title: title,
          Name: name,
          Merchant: merchant,
          PartySize: numVal(b.partySize),
          Service: str(b.service),
          Address: str(b.address),
          Canceled: typeof b.canceled === 'boolean' ? b.canceled : undefined,
          Kind: waitlist ? 'waitlist' : 'reservation',
          Source: 'Google',
        },
      },
    };
    params.pipeline.push(g);
  }

  private pushPurchase(
    p: Record<string, unknown>,
    uid: string,
    lastModified: Date | undefined,
    params: ImportParams,
  ): void {
    const ts =
      parseDate(p.orderDate) ||
      parseDate(p.purchaseDate) ||
      parseDate(p.time) ||
      parseDate(p.date) ||
      parseDate(p.creationTime) ||
      lastModified;
    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    const merchant = str(p.merchant) || str(p.merchantName) || str(p.seller);
    const product = str(p.name) || str(p.title) || str(p.product) || str(p.description);
    const title = product || merchant || 'Google purchase';
    // Total can be a scalar or a nested { amount, currency } / money shape.
    const priceObj = obj(p.total) || obj(p.price) || obj(p.amount);
    const total =
      numVal(p.total) ??
      numVal(p.price) ??
      numVal(p.amount) ??
      (priceObj ? (numVal(priceObj.amount) ?? numVal(priceObj.value)) : undefined);
    const currency = str(p.currency) || (priceObj ? str(priceObj.currency) : undefined);
    // canonical.ts routes every commerce.purchase record to a receipt
    // unconditionally, so with no LineItems this receipt would always have
    // zero rows in ci.receipt_line_items. One fallback line (matching
    // paypal.ts's/venmo.ts's identical pattern) is better than none.
    const lineItems: LineItemRecord[] | undefined = product
      ? [{ LineNumber: 1, Product: product, Quantity: 1, Total: total, Currency: currency }]
      : undefined;
    const g: Graph = {
      item: {
        id: `gpurchase:${uid}`,
        classification: 'purchase',
        timestamp: ts,
        content: { filename: 'purchase.txt', mediaType: 'text/plain', data: async () => Buffer.from(title) },
        metadata: {
          Title: title,
          Product: product,
          Merchant: merchant,
          Total: total,
          Currency: currency,
          Status: str(p.status),
          // CANONICAL key (push/commerceKeys.ts). This used to be `OrderId`,
          // which no reader looked at — toThingInput reads `Order ID` — so
          // every Google order id was silently dropped on the way to ci.*.
          'Order ID': str(p.orderId) || str(p.orderNumber) || undefined,
          LineItems: lineItems,
          Kind: 'purchase',
          Source: 'Google',
        },
      },
    };
    params.pipeline.push(g);
  }
}

registerDataSource({
  name: 'google_purchases',
  title: 'Google Purchases & Reservations',
  icon: '',
  description:
    'Reservations, waitlists, and purchases from a Google Takeout "Purchases & Reservations" export.',
  newFileImporter: () => new GooglePurchasesFileImporter(),
});

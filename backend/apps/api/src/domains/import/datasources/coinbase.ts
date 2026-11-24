/* Coinbase — CSV transaction history export, or the JSON privacy/GDPR account
   export ("coinbase_data.json", delivered zipped). From the JSON export we
   import the "Financial Data" → "Coinbase transaction history" array; the
   other sections (identity, devices, subscriptions, linked wallets, …) are
   account metadata with no timeline placement and are deliberately skipped. */
import fs from 'node:fs';
import { readdir, stat as fsStat } from 'node:fs/promises';
import path from 'node:path';

import { readCsvFile } from './readers';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import { readHead } from './sniff';
import type { ImportParams } from './timeline';
import { timeframeContains } from './timeline';

// The transaction-history export prefixes a preamble before the real header
// ("Transactions", a "User,..." line, blank lines), so the header isn't always
// row 1. A header row is the first that names the transaction columns. Older
// exports used "Spot Price Currency"; current ones renamed it to "Price
// Currency" — accept either so both old and new files parse.
function looksLikeHeader(row: string[]): boolean {
  return (
    row.some((c) => c.includes('Quantity Transacted')) &&
    row.some((c) => c.includes('Spot Price Currency') || c.includes('Price Currency'))
  );
}

function headerHasCoinbaseCols(text: string): boolean {
  return text.split(/\r?\n/).some((line) => looksLikeHeader([line]));
}

// In the JSON export the "Coinbase transaction history" key sits after the
// bank-account and Coinbase One sections, which puts it tens of KB into the
// file (~48KB in a real sample, and it grows with subscription history) — so
// the sniff window is much larger than the CSV header sniff's.
const JSON_SNIFF_BYTES = 512 * 1024;

function looksLikeCoinbaseJSON(text: string): boolean {
  return text.includes('"Coinbase transaction history"');
}

// Direction-aware classification per transaction kind (same slug convention as
// paypal.ts; mapping.ts routes them to the commerce.* kinds). Buys are
// payments, sells sales, converts conversions, custody moves (on-chain
// sends/receives, bank deposits/withdrawals) transfers, and rewards/income
// (Earn Task, Learning Reward, Staking Income, referral bonuses, …) credits.
function classifyCSVType(txType: string): string {
  const t = txType.toLowerCase();
  if (t.includes('buy')) {
    return 'payment';
  }

  if (t.includes('sell')) {
    return 'sale';
  }

  if (t.includes('convert')) {
    return 'conversion';
  }

  if (/\b(send|receive|withdrawal|deposit)\b/.test(t)) {
    return 'transfer';
  }

  if (/reward|income|earn|referral|interest/.test(t)) {
    return 'credit';
  }

  return 'transaction';
}

type JsonRec = Record<string, unknown>;

function jstr(r: JsonRec, k: string): string {
  return r[k] == null ? '' : String(r[k]);
}

function jamt(r: JsonRec): number {
  const n = parseFloat(jstr(r, 'Amount'));

  return isNaN(n) ? 0 : n;
}

const TRADE_NOTE = /^(bought|sold|converted) /i;

// Some settlement legs carry a bare 24-hex object id in Notes — bookkeeping,
// not a human caption.
const OBJECT_ID_NOTE = /^[0-9a-f]{24}$/i;

function jcaption(r: JsonRec): string {
  const n = jstr(r, 'Notes');

  return OBJECT_ID_NOTE.test(n) ? '' : n;
}

// The export pads quantities to twelve decimals ("0.580000000000").
function trimAmount(s: string): string {
  const n = parseFloat(s);

  return isNaN(n) ? s : String(n);
}

// The JSON export has no type column, so standalone (non-trade) records are
// classified by inference: a crypto hash marks an on-chain wallet transfer; a
// note-less row carrying transfer bookkeeping (payment method / transfer id)
// is a fiat on/off-ramp; a leg of an equal-magnitude cross-currency pair
// (ETH2 → ETH staking unwraps) is an internal move, not income; any other
// incoming amount is a credit (Earn Task, Reward payment, referral bonuses,
// and unlabeled reward payouts alike). What remains — unexplained debits,
// zero-amount bookkeeping rows — stays 'transaction'.
function classifyStandaloneJSON(r: JsonRec, internalMove: boolean): string {
  if (jstr(r, 'Crypto_hash')) {
    return 'transfer';
  }

  if (!jcaption(r) && (jstr(r, 'Transfer_payment_method') || jstr(r, 'Transfer_id'))) {
    return 'transfer';
  }

  if (internalMove) {
    return 'transaction';
  }

  if (jamt(r) > 0) {
    return 'credit';
  }

  return 'transaction';
}

// Ids must be stable across re-exports: a newer export contains extra rows
// that shift every prior row's position, so a row index would re-mint every id
// and duplicate the whole history. Instead the id is built purely from row
// fields, with an occurrence counter appended only when two rows in the same
// file collide on all of them (e.g. identical same-second rewards) — the
// counter depends only on the colliding rows' relative order, not their
// absolute position.
class IdAllocator {
  private seen = new Map<string, number>();

  next(base: string): string {
    const n = this.seen.get(base) ?? 0;
    this.seen.set(base, n + 1);

    return n === 0 ? base : `${base}|${n}`;
  }
}

export class CoinbaseFileImporter implements FileImporter {
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
      const ext = path.extname(base);
      if (ext === '.json') {
        if (await this.jsonMatches(root)) {
          return { confidence: 0.95 };
        }

        // The canonical privacy-export name, in case the transaction-history
        // key sits beyond the sniff window
        if (base.startsWith('coinbase')) {
          return { confidence: 0.5 };
        }

        return { confidence: 0 };
      }

      if (ext !== '.csv') {
        return { confidence: 0 };
      }

      // "transactions.csv"/"coinbase*" used to get a moderate confidence bump
      // on the filename alone, no column check at all — but "transactions.csv"
      // is a generic name any exchange or bank's own CSV download tool could
      // produce, unrelated data included. Require the same header check that
      // already gates the tier above; a same-named file that fails it now
      // correctly returns 0.
      if (await this.headerMatches(root)) {
        return { confidence: 0.95 };
      }

      return { confidence: 0 };
    }

    if (stat.isDirectory()) {
      try {
        const names = await readdir(root);
        for (const name of names) {
          const ext = path.extname(name).toLowerCase();
          const fpath = path.join(root, name);
          if (ext === '.csv' && (await this.headerMatches(fpath))) {
            return { confidence: 0.95 };
          }

          if (ext === '.json' && (await this.jsonMatches(fpath))) {
            return { confidence: 0.95 };
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
    const head = await this.readHead(fpath, 4096);

    return head !== undefined && headerHasCoinbaseCols(head);
  }

  private async jsonMatches(fpath: string): Promise<boolean> {
    const head = await this.readHead(fpath, JSON_SNIFF_BYTES);

    return head !== undefined && looksLikeCoinbaseJSON(head);
  }

  private async readHead(fpath: string, bytes: number): Promise<string | undefined> {
    return (await readHead(fpath, bytes)) ?? undefined;
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
      if (path.extname(root).toLowerCase() === '.json') {
        await this.processJSONFile(root, params);
      } else {
        await this.processFile(root, params);
      }

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
        const ext = path.extname(name).toLowerCase();
        const fpath = path.join(root, name);
        if (ext === '.csv' && (await this.headerMatches(fpath))) {
          await this.processFile(fpath, params);
        } else if (ext === '.json' && (await this.jsonMatches(fpath))) {
          await this.processJSONFile(fpath, params);
        }
      }
    }
  }

  private async processFile(fpath: string, params: ImportParams): Promise<void> {
    const base = path.basename(fpath);
    const rows = await readCsvFile(fpath, { log: params.log, csv: { findHeader: looksLikeHeader } });
    if (rows == null) {
      return;
    }

    const ids = new IdAllocator();
    for (const row of rows) {
      try {
        this.pushRow(row, ids, params);
      } catch (e) {
        params.log?.('error', `Failed to import row in ${base}`, { error: (e as Error).message });
      }
    }
  }

  private async processJSONFile(fpath: string, params: ImportParams): Promise<void> {
    const base = path.basename(fpath);
    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', `Failed to read ${base}`, { error: (e as Error).message });

      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      params.log?.('error', `Failed to parse ${base}`, { error: (e as Error).message });

      return;
    }

    const financial = (parsed as Record<string, unknown> | null)?.['Financial Data'];
    const history = (financial as Record<string, unknown> | null)?.['Coinbase transaction history'];
    if (!Array.isArray(history)) {
      params.log?.('warn', `No transaction history found in ${base}`);

      return;
    }

    const recs = history.filter((r): r is JsonRec => !!r && typeof r === 'object' && !Array.isArray(r));
    const order = new Map(recs.map((r, i) => [r, i]));
    const events: Array<{ rec: JsonRec; counter?: JsonRec; classification: string; summary?: string }> = [];
    const consumed = new Set<JsonRec>();
    const internal = new Set<JsonRec>();

    // One event per trade. The export writes a leg per account (asset debit +
    // cash credit for a sale, …), every leg carrying the same Timestamp and
    // Notes sentence. Group the legs and anchor the event on the leg the
    // sentence is about — the asset sold for a sale, the asset acquired for a
    // buy or convert; the other leg rides along as Counterpart metadata.
    const trades = new Map<string, JsonRec[]>();
    for (const r of recs) {
      if (!TRADE_NOTE.test(jstr(r, 'Notes'))) {
        continue;
      }

      const key = `${jstr(r, 'Timestamp')}\0${jstr(r, 'Notes')}`;
      const legs = trades.get(key);
      if (legs) {
        legs.push(r);
      } else {
        trades.set(key, [r]);
      }
    }

    for (const legs of trades.values()) {
      const note = jstr(legs[0], 'Notes');
      const classification = /^bought/i.test(note) ? 'payment' : /^sold/i.test(note) ? 'sale' : 'conversion';
      const wantNegative = classification === 'sale';
      const primary = legs.find((l) => jamt(l) < 0 === wantNegative) ?? legs[0];
      const counter = legs.find((l) => l !== primary);
      for (const l of legs) {
        consumed.add(l);
      }

      events.push({ rec: primary, counter, classification, summary: note });
    }

    // Uncaptioned legs (no note, or only an object-id note): a cash leg and an
    // opposite asset leg settling within 2 seconds are the two halves of a
    // simple trade — Coinbase stamps the legs up to a couple of seconds apart,
    // so exact-timestamp grouping misses some. Pair each cash leg with the
    // nearest such asset leg: cash debit + asset credit → buy, cash credit +
    // asset debit → sale. Bank movements (payment method) and on-chain moves
    // (crypto hash) never participate.
    const PAIR_WINDOW_MS = 2000;
    const eligible = recs.filter(
      (r) =>
        !consumed.has(r) && !jcaption(r) && !jstr(r, 'Crypto_hash') && !jstr(r, 'Transfer_payment_method'),
    );
    const timeOf = (r: JsonRec): number => new Date(jstr(r, 'Timestamp')).getTime();
    const isUSD = (r: JsonRec): boolean => jstr(r, 'Currency') === 'USD';
    for (const dir of ['buy', 'sale'] as const) {
      const cashSign = dir === 'buy' ? -1 : 1;
      for (const cash of eligible) {
        if (consumed.has(cash) || !isUSD(cash) || Math.sign(jamt(cash)) !== cashSign) {
          continue;
        }

        const t = timeOf(cash);
        if (isNaN(t)) {
          continue;
        }

        let best: JsonRec | undefined;
        let bestDt = Infinity;
        for (const asset of eligible) {
          if (consumed.has(asset) || isUSD(asset) || Math.sign(jamt(asset)) !== -cashSign) {
            continue;
          }

          const dt = Math.abs(timeOf(asset) - t);
          if (dt <= PAIR_WINDOW_MS && dt < bestDt) {
            best = asset;
            bestDt = dt;
          }
        }

        if (!best) {
          continue;
        }

        consumed.add(cash);
        consumed.add(best);
        const qty = trimAmount(jstr(best, 'Amount').replace(/^-/, ''));
        const usd = Math.abs(jamt(cash)).toFixed(2);
        events.push({
          rec: best,
          counter: cash,
          classification: dir === 'buy' ? 'payment' : 'sale',
          summary: `${dir === 'buy' ? 'Bought' : 'Sold'} ${qty} ${jstr(best, 'Currency')} for ${usd} USD`,
        });
      }
    }

    // An equal-and-opposite same-second cross-currency pair (ETH2 → ETH
    // staking unwraps) is an internal move — flag its legs so the credit rule
    // doesn't read them as income.
    const byTs = new Map<string, JsonRec[]>();
    for (const r of eligible) {
      if (consumed.has(r)) {
        continue;
      }

      const key = jstr(r, 'Timestamp');
      const group = byTs.get(key);
      if (group) {
        group.push(r);
      } else {
        byTs.set(key, [r]);
      }
    }

    for (const group of byTs.values()) {
      if (group.length === 2 && jamt(group[0]) !== 0 && jamt(group[0]) === -jamt(group[1])) {
        internal.add(group[0]);
        internal.add(group[1]);
      }
    }

    for (const r of recs) {
      if (consumed.has(r)) {
        continue;
      }

      events.push({ rec: r, classification: classifyStandaloneJSON(r, internal.has(r)) });
    }

    // File order (by anchor leg) keeps the id-collision suffix deterministic.
    events.sort((a, b) => (order.get(a.rec) ?? 0) - (order.get(b.rec) ?? 0));
    const ids = new IdAllocator();
    for (const ev of events) {
      try {
        this.pushJSONEvent(ev, ids, params);
      } catch (e) {
        params.log?.('error', `Failed to import transaction in ${base}`, { error: (e as Error).message });
      }
    }
  }

  private pushJSONEvent(
    ev: { rec: JsonRec; counter?: JsonRec; classification: string; summary?: string },
    ids: IdAllocator,
    params: ImportParams,
  ): void {
    const r = ev.rec;
    const str = (k: string): string => jstr(r, k);

    const tsRaw = str('Timestamp');
    let ts: Date | undefined = tsRaw ? new Date(tsRaw) : undefined;
    if (ts && isNaN(ts.getTime())) {
      ts = undefined;
    }

    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    const amount = str('Amount');
    const currency = str('Currency');
    const notes = str('Notes');
    // Trade events arrive with their Notes sentence (or a synthesized
    // "Bought …") as the summary. For standalone records: descriptive captions
    // are used verbatim, terse ones ("Earn Task") get the movement appended,
    // and uncaptioned records (including bare object-id notes) fall back to a
    // Sent/Received line.
    let summary = ev.summary;
    if (!summary) {
      const caption = jcaption(r);
      const movement = [amount, currency].filter(Boolean).join(' ');
      const verb = amount.startsWith('-') ? 'Sent' : 'Received';
      if (caption && /\d/.test(caption)) {
        summary = caption;
      } else if (caption) {
        summary = movement ? `${caption} (${verb} ${movement})` : caption;
      } else {
        summary = movement ? `${verb} ${movement}` : 'Coinbase transaction';
      }
    }

    // Timestamp + wallet + currency + amount + running balance uniquely
    // identifies the anchor leg (the balance separates otherwise-identical
    // same-second rewards); the allocator suffix is only a collision safety
    // net. Built from the anchor leg alone, so a re-export that drops or adds
    // a counterpart leg cannot re-mint the id.
    const id = ids.next(['coinbase', tsRaw, str('Account_name'), currency, amount, str('Balance')].join('|'));

    const c = ev.counter;
    params.pipeline.push({
      item: {
        id,
        classification: ev.classification,
        timestamp: ts,
        // No content: a money movement isn't tied to any document or media.
        // All facts ride in metadata (same as paypal.ts).
        metadata: {
          Summary: summary,
          Account: str('Account_name') || undefined,
          Amount: amount || undefined,
          Currency: currency || undefined,
          Balance: str('Balance') || undefined,
          Notes: notes || undefined,
          To: str('To') || undefined,
          'Crypto Hash': str('Crypto_hash') || undefined,
          'Transfer ID': str('Transfer_id') || undefined,
          'Transfer Payment Method': str('Transfer_payment_method') || undefined,
          'Transfer Total': str('Transfer_total') || undefined,
          'Transfer Total Currency': str('Transfer_total_currency') || undefined,
          'Counterpart Account': c ? jstr(c, 'Account_name') || undefined : undefined,
          'Counterpart Amount': c ? jstr(c, 'Amount') || undefined : undefined,
          'Counterpart Currency': c ? jstr(c, 'Currency') || undefined : undefined,
          Source: 'Coinbase',
        },
      },
    });
  }

  private pushRow(row: Record<string, string>, ids: IdAllocator, params: ImportParams): void {
    const tsRaw = row['Timestamp'];
    let ts: Date | undefined = tsRaw ? new Date(tsRaw) : undefined;
    if (ts && isNaN(ts.getTime())) {
      ts = undefined;
    }

    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    const txType = row['Transaction Type'] || '';
    const asset = row['Asset'] || '';
    const qty = row['Quantity Transacted'] || '';
    const total = row['Total (inclusive of fees and/or spread)'] || '';
    // Currency column was renamed in the current export ("Spot Price Currency" →
    // "Price Currency"); accept either.
    const currency = row['Spot Price Currency'] || row['Price Currency'] || '';
    const summary =
      txType && asset
        ? `${txType} ${qty} ${asset}${total ? ` for ${total} ${currency}` : ''}`.trim()
        : 'Coinbase transaction';
    const id = ids.next(['coinbase', tsRaw || '', txType, asset, qty, total].join('|'));

    params.pipeline.push({
      item: {
        id,
        classification: classifyCSVType(txType),
        timestamp: ts,
        // No content: a money movement isn't tied to any document or media.
        // All facts ride in metadata (same as paypal.ts).
        metadata: {
          Summary: summary,
          'Transaction Type': row['Transaction Type'] || undefined,
          Asset: row['Asset'] || undefined,
          'Quantity Transacted': row['Quantity Transacted'] || undefined,
          'Spot Price Currency': currency || undefined,
          'Total (inclusive of fees and/or spread)':
            row['Total (inclusive of fees and/or spread)'] || undefined,
          Notes: row['Notes'] || undefined,
          Source: 'Coinbase',
        },
      },
    });
  }
}

registerDataSource({
  name: 'coinbase',
  title: 'Coinbase',
  icon: '',
  description:
    'Transaction history from a Coinbase CSV export or the JSON privacy data export (coinbase_data.json).',
  newFileImporter: () => new CoinbaseFileImporter(),
});

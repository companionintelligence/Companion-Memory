/* Robinhood — brokerage/retirement transaction-history CSV, downloaded from
   Account → Reports and Statements → "Generate a New Report"
   (robinhood.com/account/reports-statements/activity-reports).

   Real header + example rows, fetched and verified directly from the raw file:
   https://github.com/GrantBirki/ghostfolio/blob/main/docs/imports/robinhood.md
   (a community-reverse-engineered format backing a real open-source portfolio
   tracker's own importer) —

     "Activity Date","Process Date","Settle Date","Instrument","Description","Trans Code","Quantity","Price","Amount"
     "9/18/2023","9/18/2023","9/20/2023","O","Realty Income
     CUSIP: 756109104
     Dividend Reinvestment","Buy","0.810399","$53.85","($43.64)"
     "9/15/2023","9/15/2023","9/15/2023","O","Cash Div: R/D 2023-09-01 P/D 2023-09-15 - 170.816188 shares at 0.2555","CDIV","","","$43.64"

   Corroborated independently by:
     - robinhood.com/us/en/support/articles/finding-your-reports-and-statements/:
       "These reports include all your transactions within your brokerage and
       retirement accounts and are downloadable as CSV files" — futures,
       crypto, and the spending account are excluded from the export itself.
     - trademetria.com/integrations/robinhood, whose own documented header is
       "Activity Date,Process Date,Settle Date,Account Type,Instrument,
       Description,Trans Code,Quantity,Price,Amount,Suppressed" — a superset of
       ghostfolio's 9-column example, adding "Account Type" and "Suppressed".
       Both dialects are accepted here: recognition and parsing key off column
       NAME, so a run with or without the two extra columns parses the same.
     - tradereferee.com/brokers/robinhood (a "Verified" real CSV-import
       integration): dates are M/D/YYYY, Amount uses accounting parentheses for
       negatives ("($43.64)" — the exact figure in the ghostfolio example
       above), there is no per-row fee column ("Robinhood is commission-free"),
       and real Trans Codes CDIV/ACH/GOLD (cash rows) plus OEXP/OASGN/
       OEXCISE/OEXC (option lifecycle events) round out the non-trade rows.
     - wealthfolio.app/docs/guide/csv-import/'s Robinhood column mapping:
       Activity Date→date, Instrument→symbol ("bare tickers like AAPL"),
       Trans Code→activityType (Buy→BUY, Sell→SELL, CDIV→DIVIDEND,
       INT→INTEREST, ACH deposit/withdrawal→DEPOSIT/WITHDRAWAL), Price/Amount
       "strip $ and parentheses".
     - github.com/nathancheek/robinhood_capital_gains_estimator, a real
       open-source parser that runs against real downloaded exports: confirms
       the header is checked via `'Activity Date' not in rows[0]`, dates parse
       as `%m/%d/%Y`, Price strips `$` and commas, and the real Trans Code set
       includes Buy/Sell/SPL (stock split) plus CONV/SXCH/MRGS — three
       corporate-action/margin codes the script itself opens at a zero cost
       basis "since we don't have any more info", i.e. non-trade, non-cash
       quantity events, not ordinary buys. It also documents the very real
       quirk that SXCH's Quantity carries a trailing "S" Robinhood appends to
       that code alone ("Strip the 'S' added to SXCH transactions").

   Robinhood issues no per-row transaction id, so a row's id is built from its
   own field values (IdAllocator below — same approach as coinbase.ts's CSV
   path). Trans Code is matched via an explicit allow-list (TRANS_CODES): every
   entry is one of the codes named above by a cited source, never a substring
   guess, and a code outside the set is dropped and logged rather than typed as
   a buy/sell it might not be.

   Not built: the OPTIONS activity report tradereferee.com describes as a
   separate, auto-detected export dialect ("two formats detected
   automatically: the options activity export and the consolidated
   transactions export") — only the consolidated transaction-history CSV
   documented above, which is what this source's guide entry points at. */
import fs from 'node:fs';
import { open, readdir, stat as fsStat } from 'node:fs/promises';
import path from 'node:path';

import { parseCSV } from './csv';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams } from './timeline';
import { timeframeContains } from './timeline';

// The header is the first row naming all three signature columns together.
// "Trans Code" paired with "Instrument" is not a combination any other CSV
// dialect this codebase already parses produces (PayPal/Venmo/Coinbase have
// neither), so requiring all three keeps an unrelated same-named CSV from
// matching on a single common column name alone.
function isRobinhoodHeaderRow(cells: string[]): boolean {
  const trimmed = cells.map((c) => c.trim());

  return (
    trimmed.includes('Activity Date') && trimmed.includes('Trans Code') && trimmed.includes('Instrument')
  );
}

// Quick textual sniff over the first chunk, ahead of a full CSV parse. Works
// whether or not the source quotes its cells: a plain substring match still
// finds "Activity Date" sitting inside a quoted `"Activity Date"` header cell.
function textHasRobinhoodHeader(text: string): boolean {
  return text.includes('Activity Date') && text.includes('Trans Code') && text.includes('Instrument');
}

// "9/18/2023" -> Date. Robinhood's export carries no time component (per
// every cited source's example rows), so Activity Date lands at local
// midnight — same construction as paypal.ts's parsePayPalDate with no time.
function parseActivityDate(raw: string): Date | undefined {
  const s = raw.trim();
  if (!s) {
    return undefined;
  }

  const parts = s.split('/');
  if (parts.length !== 3) {
    return undefined;
  }

  const [mm, dd, yyyy] = parts;
  const d = new Date(`${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T00:00:00`);

  return isNaN(d.getTime()) ? undefined : d;
}

// A multi-line Description (the ghostfolio example's "Realty Income\nCUSIP:
// 756109104\nDividend Reinvestment") collapsed to one line for a Title.
// csv-parse already joins the embedded newlines into one cell value (see
// csv.ts) — this only reformats it for display.
function oneLine(s: string): string {
  return s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' — ');
}

// Trans Code -> (classification, human label). classification feeds
// push/canonical.ts's KIND_BY_CLASSIFICATION -> commerce.* kind; every
// commerce.* kind with no line items routes to `events` alone (no receipt —
// right for a security trade or a cash movement, neither of which is a
// retail purchase with a "thing" behind it; same reasoning coinbase.ts uses
// for buy/sell/transfer/credit).
//
// Matched via an explicit allow-list, never a substring heuristic: every key
// here is a Trans Code one of the cited sources above actually documents
// coming out of a real export. A code outside this set is dropped, not
// guessed into buy/sell — see pushRow's `known` check.
const TRANS_CODES: Record<string, { classification: string; label: string }> = {
  // Trades: a Buy spends cash (payment, matches coinbase.ts's buy->payment);
  // a Sell receives it (sale, matches coinbase.ts's sell->sale).
  Buy: { classification: 'payment', label: 'Buy' },
  Sell: { classification: 'sale', label: 'Sell' },
  // Cash arriving with no trade behind it.
  CDIV: { classification: 'credit', label: 'Cash dividend' },
  INT: { classification: 'credit', label: 'Interest' },
  // A bank movement in either direction — same "direction-neutral transfer"
  // treatment venmo.ts gives a Standard Transfer regardless of sign.
  ACH: { classification: 'transfer', label: 'Bank transfer (ACH)' },
  // The Robinhood Gold subscription fee: a real recurring debit, not a trade.
  GOLD: { classification: 'payment', label: 'Robinhood Gold subscription fee' },
  // Corporate-action / margin / option-lifecycle rows: a quantity or contract
  // state change with no cash trade behind it (nathancheek's script opens
  // CONV/SXCH/MRGS at a zero cost basis for exactly this reason — it has no
  // evidence a real purchase happened). 'transaction' is the generic
  // informational kind (matches paypal.ts's own fallback for a movement that
  // is real but not a purchase/sale/withdrawal/credit), so these are kept as
  // events without asserting a money direction the source doesn't state.
  SPL: { classification: 'transaction', label: 'Stock split' },
  CONV: { classification: 'transaction', label: 'Security conversion' },
  SXCH: { classification: 'transaction', label: 'Stock exchange (corporate action)' },
  MRGS: { classification: 'transaction', label: 'Margin settlement' },
  OEXP: { classification: 'transaction', label: 'Option expiration' },
  OASGN: { classification: 'transaction', label: 'Option assignment' },
  OEXCISE: { classification: 'transaction', label: 'Option exercise' },
  OEXC: { classification: 'transaction', label: 'Option exercise' },
};

// Robinhood issues no per-row transaction id. A row's id is built purely from
// its own field values, with an occurrence counter appended only when two
// rows in the same file collide on all of them — same approach as
// coinbase.ts's IdAllocator, for the same reason: stable across re-imports,
// and immune to a newer export's extra rows shifting everyone's position.
class IdAllocator {
  private seen = new Map<string, number>();

  next(base: string): string {
    const n = this.seen.get(base) ?? 0;
    this.seen.set(base, n + 1);

    return n === 0 ? base : `${base}|${n}`;
  }
}

export class RobinhoodFileImporter implements FileImporter {
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

  // Read only the first ~8KB — the header is always row 1 in every cited
  // sample, but the sniff still runs a real parse-shaped check (all three
  // signature columns as distinct header cells) rather than a bare filename
  // guess, matching paypal.ts/venmo.ts/coinbase.ts's own recognizers.
  private async headerMatches(fpath: string): Promise<boolean> {
    try {
      const fh = await open(fpath, 'r');
      try {
        const buf = Buffer.alloc(8192);
        const { bytesRead } = await fh.read(buf, 0, 8192, 0);

        return textHasRobinhoodHeader(buf.toString('utf8', 0, bytesRead));
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
      rows = parseCSV(raw, { findHeader: isRobinhoodHeaderRow });
    } catch (e) {
      params.log?.('error', `Failed to parse ${base}`, { error: (e as Error).message });

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

  private pushRow(row: Record<string, string>, ids: IdAllocator, params: ImportParams): void {
    const code = (row['Trans Code'] || '').trim();
    if (!code) {
      // A blank Trans Code marks a running-total / footer row some exports
      // append — never a transaction (same treatment venmo.ts gives its
      // empty-ID summary rows).
      params.pipeline.drop?.('empty_trans_code', row['Description'] || undefined);

      return;
    }

    const known = TRANS_CODES[code];
    if (!known) {
      params.log?.('warn', `Unrecognized Robinhood Trans Code "${code}"; dropping row rather than guessing`, {
        description: row['Description'],
      });
      params.pipeline.drop?.('unrecognized_trans_code', code);

      return;
    }

    const ts = parseActivityDate(row['Activity Date'] || '');
    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    const instrument = (row['Instrument'] || '').trim();
    const description = row['Description'] || '';
    // Quantity/Price stay ABSENT (not coerced to 0) on the many rows that
    // carry no trade — CDIV/ACH/GOLD/etc. leave both columns blank in every
    // cited example — and Quantity keeps its full fractional precision (a
    // dividend reinvestment buys partial shares, e.g. "0.810399") since it is
    // never parsed as a number here at all, only carried through as text.
    const quantity = row['Quantity'] || '';
    const price = row['Price'] || '';
    const amount = row['Amount'] || '';

    const title =
      oneLine(description) || [known.label, instrument].filter(Boolean).join(' ') || 'Robinhood transaction';

    // Built from every field on the row: two rows can share a date, code and
    // instrument (e.g. two same-day dividend reinvestments) but not share
    // Description/Quantity/Price/Amount as well, and the allocator suffix
    // catches it if they somehow do.
    const id = ids.next(
      [
        'robinhood',
        row['Activity Date'] || '',
        row['Process Date'] || '',
        row['Settle Date'] || '',
        instrument,
        code,
        quantity,
        price,
        amount,
        description,
      ].join('|'),
    );

    params.pipeline.push({
      item: {
        id,
        classification: known.classification,
        timestamp: ts,
        // No content: a trade or cash movement isn't tied to any document or
        // media we could attach. All facts ride in metadata (same as
        // coinbase.ts/paypal.ts).
        metadata: {
          Title: title,
          'Activity Date': row['Activity Date'] || undefined,
          'Process Date': row['Process Date'] || undefined,
          'Settle Date': row['Settle Date'] || undefined,
          // Present only in the 11-column dialect (trademetria.com) —
          // absent, not "", in the 9-column one (ghostfolio.md).
          'Account Type': row['Account Type'] || undefined,
          Instrument: instrument || undefined,
          Description: description || undefined,
          'Trans Code': code,
          'Trans Code Label': known.label,
          Quantity: quantity || undefined,
          Price: price || undefined,
          Amount: amount || undefined,
          Suppressed: row['Suppressed'] || undefined,
          Source: 'Robinhood',
        },
      },
    });
  }
}

registerDataSource({
  name: 'robinhood',
  title: 'Robinhood',
  icon: '',
  description: 'Brokerage/retirement transaction history from a Robinhood Reports & Statements CSV.',
  newFileImporter: () => new RobinhoodFileImporter(),
});

/* Withings — body measurement CSV export (weight.csv and related CSVs).
   A Withings export is a set of CSVs (weight.csv, height.csv, blood_pressure.csv,
   activities.csv, ...). Every file has a leading "Date" column; we emit one
   'observation' per row, carrying every non-empty column as metadata. The
   signature is generic (*.csv) so recognition sniffs the header to avoid
   false-matching other CSV importers. */
import fs from 'node:fs';
import path from 'node:path';

import { parseCSV } from './csv';
import { CsvExportImporter, type CsvExportSpec } from './csvImporter';
import { registerDataSource } from './registry';
import { readHead, stripBom } from './sniff';
import type { ImportParams } from './timeline';
import { textContent, timeframeContains, timeframeIsEmpty } from './timeline';

// Extract the header line from raw CSV text (BOM already stripped by caller).
function headerLine(text: string): string {
  const nl = text.indexOf('\n');

  return (nl === -1 ? text : text.slice(0, nl)).replace(/\r$/, '');
}

// A statistic ABOUT a measurement is not a measurement.
//
// Google Fit's aggregate `Daily activity metrics.csv` begins with "Date," and
// carries "Average weight (kg)", "Max weight (kg)" and "Min weight (kg)" — which
// is all the old `header.includes('(kg)')` needed. A Google Takeout's Fit data
// therefore staged as 1,661 rows of `data_source='withings'` carrying
// `Source: "Withings"`, and Withings appeared in the run's services as though
// the user had exported from it. Withings names its columns outright
// ("Weight (kg)", "Fat mass (kg)"); no Withings export prefixes one with an
// aggregate.
const AGGREGATE_COLUMN = /^(average|max|min|total|mean|median)\b/i;

function isMeasurementColumn(column: string): boolean {
  const name = column.trim();

  if (AGGREGATE_COLUMN.test(name)) {
    return false;
  }

  return name.includes('(kg)') || name.includes('Weight');
}

// A Withings CSV header begins with "Date," and carries a body-measurement
// column such as "(kg)" or "Weight". This is specific enough to avoid matching
// other CSV importers (e.g. Netflix's "Start Time,...").
function headerLooksLikeWithings(header: string): boolean {
  if (!header.startsWith('Date,') && header.trim() !== 'Date') {
    return false;
  }

  return header.split(',').some(isMeasurementColumn);
}

// Read the first ~4KB and inspect the CSV header row.
async function sniffHeader(fpath: string): Promise<string | undefined> {
  const head = await readHead(fpath);

  return head == null ? undefined : headerLine(stripBom(head));
}

async function csvMatches(fpath: string): Promise<boolean> {
  const header = await sniffHeader(fpath);

  return header !== undefined && headerLooksLikeWithings(header);
}

// Parse a Withings "YYYY-MM-DD HH:MM:SS" date (treated as UTC). Returns
// undefined for anything unparseable.
function parseWithingsDate(raw: string): Date | undefined {
  if (!raw) {
    return undefined;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  // "2024-01-15 08:30:00" -> ISO; also tolerate values already containing 'T'/'Z'.
  let candidate = trimmed;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(candidate)) {
    candidate = candidate.replace(' ', 'T') + 'Z';
  }

  let d = new Date(candidate);
  if (isNaN(d.getTime())) {
    d = new Date(trimmed);
  }

  return isNaN(d.getTime()) ? undefined : d;
}

export class WithingsFileImporter extends CsvExportImporter {
  protected readonly spec: CsvExportSpec = {
    isNamed: (name) => name === 'weight.csv',
    headerMatches: (fpath) => csvMatches(fpath),
    confidence: { named: 0.95, sniffed: 0.85 },
    importInDir: 'all-csv',
  };

  protected async processFile(fpath: string, params: ImportParams): Promise<void> {
    const base = path.basename(fpath);
    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', `Failed to read ${base}`, { error: (e as Error).message });

      return;
    }

    if (raw.charCodeAt(0) === 0xfeff) {
      raw = raw.slice(1);
    }

    let rows: Record<string, string>[];
    try {
      rows = parseCSV(raw);
    } catch (e) {
      params.log?.('error', `Failed to parse ${base}`, { error: (e as Error).message });

      return;
    }

    if (!rows.length) {
      return;
    }

    // Only process files that carry a Date column (every Withings CSV does).
    if (!('Date' in rows[0])) {
      return;
    }

    rows.forEach((row, i) => {
      try {
        this.pushRow(row, base, i, params);
      } catch (e) {
        params.log?.('error', `Failed to import row in ${base}`, { error: (e as Error).message });
      }
    });
  }

  private pushRow(row: Record<string, string>, base: string, index: number, params: ImportParams): void {
    const ts = parseWithingsDate(row['Date'] || '');
    // An undated row has no timestamp to test; timeframeContains() returns true
    // for an undefined ts (platform convention), which would leak malformed rows
    // through an active since/until filter. Drop undated rows when a timeframe is
    // actually set, but keep them when no filter is requested.
    if (!ts && !timeframeIsEmpty(params.timeframe)) {
      return;
    }

    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    // Carry every non-empty column as metadata; numeric columns become numbers.
    const metadata: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === 'Date') {
        continue;
      }

      if (value === undefined || value === '') {
        continue;
      }

      const num = Number(value);
      // Coerce to a number only when the value round-trips losslessly. This keeps
      // genuine floats numeric (e.g. "82.4") while preserving string-ID columns
      // such as zero-padded "007" (which would otherwise become 7). Number('1,234')
      // is already NaN, so thousands-separated values stay strings.
      const numeric = value !== '' && !isNaN(num) && /^[-+]?[0-9.]+$/.test(value) && String(num) === value;
      metadata[key] = numeric ? num : value;
    }

    metadata.File = base;
    metadata.Source = 'Withings';
    // Without a title key, titleFor() falls back to the constant 'observation.txt'
    // filename. Derive a label from the file + row Date so each measurement reads
    // e.g. "weight — 2024-01-15 08:30:00".
    const measure = base.replace(/\.csv$/i, '').replace(/[_-]+/g, ' ');
    metadata.Title = row['Date'] ? `${measure} — ${row['Date']}` : measure;

    // Human-readable text body summarizing the measurement.
    const summaryParts = Object.entries(row)
      .filter(([k, v]) => k !== 'Date' && v !== '')
      .map(([k, v]) => `${k}: ${v}`);
    const text = [row['Date'] ? `Date: ${row['Date']}` : '', ...summaryParts].filter(Boolean).join('\n');

    params.pipeline.push({
      item: {
        // Stable natural key: source file + raw Date + per-file row index. The
        // file name and Date alone collide across CSVs synced at the same instant
        // (weight.csv vs blood_pressure.csv) and undated rows share an empty Date,
        // so the parse-order index disambiguates without depending on timestamp.
        id: `withings:${base}:${(row['Date'] || '').trim()}:${index}`,
        classification: 'observation',
        timestamp: ts,
        content: textContent('observation.txt', text),
        metadata,
      },
    });
  }
}

registerDataSource({
  name: 'withings',
  title: 'Withings',
  icon: '',
  description: 'Body measurements from a Withings data export (weight.csv and related CSVs).',
  newFileImporter: () => new WithingsFileImporter(),
});

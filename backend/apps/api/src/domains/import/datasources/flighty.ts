/* Flighty flight log datasource (TypeScript port - simplified) */
import fs from 'fs';
import path from 'path';

import { parseCSVRows } from './csv';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import { timeframeContains } from './timeline';
import type { ImportParams, Metadata } from './timeline';

interface FlightyOptions {
  ownerEntityId?: number;
}

interface FlightRecord {
  // Minimal fields from CSV
  id: string;
  airline: string;
  flightNumber: string;
  from: string;
  to: string;
  takeOffActual?: string;
  landingActual?: string;
  notes?: string;
}

class FlightyImporter implements FileImporter {
  private filePattern = /^FlightyExport-\d{4}-\d{2}-\d{2}\.csv$/i;

  async recognize(_ctx: unknown, entry: DirEntry): Promise<Recognition> {
    const fname = path.basename(entry.filename);
    if (this.filePattern.test(fname)) {
      return { confidence: 1 };
    }

    return { confidence: 0 };
  }

  async fileImport(_ctx: unknown, entry: DirEntry, params: ImportParams): Promise<void> {
    const full = entry.fullPath || entry.filename;
    const content = await fs.promises.readFile(full, 'utf8');
    const rows = parseCSVRows(content).filter((r) => r.some((v) => v.trim() !== ''));
    if (rows.length < 2) {
      return;
    } // header + at least one record

    const headers = rows[0].map((h) => h.trim());
    const required = ['Flight Flighty ID', 'Airline', 'Flight', 'From', 'To'];
    // A file that reaches fileImport but lacks the Flighty columns (e.g. a
    // mislabeled or corrupt CSV) is not ours to parse — degrade gracefully
    // rather than throwing, per the importer robustness contract.
    for (const req of required) {
      if (!headers.includes(req)) {
        params.log?.('warn', `flighty: CSV missing required '${req}' column — skipping`, {
          file: path.basename(full),
        });

        return;
      }
    }

    const idx = (h: string) => headers.indexOf(h);
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row.length < headers.length) {
        continue;
      }

      const rec: FlightRecord = {
        id: row[idx('Flight Flighty ID')],
        airline: row[idx('Airline')],
        flightNumber: row[idx('Flight')],
        from: row[idx('From')],
        to: row[idx('To')],
        takeOffActual: row[idx('Take off (Actual)')],
        landingActual: row[idx('Landing (Actual)')],
        notes: row[idx('Notes')],
      };
      const takeoffTs = rec.takeOffActual ? parseLocalDate(rec.takeOffActual) : undefined;
      const landingTs = rec.landingActual ? parseLocalDate(rec.landingActual) : undefined;
      // A user-scoped or date-bounded re-import (e.g. "only flights since last
      // sync") must exclude flights outside the requested window, the same as
      // every sibling importer in this directory gates on params.timeframe.
      if (!timeframeContains(params.timeframe, takeoffTs)) {
        continue;
      }

      const metadata: Metadata = {
        'Flight airline': rec.airline,
        'Flight number': rec.flightNumber,
        'Flight from IATA': rec.from,
        'Flight to IATA': rec.to,
        Title: `${rec.flightNumber} ${rec.from}→${rec.to}` + (rec.airline ? ` (${rec.airline})` : ''),
      };
      params.pipeline.push({
        item: {
          classification: 'trip',
          timestamp: takeoffTs,
          timespanEnd: landingTs,
          metadata,
          content: {
            filename: `flight-${rec.id}.md`,
            data: async () => Promise.resolve(Buffer.from(`# Flight ${rec.flightNumber}\n${rec.airline}`)),
          },
        },
      });
      if (rec.notes) {
        const notes = rec.notes; // Capture for type safety
        params.pipeline.push({
          item: {
            timestamp: landingTs,
            metadata: {
              Notes: notes,
              Title: `Notes — ${rec.flightNumber} ${rec.from}→${rec.to}`,
            } as Metadata,
            content: {
              filename: `flight-${rec.id}-notes.txt`,
              data: async () => Promise.resolve(Buffer.from(notes)),
            },
          },
        });
      }
    }
  }
}

function parseLocalDate(val: string): Date | undefined {
  // Expect format YYYY-MM-DDTHH:MM (no timezone); treat as local
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})$/.exec(val.trim());
  if (!m) {
    return undefined;
  }

  return new Date(m[1].replace('T', ' ') + ':00'); // crude; refine later
}

registerDataSource({
  name: 'flighty',
  title: 'Flighty',
  icon: 'flighty.png',
  description: 'Flighty exported flight log CSV',
  newOptions: () => ({}) as FlightyOptions,
  newFileImporter: () => new FlightyImporter(),
});

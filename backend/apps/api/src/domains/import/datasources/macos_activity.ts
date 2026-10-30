import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';

import Database from 'better-sqlite3';
import { z } from 'zod/v3';

import { macosItem, readMacosRows } from './macosActivityRecords';
import type { DirEntry, FileImporter, Recognition } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams } from './timeline';
import { timeframeContains } from './timeline';

const MANIFEST = 'macos-activity.json';
const manifestSchema = z.object({
  format: z.literal('ci-macos-activity'),
  version: z.literal(1),
  deviceId: z.string().regex(/^[a-f0-9]{64}$/),
  exportedAt: z.string().datetime({ offset: true }),
  sources: z
    .array(
      z.object({
        name: z.enum(['knowledge', 'safari', 'calls']),
        status: z.enum(['ok', 'unavailable']),
      }),
    )
    .min(1)
    .max(3)
    .refine((sources) => new Set(sources.map((s) => s.name)).size === sources.length),
});

async function readManifest(root: string): Promise<unknown> {
  const file = path.join(root, MANIFEST);
  if ((await stat(file)).size > 64 * 1024) {
    throw new Error('macOS snapshot manifest is too large');
  }

  return JSON.parse(await readFile(file, 'utf8'));
}

export class MacosActivityFileImporter implements FileImporter {
  async recognize(_ctx: unknown, entry: DirEntry): Promise<Recognition> {
    const root = entry.fullPath || entry.filename;
    try {
      z.object({ format: z.literal('ci-macos-activity') }).parse(await readManifest(root));

      return { confidence: 1 };
    } catch {
      return { confidence: 0 };
    }
  }

  async fileImport(_ctx: unknown, entry: DirEntry, params: ImportParams): Promise<void> {
    const root = await realpath(entry.fullPath || entry.filename);
    if (!(await stat(root)).isDirectory()) {
      return;
    }

    const manifest = manifestSchema.parse(await readManifest(root));
    const failures: string[] = [];
    for (const source of manifest.sources) {
      if (source.status !== 'ok') {
        failures.push(`${source.name}: unavailable during export (see manifest)`);
        continue;
      }

      let db: Database.Database | undefined;
      try {
        const file = await realpath(path.join(root, `${source.name}.sqlite`));
        if (path.dirname(file) !== root) {
          throw new Error('Snapshot database must be inside the export directory');
        }

        db = new Database(file, { readonly: true, fileMustExist: true });
        db.pragma('query_only = ON');
        db.pragma('trusted_schema = OFF');
        let count = 0;
        for (const row of readMacosRows(db, source.name)) {
          params.pipeline.consumed?.(1);
          const result = macosItem(row, source.name, manifest.deviceId);
          if ('drop' in result) {
            params.pipeline.drop?.(result.drop);
          } else if (!timeframeContains(params.timeframe, result.item.timestamp)) {
            params.pipeline.drop?.('outside_timeframe');
          } else {
            params.pipeline.push({ item: result.item });
          }

          if (++count % 250 === 0) {
            await setImmediate();
          }
        }
      } catch (error) {
        failures.push(`${source.name}: ${(error as Error).message}`);
      } finally {
        db?.close();
      }
    }

    // ParseStage preserves staged successes and records this source as partial.
    if (failures.length) {
      throw new Error(`macOS snapshot incomplete: ${failures.join('; ')}`);
    }
  }
}

registerDataSource({
  name: 'macos_activity',
  title: 'macOS Activity',
  icon: '',
  description: 'App and device activity, Safari visits, and calls from a read-only macOS snapshot.',
  newFileImporter: () => new MacosActivityFileImporter(),
});

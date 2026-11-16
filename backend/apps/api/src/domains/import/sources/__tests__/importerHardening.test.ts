import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import '../../datasources';
import type { EmittedGraph } from '../../datasources/__tests__/support/emitted';
import { allDataSources } from '../../datasources/registry';
import type { Item, ImportParams } from '../../datasources/timeline';
import { WIZARD_SOURCES } from '../guides';

/**
 * Every importer a guide advertises as ready must degrade gracefully.
 *
 * Real exports are messy: a truncated download, a file the service renamed, a
 * CSV with a stray NUL. A parser that throws on any of those fails the whole
 * parse stage — and with it the other five sources in the same Takeout, which is
 * exactly the "one bad parser must not fail the import" rule the stage runner
 * exists to enforce. This checks the parsers hold up their end.
 *
 * The list is DERIVED from the guides rather than hardcoded, so promoting a new
 * importer to ready automatically enrols it. That is also why the count is
 * asserted: a derivation that silently collapsed to nothing would pass every
 * other case in this file.
 */

/**
 * `generic` is the deliberate catch-all — it recognizes any file and wraps it as
 * a media item, so it is expected to emit something for any input. It is not a
 * format parser, and holding it to "empty in, nothing out" would be testing the
 * opposite of its job.
 */
const EXCLUDED = new Set(['generic']);

const READY_IMPORTERS = Array.from(
  new Set(WIZARD_SOURCES.filter((source) => source.importerReady).map((s) => s.importer ?? s.id)),
)
  .filter((name) => Boolean(allDataSources().find((source) => source.name === name)?.newFileImporter))
  .filter((name) => !EXCLUDED.has(name))
  .sort();

/** Every folder `tempFile` makes, removed after each test whether it passed or not. */
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempFile(contents: string | Buffer, name = 'garbage'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-harden-'));

  tempDirs.push(dir);
  const filePath = path.join(dir, name);

  fs.writeFileSync(filePath, contents);

  return filePath;
}

async function importFile(name: string, fullPath: string): Promise<Item[]> {
  const dataSource = allDataSources().find((source) => source.name === name);

  if (!dataSource?.newFileImporter) {
    throw new Error(`missing importer: ${name}`);
  }

  const pipeline: EmittedGraph[] = [];

  await dataSource.newFileImporter().fileImport({}, { filename: path.basename(fullPath), fullPath }, {
    pipeline,
    timeframe: {},
    log: () => {},
  } as unknown as ImportParams);

  return pipeline.filter((graph) => graph.item).map((graph) => graph.item);
}

describe('importer robustness', () => {
  it('covers a substantial set of ready file importers', () => {
    expect(READY_IMPORTERS.length).toBeGreaterThanOrEqual(30);
  });

  for (const name of READY_IMPORTERS) {
    it(`${name}: malformed input does not throw`, async () => {
      // Real bytes, including NUL and high bytes — a truncated download or a
      // mislabelled binary is what actually reaches these parsers, and a string of
      // printable text is a much softer test. Built with escapes so the FIXTURE is
      // binary without the SOURCE FILE being binary, which git would otherwise treat
      // as unreviewable.
      const garbage = tempFile(
        Buffer.concat([
          Buffer.from('not a valid export\n{ broken json,,,\n', 'utf8'),
          Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]),
          Buffer.from(' binary', 'utf8'),
        ]),
      );

      await expect(importFile(name, garbage)).resolves.toBeDefined();
    });

    it(`${name}: empty input yields no items`, async () => {
      expect(await importFile(name, tempFile(''))).toHaveLength(0);
    });
  }
});

describe('WhatsApp format variants', () => {
  it('parses the Android export format (DD/MM/YYYY, HH:MM - Sender: text)', async () => {
    const chat = [
      '31/12/2024, 23:59 - Alice: Happy new year',
      '01/01/2025, 00:00 - Bob: Cheers',
      '01/01/2025, 00:01 - Alice: See you soon',
    ].join('\n');

    const items = await importFile('whatsapp', tempFile(chat, '_chat.txt'));

    expect(items).toHaveLength(3);
    expect(items.every((item) => item.classification === 'message')).toBe(true);
    expect(items.map((item) => item.metadata?.Sender)).toEqual(['Alice', 'Bob', 'Alice']);
    // The Android format carries no zone, so the exact ISO string is
    // environment-dependent; that it resolved to a real date is the assertion.
    expect(items[0].timestamp).toBeInstanceOf(Date);
  });

  it('folds multi-line messages into the preceding entry', async () => {
    const chat = [
      '01/01/2025, 09:00 - Alice: line one',
      'still alice, second line',
      '01/01/2025, 09:01 - Bob: ok',
    ].join('\n');

    expect(await importFile('whatsapp', tempFile(chat, '_chat.txt'))).toHaveLength(2);
  });
});

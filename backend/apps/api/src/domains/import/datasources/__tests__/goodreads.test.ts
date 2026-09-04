import fs from 'node:fs';
import os from 'node:os';
import path from 'path';

import { GoodreadsFileImporter } from '../goodreads';
import type { ImportParams } from '../timeline';

import type { EmittedGraph } from './support/emitted';

// CSV header for a Goodreads library export, plus rows that share the SAME
// 'Date Added' and no 'Date Read'. Before the id fix these collapsed to a
// single dedup key: sha1(data_source \0 classification \0 'book.txt' \0 ''
// \0 ISO(midnight-of-day) \0 ''). Each row carries a distinct 'Book Id'.
const HEADER =
  'Book Id,Title,Author,My Rating,Average Rating,Publisher,Binding,Number of Pages,Year Published,My Review,Exclusive Shelf,Date Read,Date Added,ISBN,ISBN13,Bookshelves';
const ROWS = [
  '1001,Dune,Frank Herbert,5,4.25,Ace,Paperback,412,1965,,read,,2024/03/01,="0441013597",="9780441013593",sci-fi',
  '1002,Neuromancer,William Gibson,4,3.89,Ace,Paperback,271,1984,,read,,2024/03/01,="0441569595",="9780441569595",sci-fi',
  '1003,Foundation,Isaac Asimov,5,4.16,Spectra,Paperback,244,1951,,read,,2024/03/01,="0553293354",="9780553293357",sci-fi',
];

function writeExport(): string {
  const tmp = path.join(
    os.tmpdir(),
    `goodreads_library_export-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`,
  );
  fs.writeFileSync(tmp, `${HEADER}\n${ROWS.join('\n')}\n`);

  return tmp;
}

async function importRows(fpath: string): Promise<EmittedGraph[]> {
  const fi = new GoodreadsFileImporter();
  const pipeline: EmittedGraph[] = [];
  await fi.fileImport({}, { filename: path.basename(fpath), fullPath: fpath }, {
    pipeline,
    timeframe: {},
    log: () => {},
  } as unknown as ImportParams);

  return pipeline;
}

describe('Goodreads datasource', () => {
  it('assigns a unique stable id to every book even when Date Added collides', async () => {
    const fpath = writeExport();
    try {
      const pipeline = await importRows(fpath);
      expect(pipeline.length).toBe(ROWS.length);

      const ids = pipeline.map((p) => p.item.id!);
      // (a) every id truthy
      expect(ids.every((id) => !!id)).toBe(true);
      // (b) no collisions despite identical timestamp + constant filename
      expect(new Set(ids).size).toBe(pipeline.length);
    } finally {
      await fs.promises.unlink(fpath).catch(() => {});
    }
  });

  it('produces identical ids on re-import (idempotent)', async () => {
    const fpath = writeExport();
    try {
      const first = (await importRows(fpath)).map((p) => p.item.id!);
      const second = (await importRows(fpath)).map((p) => p.item.id!);
      expect(second).toEqual(first);
      expect(first).toEqual(['goodreads:1001', 'goodreads:1002', 'goodreads:1003']);
    } finally {
      await fs.promises.unlink(fpath).catch(() => {});
    }
  });

  it("classifies a shelved book without a review as 'annotation'", async () => {
    const fpath = writeExport();
    try {
      const pipeline = await importRows(fpath);
      // Every ROW has an empty 'My Review' (shelved, not reviewed); these used
      // to fall through to the unmapped 'interaction' classification.
      expect(pipeline.every((p) => p.item.classification === 'annotation')).toBe(true);
    } finally {
      await fs.promises.unlink(fpath).catch(() => {});
    }
  });

  // SRC-01. A `reading.annotation` routes to `content` only, and that row's
  // `text` is read from metadata by `descriptionFor` — the review body attached
  // to `item.content.data` is never loaded on the push path.
  it('carries My Review in metadata.Text, and omits the key when there is none', async () => {
    const tmp = path.join(
      os.tmpdir(),
      `goodreads_library_export-review-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`,
    );
    fs.writeFileSync(
      tmp,
      `${HEADER}\n` +
        '2001,Dune,Frank Herbert,5,4.25,Ace,Paperback,412,1965,"A desert planet and a long argument about power.",read,,2024/03/01,="0441013597",="9780441013593",sci-fi\n' +
        `${ROWS[1]}\n`,
    );
    try {
      const pipeline = await importRows(tmp);
      expect(pipeline.length).toBe(2);

      const reviewed = pipeline[0].item;
      expect(reviewed.metadata.Text).toBe('A desert planet and a long argument about power.');
      expect(reviewed.metadata.Text).toBe((await reviewed.content!.data!()).toString('utf8'));

      // Shelved-only row: no review body to carry, so no empty Text key.
      expect(pipeline[1].item.metadata.Text).toBeUndefined();
    } finally {
      await fs.promises.unlink(tmp).catch(() => {});
    }
  });

  describe('directory-based recognition (non-exact filename, header sniff)', () => {
    // recognize()/fileImport() both fall back to scanning a directory's *.csv
    // files for Goodreads-shaped headers when no exact
    // 'goodreads_library_export.csv' is present — e.g. a user renamed the
    // export, or it sits alongside other CSVs. That path (headerHasGoodreadsCols
    // via headerMatches) is never exercised by writeExport() above, which
    // always uses the exact filename.

    function makeDir(): string {
      return fs.mkdtempSync(path.join(os.tmpdir(), 'goodreads-dir-'));
    }

    it('recognizes a differently-named CSV in a directory by its header row', async () => {
      const dir = makeDir();
      try {
        const fpath = path.join(dir, 'my_library.csv');
        fs.writeFileSync(fpath, `${HEADER}\n${ROWS[0]}\n`);

        const fi = new GoodreadsFileImporter();
        const rec = await fi.recognize({}, { filename: path.basename(dir), fullPath: dir });
        expect(rec.confidence).toBeCloseTo(0.7);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('imports via the differently-named CSV once recognized', async () => {
      const dir = makeDir();
      try {
        const fpath = path.join(dir, 'my_library.csv');
        fs.writeFileSync(fpath, `${HEADER}\n${ROWS[0]}\n`);

        const pipeline = await importRows(dir);
        expect(pipeline.length).toBe(1);
        expect(pipeline[0].item.id).toBe('goodreads:1001');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('rejects a header carrying both "Book Id" and "Letterboxd URI" (not a Goodreads export)', async () => {
      // headerHasGoodreadsCols() requires "Book Id" AND absence of
      // "Letterboxd URI" — this is the guard that must reject a Letterboxd-ish
      // export even if a "Book Id"-shaped column were ever present in one.
      const dir = makeDir();
      try {
        const fpath = path.join(dir, 'export.csv');
        fs.writeFileSync(fpath, 'Book Id,Name,Letterboxd URI,Rating\n1,A Movie,https://letterboxd.com/x,4\n');

        const fi = new GoodreadsFileImporter();
        const rec = await fi.recognize({}, { filename: path.basename(dir), fullPath: dir });
        expect(rec.confidence).toBe(0);

        const pipeline = await importRows(dir);
        expect(pipeline.length).toBe(0);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('rejects a real Letterboxd diary.csv header (no "Book Id" at all)', async () => {
      const dir = makeDir();
      try {
        const fpath = path.join(dir, 'diary.csv');
        fs.writeFileSync(
          fpath,
          'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n2024-01-01,Dune,2021,https://letterboxd.com/x,4.5,,,2024-01-01\n',
        );

        const fi = new GoodreadsFileImporter();
        const rec = await fi.recognize({}, { filename: path.basename(dir), fullPath: dir });
        expect(rec.confidence).toBe(0);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('pushRow id fallback chain (Book Id -> ISBN13 -> ISBN -> title|author)', () => {
    // Every row in the top-level fixture carries a 'Book Id', so the
    // ISBN13/ISBN/title-fallback branches of
    // `row['Book Id'] || row['ISBN13'] || row['ISBN'] || \`${title}|${author}\``
    // are otherwise never hit — exactly the rows a real export produces when
    // a manually-added book has no Book Id.

    function writeRow(headerCols: string[], row: string[]): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goodreads-idfallback-'));
      const fpath = path.join(dir, 'goodreads_library_export.csv');
      fs.writeFileSync(fpath, `${headerCols.join(',')}\n${row.join(',')}\n`);

      return fpath;
    }

    const BASE_HEADER = ['Book Id', 'Title', 'Author', 'ISBN', 'ISBN13', 'My Review', 'Exclusive Shelf'];

    it('falls back to ISBN13 when Book Id is blank', async () => {
      const fpath = writeRow(BASE_HEADER, ['', 'Dune', 'Frank Herbert', '', '9780441013593', '', 'read']);
      try {
        const pipeline = await importRows(fpath);
        expect(pipeline.length).toBe(1);
        expect(pipeline[0].item.id).toBe('goodreads:9780441013593');
      } finally {
        await fs.promises.unlink(fpath).catch(() => {});
      }
    });

    it('falls back to ISBN when Book Id and ISBN13 are both blank', async () => {
      const fpath = writeRow(BASE_HEADER, ['', 'Dune', 'Frank Herbert', '0441013597', '', '', 'read']);
      try {
        const pipeline = await importRows(fpath);
        expect(pipeline.length).toBe(1);
        expect(pipeline[0].item.id).toBe('goodreads:0441013597');
      } finally {
        await fs.promises.unlink(fpath).catch(() => {});
      }
    });

    it('falls back to title|author when Book Id, ISBN13, and ISBN are all blank', async () => {
      const fpath = writeRow(BASE_HEADER, ['', 'Dune', 'Frank Herbert', '', '', '', 'read']);
      try {
        const pipeline = await importRows(fpath);
        expect(pipeline.length).toBe(1);
        expect(pipeline[0].item.id).toBe('goodreads:Dune|Frank Herbert');
      } finally {
        await fs.promises.unlink(fpath).catch(() => {});
      }
    });
  });
});

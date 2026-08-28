import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { dittoAvailable, systemExtract, systemUnzipAvailable } from '../systemExtract';

import { buildZip, zipWithoutUtf8Flag } from './zipFixtures';

/**
 * The regression these guard is a real one: a 2.7GB Google Takeout failed at 0%
 * with `system unzip failed (exit 50)` because macOS ships Info-ZIP 6.00 (2009),
 * which cannot write an entry whose name is not ASCII and reports that as
 * "disk full". `ditto` reads the same archive correctly.
 *
 * Both extractors are system binaries, so the meaningful assertions are made
 * against a real zip rather than a mock — but only where the binary exists.
 *
 * The non-ASCII cases below are deliberately NOT skipped per-platform. Every
 * environment gets a correct name out of `systemExtract`, because where the
 * extractor cannot manage it the repair pass does (see `../repairEntryNames`)
 * — including Debian, whose `unzip` has no `-O CHARSET` and silently writes
 * mojibake instead of failing. A skip here would have hidden the appliance's
 * actual behaviour, which is where the export really gets imported.
 */

const describeIfZip = systemUnzipAvailable() || dittoAvailable() ? describe : describe.skip;

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ci-systemextract-'));
}

/**
 * Relative paths of every file under `root`, NFC-normalised and `/`-joined.
 *
 * A mangled name is not valid UTF-8, so it reaches JS with U+FFFD in it and
 * cannot be used to descend back into its own directory. That is recorded as a
 * marker instead of throwing, so a regression shows up as a readable diff
 * rather than an ENOENT from the test helper.
 */
function filesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      found.push(`${prefix}/<unreadable>`);

      return;
    }

    for (const entry of entries) {
      const rel = `${prefix}${prefix ? '/' : ''}${entry.name}`.normalize('NFC');
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else {
        found.push(rel);
      }
    }
  };

  walk(root, '');

  return found.sort();
}

describeIfZip('systemExtract', () => {
  it('extracts an archive whose entry names are plain ASCII', async () => {
    // Built in-process so CI's node:22 image does not need a `zip` binary.
    const work = scratch();
    const dest = path.join(work, 'dest');
    fs.mkdirSync(dest, { recursive: true });

    const archive = path.join(work, 'plain.zip');
    fs.writeFileSync(archive, zipWithoutUtf8Flag('hello.txt', 'hello'));

    const result = await systemExtract(archive, dest);

    expect({ ok: result.ok, detail: result.detail }).toEqual({ ok: true, detail: '' });
    expect(fs.readFileSync(path.join(dest, 'hello.txt'), 'utf8')).toBe('hello');

    fs.rmSync(work, { recursive: true, force: true });
  });

  it('extracts a non-ASCII entry name written without the UTF-8 flag', async () => {
    // The exact shape that killed a 2.7GB Google Takeout at 0%.
    //
    // Note it is NOT enough to zip an accented filename with the `zip` binary:
    // that sets general-purpose bit 11 (the "names are UTF-8" flag) and Info-ZIP
    // then reads it correctly. Google's writer leaves the bit CLEAR. Without a
    // charset flag, Debian unzip translates the name through a compiled-in CP437
    // table (ñ → +¦) and macOS unzip aborts the whole archive with exit 50
    // ("disk full"). The hand-built fixture is the only way to reproduce that
    // shape.
    const work = scratch();
    const dest = path.join(work, 'dest');
    fs.mkdirSync(dest, { recursive: true });

    const name = 'Mariana Acuña - Text - 2025-11-19T18_28_09Z.html';
    const archive = path.join(work, 'no-utf8-flag.zip');
    fs.writeFileSync(archive, zipWithoutUtf8Flag(name, '<html></html>'));

    const result = await systemExtract(archive, dest, { exclusiveDest: true });

    expect(result.ok).toBe(true);
    // Compare on the decoded set rather than the literal name: the extractors
    // differ in the Unicode normalisation they write, and the point of the test
    // is that the entry survived at all.
    const written = fs.readdirSync(dest).map((entry) => entry.normalize('NFC'));
    expect(written).toContain(name.normalize('NFC'));
    // …and that it survived ONCE. A mangled twin left beside it imports as a
    // second, garbled copy of the same conversation.
    expect(written).toHaveLength(1);
    expect(fs.readFileSync(path.join(dest, name), 'utf8')).toBe('<html></html>');

    fs.rmSync(work, { recursive: true, force: true });
  });

  it('extracts non-ASCII names nested under a non-ASCII directory', async () => {
    // A mangled DIRECTORY component misplaces every file beneath it, so the
    // repair has to fix whole paths rather than basenames — and then clear the
    // mangled directory too, not just its contents.
    const work = scratch();
    const dest = path.join(work, 'dest');
    fs.mkdirSync(dest, { recursive: true });

    const archive = path.join(work, 'nested.zip');
    fs.writeFileSync(
      archive,
      buildZip([
        { name: 'Takeout/Fotos de Mariña/', contents: '' },
        // Deflated, to cover the compressed path as well as the stored one.
        { name: 'Takeout/Fotos de Mariña/día 1.json', contents: '{"a":1}', deflate: true },
        { name: 'Takeout/Fotos de Mariña/día 2.json', contents: '{"a":2}' },
        { name: 'Takeout/plain.txt', contents: 'ascii' },
      ]),
    );

    const result = await systemExtract(archive, dest, { exclusiveDest: true });

    expect(result.ok).toBe(true);
    expect(filesUnder(dest)).toEqual(
      ['Takeout/Fotos de Mariña/día 1.json', 'Takeout/Fotos de Mariña/día 2.json', 'Takeout/plain.txt'].map(
        (p) => p.normalize('NFC'),
      ),
    );
    expect(fs.readFileSync(path.join(dest, 'Takeout/Fotos de Mariña/día 1.json'), 'utf8')).toBe('{"a":1}');

    fs.rmSync(work, { recursive: true, force: true });
  });

  it('reports no name repair for an all-ASCII archive', async () => {
    // The overwhelmingly common archive. Nothing is at risk, so the pass must
    // cost one central-directory read and report nothing.
    const work = scratch();
    const dest = path.join(work, 'dest');
    fs.mkdirSync(dest, { recursive: true });

    const archive = path.join(work, 'ascii.zip');
    fs.writeFileSync(archive, buildZip([{ name: 'Takeout/plain.txt', contents: 'ascii' }]));

    const result = await systemExtract(archive, dest);

    expect(result.ok).toBe(true);
    expect(result.nameRepair).toBeUndefined();
    expect(filesUnder(dest)).toEqual(['Takeout/plain.txt']);

    fs.rmSync(work, { recursive: true, force: true });
  });

  it('extracts a non-ASCII name even when the UTF-8 flag IS set', async () => {
    // Setting general-purpose bit 11 is the well-formed thing to do, and it
    // does not save you: Debian's unzip picks its charset from the "version
    // made by" host byte and ignores bit 11 entirely, so a correctly-flagged
    // archive is mangled just the same. Verified against `node:22`.
    const work = scratch();
    const dest = path.join(work, 'dest');
    fs.mkdirSync(dest, { recursive: true });

    const archive = path.join(work, 'flagged.zip');
    fs.writeFileSync(archive, buildZip([{ name: 'Mariña.txt', contents: 'ok', utf8Flag: true }]));

    const result = await systemExtract(archive, dest, { exclusiveDest: true });

    expect(result.ok).toBe(true);
    expect(filesUnder(dest)).toEqual(['Mariña.txt'.normalize('NFC')]);

    fs.rmSync(work, { recursive: true, force: true });
  });

  it('keeps a partly-extracted tree rather than discarding the whole archive', async () => {
    // Measured on a real 3.3GB Google Takeout: `unzip` exited 50 and `ditto`
    // exited 1 on two entries no extractor will take — a name used as both a
    // file and a directory (`Takeout/Drive/Unorganized/config: Not a
    // directory`) and an `Unknown compression type` — having already written
    // 2.8GB across 1,087 files. Failing the archive threw all of that away.
    const work = scratch();
    const dest = path.join(work, 'dest');
    fs.mkdirSync(dest, { recursive: true });

    // Stand in for the half-written tree an aborted extractor leaves behind.
    fs.mkdirSync(path.join(dest, 'Takeout', 'Drive'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'Takeout', 'Drive', 'survived.txt'), 'real content');

    const notAZip = path.join(work, 'broken.zip');
    fs.writeFileSync(notAZip, 'neither extractor can read this');

    const result = await systemExtract(notAZip, dest);

    expect(result.ok).toBe(true);
    expect(result.partial).toBe(true);
    // The reason survives so the run can say what was lost instead of
    // reporting a clean success.
    expect(result.detail).not.toHaveLength(0);

    fs.rmSync(work, { recursive: true, force: true });
  });

  it('reports a cause rather than succeeding on a file that is not an archive', async () => {
    const work = scratch();
    const dest = path.join(work, 'dest');
    fs.mkdirSync(dest, { recursive: true });

    const notAZip = path.join(work, 'notazip.zip');
    fs.writeFileSync(notAZip, 'this is not a zip file');

    const result = await systemExtract(notAZip, dest);

    expect(result.ok).toBe(false);
    expect(result.detail).not.toHaveLength(0);

    fs.rmSync(work, { recursive: true, force: true });
  });
});

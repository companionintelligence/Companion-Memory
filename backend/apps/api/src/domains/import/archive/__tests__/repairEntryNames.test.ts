import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { repairEntryNames } from '../repairEntryNames';

import { buildZip } from './zipFixtures';

/**
 * These drive the repair directly against a destination staged to look like
 * what a charset-blind extractor leaves behind, so they need no `unzip`, no
 * `ditto`, and no particular platform — unlike `./systemExtract.test.ts`,
 * which exercises the same code through the real binaries.
 *
 * That matters because the bug being fixed is Linux-only in its symptom: a
 * suite that could only assert it where the local extractor happens to be
 * capable is exactly how it stayed invisible.
 */

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ci-namerepair-'));
}

function filesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
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

/** Stage `dest` as Debian `unzip` would leave it: real bytes, mangled name. */
function writeMangled(dest: string, relativePath: string, contents: string): void {
  const full = path.join(dest, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
}

describe('repairEntryNames', () => {
  let work: string;
  let dest: string;

  beforeEach(() => {
    work = scratch();
    dest = path.join(work, 'dest');
    fs.mkdirSync(dest, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  function archiveOf(entries: Parameters<typeof buildZip>[0], name = 'a.zip'): string {
    const archive = path.join(work, name);
    fs.writeFileSync(archive, buildZip(entries));

    return archive;
  }

  it('rewrites a mangled name and removes the mangled copy', () => {
    // `Acuña` stored as UTF-8 (C3 B1) arrives as `Acu+¦a` (2B A6) once Debian
    // unzip has put it through its compiled-in CP437 table.
    const archive = archiveOf([{ name: 'Mariana Acuña - Text.html', contents: '<html></html>' }]);
    writeMangled(dest, 'Mariana Acu+¦a - Text.html', '<html></html>');

    const result = repairEntryNames(archive, dest, { sweep: true });

    expect(result).toEqual({ repaired: 1, unrepaired: 0, removed: 1 });
    expect(filesUnder(dest)).toEqual(['Mariana Acuña - Text.html'.normalize('NFC')]);
    expect(fs.readFileSync(path.join(dest, 'Mariana Acuña - Text.html'), 'utf8')).toBe('<html></html>');
  });

  it('rebuilds a whole path when the directory component was mangled too', () => {
    const archive = archiveOf([
      { name: 'Fotos de Mariña/día 1.json', contents: '{"a":1}', deflate: true },
      { name: 'Fotos de Mariña/día 2.json', contents: '{"a":2}' },
    ]);
    writeMangled(dest, 'Fotos de Mari+¦a/d+¡a 1.json', '{"a":1}');
    writeMangled(dest, 'Fotos de Mari+¦a/d+¡a 2.json', '{"a":2}');

    const result = repairEntryNames(archive, dest, { sweep: true });

    expect(result).toEqual({ repaired: 2, unrepaired: 0, removed: 2 });
    expect(filesUnder(dest)).toEqual(
      ['Fotos de Mariña/día 1.json', 'Fotos de Mariña/día 2.json'].map((p) => p.normalize('NFC')),
    );
    // The emptied mangled directory goes too, or recognition sees a phantom album.
    expect(fs.readdirSync(dest).map((d) => d.normalize('NFC'))).toEqual(['Fotos de Mariña'.normalize('NFC')]);
  });

  it('does nothing when the extractor already wrote the real names', () => {
    // macOS `ditto` and Fedora `unzip -O UTF-8` land here: the pass must be a
    // no-op rather than re-extracting or sweeping anything.
    const archive = archiveOf([{ name: 'Mariña.txt', contents: 'ok' }]);
    writeMangled(dest, 'Mariña.txt', 'ok');

    expect(repairEntryNames(archive, dest)).toEqual({ repaired: 0, unrepaired: 0, removed: 0 });
    expect(filesUnder(dest)).toEqual(['Mariña.txt'.normalize('NFC')]);
  });

  it('leaves a genuinely CP437 name to the extractor', () => {
    // Bytes that are NOT valid UTF-8 really are CP437, and unzip's translation
    // of them is the correct reading — this pass must not "fix" it.
    const archive = archiveOf([{ name: Buffer.from([0x41, 0xe1, 0x2e, 0x74, 0x78, 0x74]), contents: 'dos' }]);
    writeMangled(dest, 'Aß.txt', 'dos');

    expect(repairEntryNames(archive, dest)).toEqual({ repaired: 0, unrepaired: 0, removed: 0 });
    expect(filesUnder(dest)).toEqual(['Aß.txt'.normalize('NFC')]);
  });

  it('refuses to write an entry whose true name escapes the destination', () => {
    // The caller asserted containment over the names the SYSTEM extractor saw.
    // The true UTF-8 name is a different string, so it gets its own check —
    // otherwise a mangled name passes the caller and a `../` name lands here.
    const archive = archiveOf([{ name: '../escapé.txt', contents: 'owned' }]);

    expect(repairEntryNames(archive, dest)).toEqual({ repaired: 0, unrepaired: 0, removed: 0 });
    expect(fs.existsSync(path.join(work, 'escapé.txt'))).toBe(false);
    expect(filesUnder(dest)).toEqual([]);
  });

  it("removes the archive's own links before it writes", () => {
    // Staged as Debian `unzip` leaves an archive that pairs a UNIX symlink
    // entry (name passed through, link restored) with an MS-DOS entry under
    // the same accented directory (name garbled). Writing `dé/main.js` at its
    // true name would go through the link.
    const outside = path.join(work, 'outside');
    fs.mkdirSync(outside);
    const archive = archiveOf([
      { name: 'dé', symlinkTo: outside },
      { name: 'dé/main.js', contents: 'from the archive' },
    ]);
    fs.symlinkSync(outside, path.join(dest, 'dé'));
    writeMangled(dest, 'd+¬/main.js', 'from the archive');

    const result = repairEntryNames(archive, dest);

    expect(result).toEqual({ repaired: 1, unrepaired: 0, removed: 0 });
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.lstatSync(path.join(dest, 'dé')).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(dest, 'dé', 'main.js'), 'utf8')).toBe('from the archive');
  });

  it('refuses to write through a link the archive does not list', () => {
    // A link this archive did not carry (an earlier archive's, in the shared
    // tree `./unpack` expands into) is not this pass's to remove, and it must
    // not be written through either.
    const outside = path.join(work, 'outside');
    fs.mkdirSync(outside);
    const archive = archiveOf([{ name: 'dé/main.js', contents: 'from the archive' }]);
    fs.symlinkSync(outside, path.join(dest, 'dé'));
    writeMangled(dest, 'd+¬/main.js', 'from the archive');

    const result = repairEntryNames(archive, dest);

    expect(result).toEqual({ repaired: 0, unrepaired: 1, removed: 0 });
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.lstatSync(path.join(dest, 'dé')).isSymbolicLink()).toBe(true);
  });

  it('never writes through a link sitting at the temp path', () => {
    // The temp file is where the payload is written before the rename. A link
    // there (left by an interrupted run, or planted) would carry that write to
    // wherever it points, so the entry is refused and the link's target is
    // untouched. The name is NOT one the archive lists, so the link strip does
    // not clear it first.
    const victim = path.join(work, 'victim.txt');
    fs.writeFileSync(victim, 'original');
    const archive = archiveOf([{ name: 'café.txt', contents: 'from the archive' }]);
    fs.symlinkSync(victim, path.join(dest, 'café.txt.ci-name-repair'));
    writeMangled(dest, 'caf+¬.txt', 'from the archive');

    const result = repairEntryNames(archive, dest);

    expect(result).toEqual({ repaired: 0, unrepaired: 1, removed: 0 });
    expect(fs.readFileSync(victim, 'utf8')).toBe('original');
    expect(fs.existsSync(path.join(dest, 'café.txt'))).toBe(false);
  });

  it('counts an entry whose directory cannot be created and still repairs the next one', () => {
    // `unzip` restores a UNIX directory's mode, so an archive can leave a
    // read-only folder in the tree. Creating a subfolder under it fails; that
    // costs the one entry, not every entry after it. Root ignores the mode,
    // so there is nothing to observe there.
    if (process.getuid?.() === 0) {
      return;
    }

    const locked = path.join(dest, 'locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o555);
    const archive = archiveOf([
      { name: 'locked/sub/dé.json', contents: '{}' },
      { name: 'café.txt', contents: 'ok' },
    ]);
    writeMangled(dest, 'caf+¬.txt', 'ok');

    try {
      expect(repairEntryNames(archive, dest)).toEqual({ repaired: 1, unrepaired: 1, removed: 0 });
      expect(fs.readFileSync(path.join(dest, 'café.txt'), 'utf8')).toBe('ok');
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });

  it('keeps the mangled copy when the entry cannot be re-extracted', () => {
    // A corrupt payload must not cost the file: repair fails, and the sweep is
    // abandoned so the badly-named copy stays as the only version there is.
    const archive = archiveOf([{ name: 'Mariña.txt', contents: 'hello there' }]);
    const bytes = fs.readFileSync(archive);
    bytes[bytes.indexOf(Buffer.from('hello there'))] = 0x58; // break the CRC
    fs.writeFileSync(archive, bytes);
    writeMangled(dest, 'Mari+¦a.txt', 'hello there');

    const result = repairEntryNames(archive, dest, { sweep: true });

    expect(result).toEqual({ repaired: 0, unrepaired: 1, removed: 0 });
    expect(filesUnder(dest)).toEqual(['Mari+¦a.txt']);
  });

  it('abandons the sweep when the tree holds more than the repair explains', () => {
    // A destination carrying files the archive does not list is not a tree
    // this pass understands, so it repairs and stops rather than deleting.
    const archive = archiveOf([{ name: 'Mariña.txt', contents: 'ok' }]);
    writeMangled(dest, 'Mari+¦a.txt', 'ok');
    writeMangled(dest, 'unrelated-1.txt', 'keep me');
    writeMangled(dest, 'unrelated-2.txt', 'keep me too');

    const result = repairEntryNames(archive, dest, { sweep: true });

    expect(result).toEqual({ repaired: 1, unrepaired: 0, removed: 0 });
    expect(filesUnder(dest)).toEqual(
      ['Mari+¦a.txt', 'Mariña.txt'.normalize('NFC'), 'unrelated-1.txt', 'unrelated-2.txt'].sort(),
    );
  });

  it('repairs but does not sweep a destination it was not told it owns', () => {
    // The `./unpack` path: archives expand into the folder that CONTAINS them,
    // alongside sibling exports and their still-unextracted zips. Getting the
    // real name is worth having there; deleting by set difference is not.
    const archive = archiveOf([{ name: 'Mariña.txt', contents: 'ok' }]);
    writeMangled(dest, 'Mari+¦a.txt', 'ok');

    const result = repairEntryNames(archive, dest);

    expect(result).toEqual({ repaired: 1, unrepaired: 0, removed: 0 });
    expect(filesUnder(dest)).toEqual(['Mari+¦a.txt', 'Mariña.txt'.normalize('NFC')].sort());
  });

  it('ignores a file that is not a readable archive', () => {
    const notAZip = path.join(work, 'notazip.zip');
    fs.writeFileSync(notAZip, 'this is not a zip file');

    expect(repairEntryNames(notAZip, dest)).toEqual({ repaired: 0, unrepaired: 0, removed: 0 });
  });
});

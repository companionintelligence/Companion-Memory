/*
 * .tar.gz / .tgz uploads (Mastodon's archive, GitHub's account export) through
 * archive/extract.ts. Tarballs are built byte by byte here, so a test can
 * write the headers a hostile archive would carry: `../` and absolute names,
 * links, devices, a setuid mode. Nothing is checked in; everything lives in a
 * temp dir.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { ArchiveEscapeError } from '../containment';
import { extractUploadedArchive, isExtractableArchive } from '../extract';
import { CorruptArchiveError } from '../unpack';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-extract-tar-'));

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

interface TarEntry {
  name: string;
  /** ustar type flag: '0' file, '1' hard link, '2' symlink, '3'/'4' devices, '5' dir, '6' FIFO. */
  type?: string;
  body?: string;
  linkname?: string;
  mode?: number;
}

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

function header(e: TarEntry, size: number): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(e.name, 0, 100, 'utf8');
  h.write(octal(e.mode ?? (e.type === '5' ? 0o755 : 0o644), 8), 100);
  h.write(octal(0, 8), 108);
  h.write(octal(0, 8), 116);
  h.write(octal(size, 12), 124);
  h.write(octal(1_790_000_000, 12), 136);
  h.write('        ', 148);
  h.write(e.type ?? '0', 156);
  h.write(e.linkname ?? '', 157, 100, 'utf8');
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) {
    sum += b;
  }

  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);

  return h;
}

function tarGz(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.body ?? '', 'utf8');
    parts.push(header(e, body.length));
    if (body.length > 0) {
      parts.push(body, Buffer.alloc((512 - (body.length % 512)) % 512));
    }
  }

  parts.push(Buffer.alloc(1024));

  return zlib.gzipSync(Buffer.concat(parts));
}

const OUTBOX = JSON.stringify({ type: 'OrderedCollection', orderedItems: [] });

function write(name: string, entries: TarEntry[]): { dir: string; archive: string } {
  const dir = fs.mkdtempSync(path.join(TMP, 'unit-'));
  const archive = path.join(dir, name);
  fs.writeFileSync(archive, tarGz(entries));

  return { dir, archive };
}

describe('extractUploadedArchive on a tarball', () => {
  it('treats .tar.gz and .tgz as archives, and nothing else new', () => {
    expect(isExtractableArchive('archive-20261118081500-3f9a1c0b.tar.gz')).toBe(true);
    expect(isExtractableArchive('export.TGZ')).toBe(true);
    expect(isExtractableArchive('export.zip')).toBe(true);
    expect(isExtractableArchive('notes.gz')).toBe(false);
    expect(isExtractableArchive('backup.tar')).toBe(false);
  });

  it('extracts a Mastodon-style archive into a sibling folder and deletes the upload when asked', async () => {
    const { dir, archive } = write('archive-20261118081500-3f9a1c0b.tar.gz', [
      { name: 'outbox.json', body: OUTBOX },
      { name: 'actor.json', body: '{}' },
      { name: 'media_attachments/', type: '5' },
      { name: 'media_attachments/files/113/original/9c1d.jpg', body: 'jpeg bytes' },
    ]);

    const res = await extractUploadedArchive(archive, { deleteArchiveAfterExtract: true });

    expect(res.method).toBe('tar');
    expect(res.files).toBe(3);
    expect(res.destDir).toBe(path.join(dir, 'archive-20261118081500-3f9a1c0b'));
    expect(fs.readFileSync(path.join(res.destDir, 'outbox.json'), 'utf8')).toBe(OUTBOX);
    expect(
      fs.readFileSync(path.join(res.destDir, 'media_attachments/files/113/original/9c1d.jpg'), 'utf8'),
    ).toBe('jpeg bytes');
    expect(res.archiveDeleted).toBe(true);
    expect(fs.existsSync(archive)).toBe(false);
  });

  it('accepts the "./" prefix GNU tar writes', async () => {
    const { archive } = write('export.tgz', [
      { name: './', type: '5' },
      { name: './outbox.json', body: OUTBOX },
      { name: './media/', type: '5' },
      { name: './media/a.jpg', body: 'jpeg' },
    ]);

    const res = await extractUploadedArchive(archive);

    expect(res.destDir).toBe(path.join(path.dirname(archive), 'export'));
    expect(fs.readdirSync(res.destDir).sort()).toEqual(['media', 'outbox.json']);
    expect(res.files).toBe(2);
  });

  it.each([
    ['a parent-directory entry', '../escape.txt'],
    ['a parent-directory step in the middle', 'media/../../escape.txt'],
    ['a harmless-looking ".." step', 'media/../outbox.json'],
    ['an absolute path', '/tmp/escape.txt'],
    ['a Windows drive path', 'C:/escape.txt'],
    ['a backslash traversal', '..\\escape.txt'],
  ])('rejects %s before writing anything', async (_label, name) => {
    const { dir, archive } = write('evil.tar.gz', [
      { name: 'outbox.json', body: OUTBOX },
      { name, body: 'pwned' },
    ]);

    await expect(extractUploadedArchive(archive, { deleteArchiveAfterExtract: true })).rejects.toThrow(
      ArchiveEscapeError,
    );
    expect(fs.existsSync(path.join(dir, 'evil'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'escape.txt'))).toBe(false);
    expect(fs.existsSync(archive)).toBe(true);
  });

  it('skips links, devices and FIFOs and writes the files around them', async () => {
    const outside = fs.mkdtempSync(path.join(TMP, 'outside-'));
    const { archive } = write('links.tar.gz', [
      { name: 'outbox.json', body: OUTBOX },
      { name: 'passwd', type: '2', linkname: '/etc/passwd' },
      { name: 'out', type: '2', linkname: outside },
      { name: 'out/pwned.txt', body: 'through the link' },
      { name: 'hard', type: '1', linkname: '/etc/passwd' },
      { name: 'tty', type: '3' },
      { name: 'disk', type: '4' },
      { name: 'pipe', type: '6' },
    ]);

    const res = await extractUploadedArchive(archive);

    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.readFileSync(path.join(res.destDir, 'outbox.json'), 'utf8')).toBe(OUTBOX);
    // The file named under the skipped link lands as a real folder inside.
    expect(fs.lstatSync(path.join(res.destDir, 'out')).isDirectory()).toBe(true);
    for (const skipped of ['passwd', 'hard', 'tty', 'disk', 'pipe']) {
      expect(fs.existsSync(path.join(res.destDir, skipped))).toBe(false);
    }
  });

  it('writes plain permissions whatever modes the archive carries', async () => {
    const { archive } = write('modes.tar.gz', [
      { name: 'bin/', type: '5', mode: 0o7777 },
      { name: 'bin/setuid', body: 'x', mode: 0o4755 },
      { name: 'locked.json', body: '{}', mode: 0o000 },
    ]);

    const res = await extractUploadedArchive(archive);

    expect(fs.statSync(path.join(res.destDir, 'bin', 'setuid')).mode & 0o7000).toBe(0);
    expect(fs.statSync(path.join(res.destDir, 'bin')).mode & 0o7000).toBe(0);
    expect(fs.readFileSync(path.join(res.destDir, 'locked.json'), 'utf8')).toBe('{}');
  });

  it('enforces the entry-count cap before writing anything', async () => {
    const { dir, archive } = write('many.tar.gz', [
      { name: 'a.json', body: '{}' },
      { name: 'b.json', body: '{}' },
      { name: 'c/', type: '5' },
      { name: 'c/d.json', body: '{}' },
    ]);

    await expect(extractUploadedArchive(archive, { maxEntries: 3 })).rejects.toThrow(/more than 3 entries/);
    expect(fs.existsSync(path.join(dir, 'many'))).toBe(false);
  });

  it('enforces the total-size cap on declared sizes before writing anything', async () => {
    const { dir, archive } = write('big.tar.gz', [
      { name: 'a.json', body: 'x'.repeat(600) },
      { name: 'b.json', body: 'y'.repeat(600) },
    ]);

    await expect(extractUploadedArchive(archive, { maxTotalBytes: 1000 })).rejects.toThrow(/cap/);
    expect(fs.existsSync(path.join(dir, 'big'))).toBe(false);
  });

  it('refuses a header that declares a huge entry without reading its body', async () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'unit-'));
    const archive = path.join(dir, 'liar.tar.gz');
    // 7 GB declared, a few bytes present: the cap is hit on the header alone.
    fs.writeFileSync(
      archive,
      zlib.gzipSync(Buffer.concat([header({ name: 'huge.bin' }, 7 * 1024 ** 3), Buffer.alloc(512)])),
    );

    await expect(extractUploadedArchive(archive, { maxTotalBytes: 1e9 })).rejects.toThrow(/cap 1\.0GB/);
    expect(fs.existsSync(path.join(dir, 'liar'))).toBe(false);
  });

  it('stops reading at the entry cap on an archive with thousands of entries', async () => {
    const entries: TarEntry[] = Array.from({ length: 5000 }, (_, i) => ({ name: `f${i}.txt` }));
    const { dir, archive } = write('crowd.tar.gz', entries);

    await expect(extractUploadedArchive(archive, { maxEntries: 100 })).rejects.toThrow(
      /more than 100 entries/,
    );
    expect(fs.existsSync(path.join(dir, 'crowd'))).toBe(false);
  });

  it('fails up front when the disk cannot fit what the headers declare', async () => {
    const { dir, archive } = write('export.tar.gz', [{ name: 'outbox.json', body: OUTBOX }]);
    const statfs = jest
      .spyOn(fs, 'statfsSync')
      .mockReturnValue({ bavail: 1, bsize: 1 } as unknown as fs.StatsFsBase<number>);
    try {
      await expect(extractUploadedArchive(archive)).rejects.toThrow(/not enough disk space/);
      expect(fs.existsSync(path.join(dir, 'export'))).toBe(false);
    } finally {
      statfs.mockRestore();
    }
  });

  it('refuses to write through a link a previous attempt left in the destination', async () => {
    const outside = fs.mkdtempSync(path.join(TMP, 'outside-'));
    const { dir, archive } = write('export.tar.gz', [{ name: 'link/pwned.txt', body: 'x' }]);
    fs.mkdirSync(path.join(dir, 'export'));
    fs.symlinkSync(outside, path.join(dir, 'export', 'link'));

    await expect(extractUploadedArchive(archive)).rejects.toThrow(/through a link/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('reports a truncated download as a corrupt archive and keeps it', async () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'unit-'));
    const archive = path.join(dir, 'archive-cut.tar.gz');
    const full = tarGz([{ name: 'outbox.json', body: 'z'.repeat(4000) }]);
    fs.writeFileSync(archive, full.subarray(0, Math.floor(full.length / 2)));

    await expect(extractUploadedArchive(archive, { deleteArchiveAfterExtract: true })).rejects.toThrow(
      CorruptArchiveError,
    );
    await expect(extractUploadedArchive(archive)).rejects.toThrow(/re-download the export/);
    expect(fs.existsSync(archive)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'archive-cut'))).toBe(false);
  });

  it('reports a file that is not a tarball at all as a corrupt archive', async () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'unit-'));
    const archive = path.join(dir, 'export.tar.gz');
    fs.writeFileSync(archive, 'this is not a tarball, just text that happens to have the name');

    await expect(extractUploadedArchive(archive)).rejects.toThrow(CorruptArchiveError);
  });

  it('rejects a gzip bomb by its decompression ratio', async () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'unit-'));
    const archive = path.join(dir, 'bomb.tar.gz');
    // 8 MB of zeros compresses to a few KB: far past the 1000:1 ratio node-tar allows.
    const tar = Buffer.concat([
      header({ name: 'zeros.bin' }, 8 * 1024 * 1024),
      Buffer.alloc(8 * 1024 * 1024 + 1024),
    ]);
    fs.writeFileSync(archive, zlib.gzipSync(tar, { level: 9 }));

    await expect(extractUploadedArchive(archive)).rejects.toThrow(/decompression ratio/);
    expect(fs.existsSync(path.join(dir, 'bomb'))).toBe(false);
  });
});

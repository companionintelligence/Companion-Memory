/*
 * Guarded single-archive extraction (archive/extract.ts). Fixtures are built
 * in-memory with adm-zip — no binary files checked in.
 *
 * Upstream this file also drove the whole POST /api/uploads → recognize flow
 * against a Koa server. That block is deliberately not ported: recognition
 * arrives in the import API PR, and intake here does not extract at upload time
 * (a 40GB Takeout cannot be expanded inside a request — the `unpack` stage does
 * it). The end-to-end coverage returns with the run/stage spine.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import AdmZip from 'adm-zip';

import { extractUploadedArchive } from '../extract';
import { CorruptArchiveError } from '../unpack';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-extract-'));

const GPX =
  '<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>' +
  '<trkpt lat="1" lon="2"><time>2024-01-01T00:00:00Z</time></trkpt>' +
  '</trkseg></trk></gpx>';

function zipWith(entries: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.addFile(name, Buffer.from(content, 'utf8'));
  }

  return zip.toBuffer();
}

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('extractUploadedArchive', () => {
  const dir = () => fs.mkdtempSync(path.join(TMP, 'unit-'));

  it('extracts into a sibling directory and keeps the archive', async () => {
    const d = dir();
    const archive = path.join(d, 'export.zip');
    fs.writeFileSync(archive, zipWith({ 'walk.gpx': GPX, 'nested/readme.txt': 'hi' }));

    const res = await extractUploadedArchive(archive);
    expect(res.destDir).toBe(path.join(d, 'export'));
    expect(res.files).toBe(2);
    expect(res.method).toBe('adm-zip'); // small archive stays in-memory
    expect(fs.readFileSync(path.join(d, 'export', 'walk.gpx'), 'utf8')).toBe(GPX);
    expect(fs.readFileSync(path.join(d, 'export', 'nested', 'readme.txt'), 'utf8')).toBe('hi');
    expect(fs.existsSync(archive)).toBe(true); // original kept
  });

  it('deletes the archive after a successful extraction when asked to', async () => {
    const d = dir();
    const archive = path.join(d, 'export.zip');
    fs.writeFileSync(archive, zipWith({ 'walk.gpx': GPX }));

    const res = await extractUploadedArchive(archive, { deleteArchiveAfterExtract: true });
    expect(res.archiveDeleted).toBe(true);
    expect(fs.existsSync(archive)).toBe(false);
    expect(fs.readFileSync(path.join(d, 'export', 'walk.gpx'), 'utf8')).toBe(GPX);
  });

  it('keeps the archive when extraction fails, even with deleteArchiveAfterExtract', async () => {
    const d = dir();
    const archive = path.join(d, 'corrupt.zip');
    fs.writeFileSync(archive, 'this is not a zip');
    await expect(extractUploadedArchive(archive, { deleteArchiveAfterExtract: true })).rejects.toThrow();
    expect(fs.existsSync(archive)).toBe(true);
  });

  // The reason travels to the UI, so it has to say what is actually wrong.
  // adm-zip's "Invalid or unsupported zip format" (and the streaming path's
  // "unzip exit 9") sent a truncated OneDrive export down a days-long debug of
  // the push transport instead of the download.
  it('names the real defect for a truncated archive (download did not finish)', async () => {
    const d = dir();
    const archive = path.join(d, 'OneDrive_2.zip');
    const full = zipWith({ 'walk.gpx': GPX });
    // Complete entries, no end-of-central-directory record.
    fs.writeFileSync(archive, full.subarray(0, full.length - 40));

    await expect(extractUploadedArchive(archive)).rejects.toThrow(CorruptArchiveError);
    await expect(extractUploadedArchive(archive)).rejects.toThrow(
      /truncated .* end-of-central-directory record is missing/,
    );
    await expect(extractUploadedArchive(archive)).rejects.toThrow(/re-download the export/i);
    expect(fs.existsSync(path.join(d, 'OneDrive_2'))).toBe(false);
  });

  it('fails the extraction up front when the disk cannot fit the declared bytes', async () => {
    const d = dir();
    const archive = path.join(d, 'export.zip');
    fs.writeFileSync(archive, zipWith({ 'walk.gpx': GPX }));

    // Report ~0 free bytes: the declared size + margin can never fit.
    const statfs = jest
      .spyOn(fs, 'statfsSync')
      .mockReturnValue({ bavail: 1, bsize: 1 } as unknown as fs.StatsFsBase<number>);
    try {
      await expect(extractUploadedArchive(archive)).rejects.toThrow(/not enough disk space/);
      // Nothing extracted, archive untouched — the user frees space and retries.
      expect(fs.existsSync(path.join(d, 'export'))).toBe(false);
      expect(fs.existsSync(archive)).toBe(true);
    } finally {
      statfs.mockRestore();
    }
  });

  it('rejects zip-slip entries before writing anything', async () => {
    const d = dir();
    const archive = path.join(d, 'evil.zip');
    // adm-zip sanitizes traversal names in addFile, so build the malicious
    // archive the way an attacker would: store a benign same-length name, then
    // byte-patch it to `../` in both the local header and the central directory.
    const raw = zipWith({ 'ok.txt': 'fine', 'xx/escape.txt': 'nope' });
    const patched = Buffer.from(
      raw.toString('latin1').split('xx/escape.txt').join('../escape.txt'),
      'latin1',
    );
    fs.writeFileSync(archive, patched);

    await expect(extractUploadedArchive(archive)).rejects.toThrow(/escapes extraction dir/);
    // Validate-then-write: nothing landed, not even the benign entry.
    expect(fs.existsSync(path.join(d, 'evil', 'ok.txt'))).toBe(false);
    expect(fs.existsSync(path.join(d, 'escape.txt'))).toBe(false);
    expect(fs.existsSync(path.join(TMP, 'escape.txt'))).toBe(false);
  });

  it('enforces the entry-count cap', async () => {
    const d = dir();
    const archive = path.join(d, 'many.zip');
    fs.writeFileSync(archive, zipWith({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' }));
    await expect(extractUploadedArchive(archive, { maxEntries: 2 })).rejects.toThrow(/entries/);
    expect(fs.existsSync(path.join(d, 'many'))).toBe(false);
  });

  it('enforces the total-size cap', async () => {
    const d = dir();
    const archive = path.join(d, 'big.zip');
    fs.writeFileSync(archive, zipWith({ 'big.txt': 'x'.repeat(4096) }));
    await expect(extractUploadedArchive(archive, { maxTotalBytes: 1024 })).rejects.toThrow(/GB|cap/);
    expect(fs.existsSync(path.join(d, 'big'))).toBe(false);
  });

  it('yields to the event loop between entries on the in-memory path', async () => {
    // The import worker is one process running every stage of every run, and
    // this extraction used to be a single synchronous call — a sub-1GB archive
    // froze every neighbouring run for its whole extraction. The per-entry
    // yield is what this pins: a macrotask queued before the extraction MUST
    // get a turn before it finishes. Without the yield the async function body
    // runs to completion first and `ticked` is deterministically false.
    const d = dir();
    const archive = path.join(d, 'export.zip');
    fs.writeFileSync(archive, zipWith({ 'a.txt': 'a', 'b.txt': 'b' }));

    let ticked = false;
    setImmediate(() => {
      ticked = true;
    });

    const res = await extractUploadedArchive(archive);
    expect(res.method).toBe('adm-zip');
    expect(ticked).toBe(true);
  });
});

// Real multi-GB drops must NOT go through adm-zip (which reads the whole
// archive into memory and decompresses each entry synchronously, blocking the
// event loop and spiking RSS). Above a size threshold they stream through the
// system `unzip` instead — the same fallback unpack.ts uses for 40-50GB Google
// Takeout / Apple Photos exports. We can't check a multi-GB file in, so these
// tests force the streaming branch with a tiny `largeArchiveThreshold` stub and
// assert the branch that ran via `res.method`, while proving the untrusted-input
// guards (zip-slip, declared-size cap) still hold on that path.
describe('extractUploadedArchive streaming (large-archive) path', () => {
  const dir = () => fs.mkdtempSync(path.join(TMP, 'stream-'));

  it('routes an archive at/above the threshold through the system unzip', async () => {
    const d = dir();
    const archive = path.join(d, 'export.zip');
    fs.writeFileSync(archive, zipWith({ 'walk.gpx': GPX, 'nested/readme.txt': 'hi' }));

    // threshold: 1 → any real archive (>1 byte) is treated as "large".
    const res = await extractUploadedArchive(archive, { largeArchiveThreshold: 1 });
    expect(res.method).toBe('system-unzip'); // proves the streaming branch ran
    expect(res.destDir).toBe(path.join(d, 'export'));
    expect(res.files).toBe(2);
    // Same sibling-directory contract as the adm-zip path.
    expect(fs.readFileSync(path.join(d, 'export', 'walk.gpx'), 'utf8')).toBe(GPX);
    expect(fs.readFileSync(path.join(d, 'export', 'nested', 'readme.txt'), 'utf8')).toBe('hi');
    expect(fs.existsSync(archive)).toBe(true); // original kept
  });

  it('keeps small archives on adm-zip below the threshold', async () => {
    const d = dir();
    const archive = path.join(d, 'small.zip');
    const payload = zipWith({ 'walk.gpx': GPX });
    fs.writeFileSync(archive, payload);

    // threshold well above the fixture size → stays in-memory.
    const res = await extractUploadedArchive(archive, { largeArchiveThreshold: payload.length + 1 });
    expect(res.method).toBe('adm-zip');
    expect(res.files).toBe(1);
    expect(fs.readFileSync(path.join(d, 'small', 'walk.gpx'), 'utf8')).toBe(GPX);
  });

  it('the threshold boundary is inclusive (size == threshold streams)', async () => {
    const d = dir();
    const archive = path.join(d, 'boundary.zip');
    const payload = zipWith({ 'walk.gpx': GPX });
    fs.writeFileSync(archive, payload);

    // threshold exactly the on-disk size → `size >= threshold` picks streaming.
    const res = await extractUploadedArchive(archive, { largeArchiveThreshold: payload.length });
    expect(res.method).toBe('system-unzip');
    expect(res.files).toBe(1);
  });

  it('still rejects zip-slip on the streaming path before writing anything', async () => {
    const d = dir();
    const archive = path.join(d, 'evil.zip');
    // Same construction as the adm-zip zip-slip test: a benign same-length name
    // byte-patched to `../` in both the local header and the central directory,
    // which is what `unzip -Z1` reads back.
    const raw = zipWith({ 'ok.txt': 'fine', 'xx/escape.txt': 'nope' });
    const patched = Buffer.from(
      raw.toString('latin1').split('xx/escape.txt').join('../escape.txt'),
      'latin1',
    );
    fs.writeFileSync(archive, patched);

    await expect(extractUploadedArchive(archive, { largeArchiveThreshold: 1 })).rejects.toThrow(
      /escapes extraction dir/,
    );
    // Validate-then-extract: nothing landed, and nothing escaped the dir.
    expect(fs.existsSync(path.join(d, 'evil', 'ok.txt'))).toBe(false);
    expect(fs.existsSync(path.join(d, 'escape.txt'))).toBe(false);
    expect(fs.existsSync(path.join(TMP, 'escape.txt'))).toBe(false);
  });

  it('still enforces the total-size cap on the streaming path', async () => {
    const d = dir();
    const archive = path.join(d, 'big.zip');
    fs.writeFileSync(archive, zipWith({ 'big.txt': 'x'.repeat(4096) }));
    // Declared uncompressed size (4096) exceeds the cap; parsed from `unzip -l`
    // without decompressing, so the archive is rejected before extraction.
    await expect(
      extractUploadedArchive(archive, { largeArchiveThreshold: 1, maxTotalBytes: 1024 }),
    ).rejects.toThrow(/GB|cap/);
    expect(fs.existsSync(path.join(d, 'big'))).toBe(false);
  });

  it('still enforces the entry-count cap on the streaming path', async () => {
    const d = dir();
    const archive = path.join(d, 'many.zip');
    fs.writeFileSync(archive, zipWith({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' }));
    await expect(
      extractUploadedArchive(archive, { largeArchiveThreshold: 1, maxEntries: 2 }),
    ).rejects.toThrow(/entries/);
    expect(fs.existsSync(path.join(d, 'many'))).toBe(false);
  });
});

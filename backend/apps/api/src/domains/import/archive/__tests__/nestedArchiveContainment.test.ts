/*
 * The nested pass (unpack.ts) against archives that try to leave their
 * directory. Three vectors, three guards:
 *
 *  - a symlink already in the tree, with a later archive writing "through" it
 *    (the adm-zip writer used to follow it — reproduced with Node 22);
 *  - a `../` entry, which used to make adm-zip throw and then be RETRIED with
 *    the system `unzip`, whose own defaults decided what happened;
 *  - a symlink ENTRY, which the system extractor recreates as a real link and
 *    which used to survive until the end-of-stage sweep — after every other
 *    archive in the pass had extracted next to it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import AdmZip from 'adm-zip';

import { systemExtract } from '../systemExtract';
import { unpackArchives } from '../unpack';

import { buildZip, buildZip64Eocd } from './zipFixtures';

jest.mock('../systemExtract', () => ({
  ...jest.requireActual('../systemExtract'),
  systemExtract: jest.fn(),
}));

const mockedSystemExtract = systemExtract as jest.MockedFunction<typeof systemExtract>;

function zipWith(entries: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.addFile(name, Buffer.from(content, 'utf8'));
  }

  return zip.toBuffer();
}

describe('nested archive containment', () => {
  const dirs: string[] = [];
  const scratch = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-nested-escape-'));
    dirs.push(d);

    return d;
  };

  afterEach(() => {
    mockedSystemExtract.mockReset();
    for (const d of dirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('never writes through a symlink already in the tree', async () => {
    const work = scratch();
    const staged = path.join(work, 'staged');
    const outside = path.join(work, 'outside');
    fs.mkdirSync(staged);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(staged, 'link'));
    fs.writeFileSync(
      path.join(staged, 'b.zip'),
      zipWith({ 'link/pwned.txt': 'x', 'link/deeper/pwned.txt': 'y' }),
    );

    const log: string[] = [];
    const out = await unpackArchives(staged, (m) => log.push(m));

    expect(fs.readdirSync(outside)).toEqual([]);
    expect(out).toHaveLength(0);
    expect(log.join('\n')).toMatch(/through a link/);
    // Not marked done: nothing of it is trusted, and a retry gets the same answer.
    expect(fs.existsSync(path.join(staged, 'b.zip.unpacked'))).toBe(false);
  });

  it('refuses a ../ entry outright and does not hand it to the system extractor', async () => {
    const work = scratch();
    const staged = path.join(work, 'staged');
    fs.mkdirSync(staged);
    // The raw builder, because adm-zip's own `addFile` normalises `../` away.
    fs.writeFileSync(
      path.join(staged, 'evil.zip'),
      buildZip([
        { name: '../escape.txt', contents: 'x' },
        { name: 'fine.txt', contents: 'y' },
      ]),
    );

    const log: string[] = [];
    const out = await unpackArchives(staged, (m) => log.push(m));

    expect(out).toHaveLength(0);
    expect(log.join('\n')).toMatch(/escapes extraction dir: \.\.\/escape\.txt/);
    expect(fs.existsSync(path.join(work, 'escape.txt'))).toBe(false);
    // The system extractor would have dropped the `../` and landed the file
    // here — it was never asked.
    expect(fs.existsSync(path.join(staged, 'escape.txt'))).toBe(false);
    expect(mockedSystemExtract).not.toHaveBeenCalled();
  });

  it('removes the symlinks a system-extracted archive carried before the pass continues', async () => {
    const work = scratch();
    const staged = path.join(work, 'staged');
    const outside = path.join(work, 'outside');
    fs.mkdirSync(staged);
    fs.mkdirSync(outside);

    // A ZIP64 central directory is what adm-zip cannot read, so this archive
    // takes the system path. The (mocked) extractor does what the real one
    // does with a symlink entry: recreates it.
    fs.writeFileSync(
      path.join(staged, 'a.zip'),
      buildZip64Eocd([
        { name: 'link', contents: outside },
        { name: 'data.txt', contents: 'hello' },
      ]),
    );
    mockedSystemExtract.mockImplementation(async (_archive, destDir) => {
      fs.symlinkSync(outside, path.join(destDir, 'link'));
      fs.writeFileSync(path.join(destDir, 'data.txt'), 'hello');

      return { ok: true, tool: 'unzip', detail: 'ok' } as Awaited<ReturnType<typeof systemExtract>>;
    });
    // Its sibling writes into `link/` — whichever of the two extracts first.
    fs.writeFileSync(path.join(staged, 'b.zip'), zipWith({ 'link/pwned.txt': 'x' }));

    await unpackArchives(staged, () => undefined);

    expect(mockedSystemExtract).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(outside)).toEqual([]);
    const link = path.join(staged, 'link');
    expect(!fs.existsSync(link) || !fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(staged, 'data.txt'), 'utf8')).toBe('hello');
  });
});

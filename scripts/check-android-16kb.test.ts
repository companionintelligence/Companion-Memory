/**
 * Holds scripts/check-android-16kb.mjs to what it claims, with synthetic ELF and zip files built
 * here, so no Android toolchain is needed. Three groups:
 *
 *   1. The readers: `readElf` and `readZip` against hand-built bytes, including the case the
 *      whole zip rule rests on (the data offset comes from the LOCAL header, which zipalign pads).
 *   2. The verdicts: each way a library can fail (4 KiB ELF alignment, a stored .so off a 16 KiB
 *      boundary), the ways it cannot (a deflated .so has no offset rule, a bundle has no zip rule),
 *      and the packages that must not pass by looking at nothing.
 *   3. The wiring: mobile-build.yml and mobile-release.yml must run the check after the Gradle
 *      step and before anything is uploaded, on the file that is uploaded. Nothing else notices if
 *      someone reorders the steps, because no workflow runs on its own.
 *
 * The zip rule is held to the verdicts of the real `zipalign -c -P 16 4`, recorded in a table below
 * so the test needs no Android SDK. When the SDK is on the machine (ANDROID_HOME, or zipalign on
 * PATH) one more test replays that table against the real tool; it is registered only then,
 * because the root-tests lane runs without the SDK and fails on a skipped test.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { deflateRawSync } from 'node:zlib';

import { parse } from 'yaml';

import {
  DEFAULT_ABIS,
  PAGE_SIZE,
  UsageError,
  checkPackage,
  parseArgs,
  readElf,
  readZip,
  runCli,
} from './check-android-16kb.mjs';

const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'scripts', 'check-android-16kb.mjs');

const PT_LOAD = 1;
const PT_GNU_STACK = 0x6474e551;
const AARCH64 = 0xb7;
const X86_64 = 0x3e;
const ARM = 0x28;

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

/**
 * An ELF image with one PT_LOAD program header per entry of `aligns`, then a PT_GNU_STACK whose
 * small p_align must never count: only the loadable segments are held to the page size.
 */
function elf(
  aligns: Array<number | bigint>,
  {
    bits = 64,
    machine = AARCH64,
    bigEndian = false,
  }: { bits?: 32 | 64; machine?: number; bigEndian?: boolean } = {},
): Buffer {
  const headerSize = bits === 64 ? 64 : 52;
  const entrySize = bits === 64 ? 56 : 32;
  const count = aligns.length + 1;
  const out = Buffer.alloc(headerSize + entrySize * count + 64);
  const u16 = (value: number, at: number) =>
    bigEndian ? out.writeUInt16BE(value, at) : out.writeUInt16LE(value, at);
  const u32 = (value: number, at: number) =>
    bigEndian ? out.writeUInt32BE(value, at) : out.writeUInt32LE(value, at);
  const u64 = (value: bigint, at: number) =>
    bigEndian ? out.writeBigUInt64BE(value, at) : out.writeBigUInt64LE(value, at);

  out.set([0x7f, 0x45, 0x4c, 0x46, bits === 64 ? 2 : 1, bigEndian ? 2 : 1, 1]);
  u16(3, 16); // ET_DYN
  u16(machine, 18);
  if (bits === 64) {
    u64(BigInt(headerSize), 32); // e_phoff
    u16(headerSize, 52); // e_ehsize
    u16(entrySize, 54); // e_phentsize
    u16(count, 56); // e_phnum
  } else {
    u32(headerSize, 28);
    u16(headerSize, 40);
    u16(entrySize, 42);
    u16(count, 44);
  }

  const header = (index: number, type: number, align: number | bigint) => {
    const at = headerSize + index * entrySize;
    u32(type, at);
    if (bits === 64) {
      u64(BigInt(align), at + 48);
    } else {
      u32(Number(align), at + 28);
    }
  };

  aligns.forEach((align, index) => header(index, PT_LOAD, align));
  header(aligns.length, PT_GNU_STACK, 0x10);

  return out;
}

interface ZipFile {
  name: string;
  data: Buffer;
  /** Deflate the entry instead of storing it. */
  deflate?: boolean;
  /**
   * Pad the LOCAL extra field, as zipalign does, until the entry's data starts at an offset equal
   * to this modulo 16 KiB. The central directory keeps its own, empty extra field.
   */
  dataOffsetMod?: number;
}

function zip(files: ZipFile[]): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name);
    const body = file.deflate ? deflateRawSync(file.data) : file.data;
    const method = file.deflate ? 8 : 0;
    const natural = offset + 30 + name.length;
    const pad =
      file.dataOffsetMod === undefined
        ? 0
        : (((file.dataOffsetMod - natural) % PAGE_SIZE) + PAGE_SIZE) % PAGE_SIZE;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(pad, 28);
    parts.push(local, name, Buffer.alloc(pad), body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);

    offset += 30 + name.length + pad + body.length;
  }

  const entries = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(entries.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...parts, entries, end]);
}

const OK_ELF = elf([0x4000, 0x4000]);
const OLD_ELF = elf([0x1000, 0x1000]);

const apk = (...files: ZipFile[]) =>
  zip([{ name: 'AndroidManifest.xml', data: Buffer.from('<manifest/>') }, ...files]);
const aab = (...files: ZipFile[]) =>
  zip([
    { name: 'BundleConfig.pb', data: Buffer.from('config') },
    { name: 'base/manifest/AndroidManifest.xml', data: Buffer.from('<manifest/>') },
    ...files,
  ]);

/** A stored library entry whose data starts on a 16 KiB boundary, the way AGP 8.5.1+ writes it. */
const lib = (name: string, data: Buffer, extra: Partial<ZipFile> = {}): ZipFile => ({
  name,
  data,
  dataOffsetMod: 0,
  ...extra,
});

function problemsOf(report: ReturnType<typeof checkPackage>): Record<string, string[]> {
  return Object.fromEntries(report.libraries.map((library) => [library.name, library.problems]));
}

function files(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'check-android-16kb-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  return (name: string, data: Buffer) => {
    const file = join(dir, name);
    writeFileSync(file, data);

    return file;
  };
}

function run(args: string[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runCli(args, {
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
    env,
  });

  return { code, out: out.join('\n'), err: err.join('\n') };
}

// ---------------------------------------------------------------------------------------------
// The readers
// ---------------------------------------------------------------------------------------------

test('readElf reads the p_align of every PT_LOAD and ignores the other program headers', () => {
  const parsed = readElf(elf([0x4000, 0x10000]));

  assert.equal(parsed.bits, 64);
  assert.equal(parsed.machine, AARCH64);
  assert.deepEqual(
    parsed.loads.map((segment) => segment.align),
    [0x4000n, 0x10000n],
  );
});

test('readElf handles 32-bit, big-endian and wider-than-32-bit alignments', () => {
  assert.deepEqual(readElf(elf([0x1000], { bits: 32, machine: ARM })).loads, [{ align: 0x1000n }]);
  assert.equal(readElf(elf([0x1000], { bits: 32, machine: ARM })).bits, 32);
  assert.deepEqual(readElf(elf([0x4000], { bigEndian: true })).loads, [{ align: 0x4000n }]);
  assert.deepEqual(readElf(elf([0x4000], { bits: 32, bigEndian: true })).loads, [{ align: 0x4000n }]);
  assert.deepEqual(readElf(elf([2n ** 40n])).loads, [{ align: 2n ** 40n }]);
});

test('readElf rejects what is not an ELF file, and an ELF whose program headers are cut off', () => {
  assert.throws(
    () => readElf(Buffer.from('PK\u0003\u0004 not a library at all, just bytes')),
    /not an ELF file/,
  );
  assert.throws(() => readElf(Buffer.alloc(0)), /not an ELF file/);
  assert.throws(() => readElf(OK_ELF.subarray(0, 40)), /truncated/);
  assert.throws(() => readElf(OK_ELF.subarray(0, 64 + 56)), /truncated/);

  const wrongClass = Buffer.from(OK_ELF);
  wrongClass[4] = 7;
  assert.throws(() => readElf(wrongClass), /32-bit or 64-bit/);
});

test('readZip takes the data offset from the local header, which is where zipalign puts its padding', () => {
  const archive = zip([
    { name: 'a.txt', data: Buffer.from('hello'), dataOffsetMod: 0 },
    { name: 'lib/arm64-v8a/libx.so', data: Buffer.from('world'), dataOffsetMod: 0x1000 },
    { name: 'plain.txt', data: Buffer.from('!') },
  ]);
  const [first, second, third] = readZip(archive);

  assert.equal(first.name, 'a.txt');
  assert.equal(first.dataOffset % PAGE_SIZE, 0);
  assert.equal(archive.toString('latin1', first.dataOffset, first.dataOffset + 5), 'hello');
  assert.equal(second.dataOffset % PAGE_SIZE, 0x1000);
  assert.equal(archive.toString('latin1', second.dataOffset, second.dataOffset + 5), 'world');
  assert.equal(archive.toString('latin1', third.dataOffset, third.dataOffset + 1), '!');
  assert.deepEqual([first.method, first.size, first.compressedSize], [0, 5, 5]);
});

test('readZip reads deflated entries and rejects what is not a usable zip', () => {
  const payload = Buffer.alloc(4000, 'abc');
  const [entry] = readZip(zip([{ name: 'big', data: payload, deflate: true }]));

  assert.equal(entry.method, 8);
  assert.equal(entry.size, 4000);
  assert.ok(entry.compressedSize < 4000);

  assert.throws(() => readZip(Buffer.from('definitely not a zip file')), /not a zip archive/);
  assert.throws(() => readZip(Buffer.alloc(0)), /not a zip archive/);
  assert.throws(
    () => readZip(zip([{ name: 'a', data: Buffer.from('a') }]).subarray(0, 40)),
    /not a zip archive/,
  );

  const zip64 = zip([{ name: 'a', data: Buffer.from('a') }]);
  zip64.writeUInt32LE(0xffffffff, zip64.length - 22 + 16);
  assert.throws(() => readZip(zip64), /ZIP64/);
});

// ---------------------------------------------------------------------------------------------
// The verdicts, APK
// ---------------------------------------------------------------------------------------------

test('an APK whose 64-bit libraries are 16 KiB ELF-aligned and 16 KiB zip-aligned passes', () => {
  const report = checkPackage(
    apk(
      lib('lib/arm64-v8a/libgood.so', OK_ELF),
      lib('lib/x86_64/libgood.so', elf([0x4000], { machine: X86_64 })),
      // Bigger than the page is fine: only "at least 16 KiB" is asked.
      lib('lib/arm64-v8a/libwide.so', elf([0x10000])),
    ),
  );

  assert.equal(report.kind, 'apk');
  assert.deepEqual(problemsOf(report), {
    'lib/arm64-v8a/libgood.so': [],
    'lib/x86_64/libgood.so': [],
    'lib/arm64-v8a/libwide.so': [],
  });
  assert.deepEqual(
    report.libraries.map((library) => library.machine),
    ['AArch64', 'x86-64', 'AArch64'],
  );
});

test('a library linked for 4 KiB pages fails on its ELF alignment alone, however well the zip is aligned', () => {
  const report = checkPackage(apk(lib('lib/arm64-v8a/libold.so', OLD_ELF)));
  const [problem, ...rest] = report.libraries[0].problems;

  assert.equal(rest.length, 0);
  assert.match(problem, /p_align is 0x1000, below 0x4000/);
});

test('one 4 KiB PT_LOAD among 16 KiB ones is enough to fail', () => {
  const report = checkPackage(apk(lib('lib/arm64-v8a/libmixed.so', elf([0x4000, 0x4000, 0x1000]))));

  assert.match(report.libraries[0].problems.join(), /p_align is 0x1000/);
});

test('an alignment of 0 or 1, which the ELF spec reads as "none", fails too', () => {
  for (const align of [0, 1]) {
    const report = checkPackage(apk(lib('lib/arm64-v8a/libnone.so', elf([align]))));

    assert.equal(report.libraries[0].problems.length, 1, `p_align ${align}`);
  }
});

test('a stored library that starts off a 16 KiB boundary fails, even when it is 4 KiB aligned', () => {
  for (const mod of [0x1000, 0x2000, 4, 0x3ffc]) {
    const report = checkPackage(apk(lib('lib/arm64-v8a/libshifted.so', OK_ELF, { dataOffsetMod: mod })));
    const [problem, ...rest] = report.libraries[0].problems;

    assert.equal(rest.length, 0, `offset mod 16 KiB = ${mod}`);
    assert.match(problem, /not a multiple of 16 KiB.*zipalign -c -P 16 4/);
  }
});

test('a library that fails both rules reports both', () => {
  const report = checkPackage(apk(lib('lib/x86_64/libbad.so', OLD_ELF, { dataOffsetMod: 0x1000 })));

  assert.equal(report.libraries[0].problems.length, 2);
});

test('a deflated library has no offset rule, but its ELF alignment still counts', () => {
  const unaligned = checkPackage(
    apk(
      lib('lib/arm64-v8a/libpacked.so', OK_ELF, { deflate: true, dataOffsetMod: undefined }),
      lib('lib/x86_64/libpackedold.so', OLD_ELF, { deflate: true, dataOffsetMod: undefined }),
    ),
  );

  assert.deepEqual(problemsOf(unaligned)['lib/arm64-v8a/libpacked.so'], []);
  assert.equal(unaligned.libraries[0].stored, false);
  assert.match(problemsOf(unaligned)['lib/x86_64/libpackedold.so'].join(), /p_align is 0x1000/);
});

test('32-bit ABIs are skipped by default and checked when asked for', () => {
  const archive = apk(
    lib('lib/arm64-v8a/libgood.so', OK_ELF),
    lib('lib/armeabi-v7a/libold.so', elf([0x1000], { bits: 32, machine: ARM })),
    lib('lib/x86/libold.so', elf([0x1000], { bits: 32, machine: 0x03 })),
  );

  const byDefault = checkPackage(archive);
  assert.deepEqual(
    byDefault.libraries.map((library) => library.name),
    ['lib/arm64-v8a/libgood.so'],
  );
  assert.deepEqual(byDefault.skipped, [
    { name: 'lib/armeabi-v7a/libold.so', abi: 'armeabi-v7a' },
    { name: 'lib/x86/libold.so', abi: 'x86' },
  ]);

  const everything = checkPackage(archive, { abis: ['all'] });
  assert.equal(everything.libraries.length, 3);
  assert.equal(everything.libraries.filter((library) => library.problems.length > 0).length, 2);

  const named = checkPackage(archive, { abis: ['armeabi-v7a'] });
  assert.deepEqual(
    named.libraries.map((library) => library.name),
    ['lib/armeabi-v7a/libold.so'],
  );
});

test('an .so outside lib/<abi>/ is listed, not checked, and what is not an .so is ignored', () => {
  const report = checkPackage(
    apk(
      lib('lib/arm64-v8a/libgood.so', OK_ELF),
      lib('assets/libextra.so', OLD_ELF),
      // An AAB-shaped path inside an APK is just an asset.
      lib('assets/lib/x86_64/libasset.so', OLD_ELF),
      lib('lib/arm64-v8a/gdbserver', OLD_ELF),
      lib('lib/arm64-v8a/libgood.so.sym', OLD_ELF),
    ),
  );

  assert.deepEqual(problemsOf(report), { 'lib/arm64-v8a/libgood.so': [] });
  assert.deepEqual(report.unchecked, ['assets/libextra.so', 'assets/lib/x86_64/libasset.so']);
});

test('a library that is not ELF, has no PT_LOAD, or is cut off fails with a reason instead of crashing', () => {
  const noLoad = elf([]);
  const archive = apk(
    lib('lib/arm64-v8a/libjunk.so', Buffer.from('this is not an ELF library')),
    lib('lib/arm64-v8a/libnoload.so', noLoad),
  );
  const report = checkPackage(archive);

  assert.match(report.libraries[0].problems[0], /cannot be read as an ELF library: not an ELF file/);
  assert.match(report.libraries[1].problems[0], /no PT_LOAD segment/);

  // Claim more data than the file holds.
  const cut = apk(lib('lib/arm64-v8a/libcut.so', OK_ELF));
  const directory = cut.length - 22 - 46 - 'lib/arm64-v8a/libcut.so'.length;
  cut.writeUInt32LE(0x7fffffff, directory + 20);
  assert.match(checkPackage(cut).libraries[0].problems[0], /runs past the end of the file/);
});

test('a package with no library to check says so instead of passing', () => {
  const empty = checkPackage(apk());

  assert.deepEqual(empty.libraries, []);
  assert.deepEqual(checkPackage(apk(lib('lib/armeabi-v7a/libold.so', OLD_ELF))).libraries, []);
});

// ---------------------------------------------------------------------------------------------
// The verdicts, AAB
// ---------------------------------------------------------------------------------------------

test('an .aab is recognised by BundleConfig.pb and its base/ and feature modules are checked', () => {
  const report = checkPackage(
    aab(
      lib('base/lib/arm64-v8a/libgood.so', OK_ELF),
      lib('base/lib/x86_64/libold.so', OLD_ELF),
      lib('feature_maps/lib/arm64-v8a/libfeatureold.so', OLD_ELF),
      lib('base/lib/armeabi-v7a/libold32.so', elf([0x1000], { bits: 32, machine: ARM })),
    ),
  );

  assert.equal(report.kind, 'aab');
  assert.deepEqual(
    Object.entries(problemsOf(report)).map(([name, problems]) => [name, problems.length]),
    [
      ['base/lib/arm64-v8a/libgood.so', 0],
      ['base/lib/x86_64/libold.so', 1],
      ['feature_maps/lib/arm64-v8a/libfeatureold.so', 1],
    ],
  );
  assert.equal(report.skipped.length, 1);
});

test('the zip offset rule does not apply to an .aab, which Play re-cuts into APKs', () => {
  const report = checkPackage(
    aab(
      lib('base/lib/arm64-v8a/libshifted.so', OK_ELF, { dataOffsetMod: 0x1000 }),
      lib('base/lib/x86_64/libpacked.so', OK_ELF, { deflate: true, dataOffsetMod: undefined }),
    ),
  );

  assert.deepEqual(problemsOf(report), {
    'base/lib/arm64-v8a/libshifted.so': [],
    'base/lib/x86_64/libpacked.so': [],
  });
});

test('an APK-shaped lib/ path inside an .aab is not a library', () => {
  const report = checkPackage(aab(lib('lib/arm64-v8a/libstray.so', OLD_ELF)));

  assert.deepEqual(report.libraries, []);
  assert.deepEqual(report.unchecked, ['lib/arm64-v8a/libstray.so']);
});

// ---------------------------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------------------------

test('parseArgs: the defaults, --abi in both spellings, --allow-empty, and what it refuses', () => {
  assert.deepEqual(parseArgs(['a.apk']), {
    files: ['a.apk'],
    abis: DEFAULT_ABIS,
    allowEmpty: false,
    help: false,
  });
  assert.deepEqual(DEFAULT_ABIS, ['arm64-v8a', 'x86_64']);
  assert.deepEqual(parseArgs(['--abi', 'arm64-v8a, x86 ,', 'a.apk']).abis, ['arm64-v8a', 'x86']);
  assert.deepEqual(parseArgs(['--abi=all', 'a.apk', 'b.aab']), {
    files: ['a.apk', 'b.aab'],
    abis: ['all'],
    allowEmpty: false,
    help: false,
  });
  assert.equal(parseArgs(['--allow-empty', 'a.apk']).allowEmpty, true);
  assert.equal(parseArgs(['--help']).help, true);

  assert.throws(() => parseArgs(['--abi']), UsageError);
  assert.throws(() => parseArgs(['--abi=', 'a.apk']), UsageError);
  assert.throws(() => parseArgs(['--bogus', 'a.apk']), /unknown option --bogus/);
});

test('runCli exits 0 and lists every library when all of them are compatible', (t) => {
  const write = files(t);
  const file = write(
    'app-debug.apk',
    apk(
      lib('lib/arm64-v8a/libgood.so', OK_ELF),
      lib('lib/x86_64/libgood.so', elf([0x4000], { machine: X86_64 })),
    ),
  );
  const { code, out, err } = run([file]);

  assert.equal(code, 0);
  assert.equal(err, '');
  assert.match(out, /^check-android-16kb: app-debug\.apk \(apk, ABIs: arm64-v8a, x86_64\)$/m);
  assert.match(out, /^PASS {2}lib\/arm64-v8a\/libgood\.so {2}AArch64 {2}p_align 0x4000 {2}stored@0x/m);
  assert.match(out, /^PASS {2}lib\/x86_64\/libgood\.so {2}x86-64/m);
  assert.match(out, /^OK: 2 native libraries in app-debug\.apk are 16 KB compatible$/m);
});

test('runCli exits 1 and names the failing library and why', (t) => {
  const write = files(t);
  const file = write(
    'app-release.aab',
    aab(lib('base/lib/arm64-v8a/libgood.so', OK_ELF), lib('base/lib/arm64-v8a/libold.so', OLD_ELF)),
  );
  const { code, out } = run([file]);

  assert.equal(code, 1);
  assert.match(out, /^PASS {2}base\/lib\/arm64-v8a\/libgood\.so/m);
  assert.match(out, /^FAIL {2}base\/lib\/arm64-v8a\/libold\.so {2}AArch64 {2}p_align 0x1000 {2}in bundle$/m);
  assert.match(out, /^ {8}- ELF PT_LOAD p_align is 0x1000, below 0x4000 \(16 KiB\)/m);
  assert.match(out, /^FAILED: 1 of 2 native libraries in app-release\.aab are not 16 KB compatible$/m);
  assert.doesNotMatch(out, /::error/);
});

test('runCli adds a GitHub annotation per failing library only inside GitHub Actions', (t) => {
  const write = files(t);
  const file = write('app.apk', apk(lib('lib/arm64-v8a/libold.so', OLD_ELF, { dataOffsetMod: 0x1000 })));
  const { out } = run([file], { GITHUB_ACTIONS: 'true' });
  const annotations = out.split('\n').filter((line) => line.startsWith('::error'));

  assert.equal(annotations.length, 1);
  assert.match(
    annotations[0],
    /^::error title=16 KB page size::app\.apk: lib\/arm64-v8a\/libold\.so: ELF PT_LOAD/,
  );
  assert.doesNotMatch(run([file], { GITHUB_ACTIONS: 'false' }).out, /::error/);
});

test('runCli fails a package with nothing to check unless --allow-empty says that is expected', (t) => {
  const write = files(t);
  const file = write('java-only.apk', apk(lib('lib/armeabi-v7a/libold.so', OLD_ELF)));
  const refused = run([file]);

  assert.equal(refused.code, 1);
  assert.match(refused.out, /FAILED: java-only\.apk has no native library in arm64-v8a, x86_64 to check/);
  assert.match(refused.out, /skipped 1 libraries in ABIs not checked \(armeabi-v7a\)/);

  assert.equal(run(['--allow-empty', file]).code, 0);
  // ...and asking for the 32-bit ABI finds the library, which then fails on its own merits.
  assert.equal(run(['--abi', 'armeabi-v7a', file]).code, 1);
});

test('runCli checks every file it is given and exits with the worst result', (t) => {
  const write = files(t);
  const good = write('good.apk', apk(lib('lib/arm64-v8a/libgood.so', OK_ELF)));
  const bad = write('bad.apk', apk(lib('lib/arm64-v8a/libold.so', OLD_ELF)));
  const { code, out } = run([good, bad]);

  assert.equal(code, 1);
  assert.match(out, /^OK: 1 native libraries in good\.apk/m);
  assert.match(out, /^FAILED: 1 of 1 native libraries in bad\.apk/m);
});

test('runCli exits 2 for a bad invocation or a file that is not an APK, and says which', (t) => {
  const write = files(t);
  const notZip = write('not-a.apk', Buffer.from('not a zip file at all'));

  assert.equal(run([]).code, 2);
  assert.match(run([]).err, /no APK or AAB given/);
  assert.equal(run(['--bogus', notZip]).code, 2);
  assert.match(run(['--bogus', notZip]).err, /unknown option --bogus/);

  const unreadable = run([join(dirname(notZip), 'missing.apk')]);
  assert.equal(unreadable.code, 2);
  assert.match(unreadable.err, /missing\.apk: ENOENT/);

  const notAnApk = run([notZip]);
  assert.equal(notAnApk.code, 2);
  assert.match(notAnApk.err, /not-a\.apk: not a zip archive/);

  assert.equal(run(['--help']).code, 0);
});

test('the script runs as a program: exit status and output reach the caller', (t) => {
  const write = files(t);
  const good = write('good.apk', apk(lib('lib/arm64-v8a/libgood.so', OK_ELF)));
  const bad = write('bad.apk', apk(lib('lib/arm64-v8a/libold.so', OLD_ELF)));

  const passed = spawnSync(process.execPath, [SCRIPT, good], { encoding: 'utf8' });
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /OK: 1 native libraries in good\.apk are 16 KB compatible/);

  const failed = spawnSync(process.execPath, [SCRIPT, bad], { encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /FAIL {2}lib\/arm64-v8a\/libold\.so/);

  const usage = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /no APK or AAB given/);
});

// ---------------------------------------------------------------------------------------------
// The same zip rule, as the Android SDK's own zipalign sees it
// ---------------------------------------------------------------------------------------------

function findZipalign(): string | undefined {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  const tools = sdk ? join(sdk, 'build-tools') : '';
  if (tools && existsSync(tools)) {
    const newest = readdirSync(tools)
      .filter((version) => existsSync(join(tools, version, 'zipalign')))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
    if (newest) {
      return join(tools, newest, 'zipalign');
    }
  }

  return spawnSync('zipalign', [], { encoding: 'utf8' }).error ? undefined : 'zipalign';
}

const ZIPALIGN = findZipalign();

// What `zipalign -c -P 16 4` says about a stored library whose data starts `mod` bytes past a
// 16 KiB boundary: it accepts only the entry on the boundary. Recorded from the Android SDK's
// build-tools 36.1 on 2026-11-23; the test registered below re-derives it when zipalign is here.
const ZIPALIGN_ACCEPTS_AT_OFFSET_MOD = [
  [0, true],
  [0x1000, false],
  [0x2000, false],
  [0x3ffc, false],
  [4, false],
] as const;

function probeArchive(mod: number): ReturnType<typeof zip> {
  return zip([{ name: 'lib/arm64-v8a/libprobe.so', data: OK_ELF, dataOffsetMod: mod }]);
}

test('the zip rule gives the verdicts `zipalign -c -P 16 4` gives, at each kind of offset', () => {
  for (const [mod, zipalignAccepts] of ZIPALIGN_ACCEPTS_AT_OFFSET_MOD) {
    const mine = checkPackage(probeArchive(mod)).libraries[0].problems.some((problem) =>
      problem.includes('zipalign'),
    );

    assert.equal(mine, !zipalignAccepts, `offset mod 16 KiB = ${mod}`);
  }
});

if (ZIPALIGN) {
  const zipalign: string = ZIPALIGN;

  test('the recorded zipalign verdicts still match the real `zipalign -c -P 16 4`', (t) => {
    const write = files(t);

    for (const [mod, zipalignAccepts] of ZIPALIGN_ACCEPTS_AT_OFFSET_MOD) {
      const theirs = spawnSync(
        zipalign,
        ['-c', '-P', '16', '4', write(`probe-${mod}.apk`, probeArchive(mod))],
        {
          encoding: 'utf8',
        },
      );

      assert.equal(
        theirs.status === 0,
        zipalignAccepts,
        `offset mod 16 KiB = ${mod}: zipalign said ${theirs.status}`,
      );
    }
  });
}

// ---------------------------------------------------------------------------------------------
// The wiring: where the two workflows run it
// ---------------------------------------------------------------------------------------------

interface Step {
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  'continue-on-error'?: boolean;
  with?: Record<string, string>;
}

function androidSteps(workflow: string): Step[] {
  const doc = parse(readFileSync(join(ROOT, '.github', 'workflows', workflow), 'utf8'));

  return doc.jobs.android.steps as Step[];
}

const isUpload = (step: Step) => /upload-artifact|upload-google-play/.test(step.uses ?? '');
const CHECK = /^node scripts\/check-android-16kb\.mjs (\S+)\s*$/;

function checkStepOf(steps: Step[]) {
  const index = steps.findIndex((step) => /check-android-16kb\.mjs/.test(step.run ?? ''));
  assert.ok(index >= 0, 'no step runs scripts/check-android-16kb.mjs');
  const target = CHECK.exec(steps[index].run?.trim() ?? '')?.[1];
  assert.ok(
    target,
    `the check step is not "node scripts/check-android-16kb.mjs <file>": ${steps[index].run}`,
  );

  // A step that can be skipped or can fail without failing the job is not a gate.
  assert.equal(steps[index].if, undefined, 'the check step must not be conditional');
  assert.notEqual(steps[index]['continue-on-error'], true, 'the check step must be able to fail the job');

  return { index, target };
}

test('mobile-release.yml checks the .aab after bundleRelease and before it is uploaded or sent to Play', () => {
  const steps = androidSteps('mobile-release.yml');
  const build = steps.findIndex((step) => /gradlew bundleRelease/.test(step.run ?? ''));
  const { index, target } = checkStepOf(steps);
  const uploads = steps.flatMap((step, at) => (isUpload(step) ? [at] : []));

  assert.ok(build >= 0, 'no bundleRelease step');
  assert.ok(index > build, 'the check must come after the bundle is built');
  assert.ok(uploads.length >= 3, 'expected the artifact upload and both Play steps');
  assert.ok(
    uploads.every((at) => at > index),
    'every upload and submission must come after the check',
  );

  // ...and it reads the file those steps send, not some other one.
  assert.match(target, /\/outputs\/bundle\/release\/app-release\.aab$/);
  for (const step of steps.filter((step) => /upload-google-play/.test(step.uses ?? ''))) {
    assert.equal(step.with?.releaseFiles, target);
  }

  const artifact = steps.find((step) => /upload-artifact/.test(step.uses ?? ''));
  assert.equal(dirname(artifact?.with?.path ?? ''), dirname(target));
});

test('mobile-build.yml checks the debug APK after assembleDebug and before any artifact is uploaded', () => {
  const steps = androidSteps('mobile-build.yml');
  const build = steps.findIndex((step) => /gradlew assembleDebug/.test(step.run ?? ''));
  const { index, target } = checkStepOf(steps);
  const uploads = steps.flatMap((step, at) => (isUpload(step) ? [at] : []));

  assert.ok(build >= 0, 'no assembleDebug step');
  assert.ok(index > build, 'the check must come after the APK is built');
  assert.ok(
    uploads.length > 0 && uploads.every((at) => at > index),
    'every upload must come after the check',
  );

  // The upload takes `outputs/apk/**/*.apk`; the checked file has to be one of those.
  assert.match(target, /\/outputs\/apk\/debug\/app-debug\.apk$/);
  const apkUpload = steps.find((step) => step.name === 'Upload APK');
  assert.ok(apkUpload?.with?.path, 'no "Upload APK" step');
  assert.ok(
    target.startsWith(apkUpload.with.path.split('**')[0]),
    `${target} is not under ${apkUpload.with.path}`,
  );
});

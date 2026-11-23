#!/usr/bin/env node
/**
 * Fail when a built Android package ships a native library that cannot run on a 16 KB-page device.
 *
 * Google Play requires every app that targets Android 15 (API 35) or higher to support 16 KB memory
 * pages. For one packaged .so that comes down to two facts. Both are read here with Node's standard
 * library alone (no unzip, no zipalign, no readelf), so the same file runs on a laptop and on a
 * stock ubuntu or macOS runner:
 *
 *   1. ELF alignment. Every PT_LOAD program header needs p_align >= 0x4000 (16 KiB). A library
 *      linked for 4 KiB pages carries p_align 0x1000, and the loader on a 16 KB device refuses it.
 *   2. Zip alignment, APK only. An .so stored UNCOMPRESSED is mapped straight out of the APK, so its
 *      bytes must start at a multiple of 16 KiB: the rule `zipalign -c -P 16 4` checks. A deflated .so
 *      is extracted at install time and has no offset rule. An .aab is never installed (Play cuts
 *      APKs from it), so only rule 1 applies to a bundle.
 *
 * Only the 64-bit ABIs are checked by default, arm64-v8a and x86_64: Play's rule is about 64-bit
 * libraries, and a 32-bit library on its own does not fail it. `--abi` changes the list.
 *
 * Usage:
 *   node scripts/check-android-16kb.mjs <file.apk|file.aab> [more files...]
 *   node scripts/check-android-16kb.mjs --abi arm64-v8a,x86_64,armeabi-v7a app-release.aab
 *   node scripts/check-android-16kb.mjs --abi all app-debug.apk
 *   node scripts/check-android-16kb.mjs --allow-empty app-without-native-code.apk
 *
 * Exit code 0: every checked library is compatible. 1: at least one is not, or the package holds no
 * library to check (a check that looked at nothing proves nothing, so that fails too; --allow-empty
 * opts out). 2: a usage error, or a file that is not a readable APK or AAB.
 *
 * Dependency-free on purpose, like its siblings in this directory: the Android jobs of
 * mobile-build.yml and mobile-release.yml run it with the Node that actions/setup-node installed,
 * straight after the Gradle step and before anything is uploaded. scripts/check-android-16kb.test.ts
 * builds synthetic ELF and zip files for it and also pins where the two workflows call it.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

/** 16 KiB, the page size this check is for. */
export const PAGE_SIZE = 0x4000;

/** The 64-bit ABIs. Play's 16 KB rule is about 64-bit libraries. */
export const DEFAULT_ABIS = ['arm64-v8a', 'x86_64'];

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const PT_LOAD = 1;

/** `lib/<abi>/<name>.so` in an APK, `<module>/lib/<abi>/<name>.so` in an AAB. */
const LIBRARY_PATH = {
  apk: /^lib\/([^/]+)\/[^/]+\.so$/,
  aab: /^[^/]+\/lib\/([^/]+)\/[^/]+\.so$/,
};

const MACHINES = new Map([
  [0x03, 'x86'],
  [0x28, 'ARM'],
  [0x3e, 'x86-64'],
  [0xb7, 'AArch64'],
  [0xf3, 'RISC-V'],
]);

/** A mistake in how the script was called, as opposed to a library that fails the check. */
export class UsageError extends Error {}

const hex = (value) => `0x${value.toString(16)}`;

// ---------------------------------------------------------------------------------------------
// Zip
// ---------------------------------------------------------------------------------------------

function findEndOfCentralDirectory(buf) {
  const lowest = Math.max(0, buf.length - 22 - 0xffff);
  for (let at = buf.length - 22; at >= lowest; at--) {
    // The record must end exactly where its own comment length says the file does, or a signature
    // that happens to sit inside a comment would be taken for it.
    if (buf.readUInt32LE(at) === EOCD_SIGNATURE && at + 22 + buf.readUInt16LE(at + 20) === buf.length) {
      return at;
    }
  }

  throw new Error('not a zip archive: no end-of-central-directory record');
}

/**
 * The entries of a zip file as { name, method, compressedSize, size, dataOffset }, where
 * `dataOffset` is where the entry's bytes start in the file: the thing zipalign aligns.
 *
 * It is taken from the entry's LOCAL header, not from the central directory, because the two extra
 * fields differ. zipalign aligns an entry by padding the local one, and nothing else records that.
 * ZIP64 is refused rather than half-read: no APK or AAB this app builds comes near 4 GiB.
 */
export function readZip(buf) {
  const eocd = findEndOfCentralDirectory(buf);
  const count = buf.readUInt16LE(eocd + 10);
  const directorySize = buf.readUInt32LE(eocd + 12);
  const directoryOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new Error('ZIP64 archives are not supported');
  }

  if (directoryOffset + directorySize > eocd) {
    throw new Error('the central directory runs past the end-of-central-directory record');
  }

  const entries = [];
  let at = directoryOffset;
  for (let index = 0; index < count; index++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
      throw new Error(`central directory entry ${index} is malformed`);
    }

    const method = buf.readUInt16LE(at + 10);
    const compressedSize = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const headerOffset = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLength);
    if (compressedSize === 0xffffffff || size === 0xffffffff || headerOffset === 0xffffffff) {
      throw new Error(`${name}: ZIP64 entries are not supported`);
    }

    if (headerOffset + 30 > buf.length || buf.readUInt32LE(headerOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`${name}: the local header is missing or malformed`);
    }

    const dataOffset =
      headerOffset + 30 + buf.readUInt16LE(headerOffset + 26) + buf.readUInt16LE(headerOffset + 28);
    entries.push({ name, method, compressedSize, size, dataOffset });
    at += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/** The uncompressed bytes of one entry. */
function entryBytes(buf, entry) {
  const end = entry.dataOffset + entry.compressedSize;
  if (end > buf.length) {
    throw new Error('its data runs past the end of the file (truncated archive?)');
  }

  const stored = buf.subarray(entry.dataOffset, end);
  if (entry.method === 0) {
    return stored;
  }

  if (entry.method === 8) {
    return inflateRawSync(stored);
  }

  throw new Error(`compression method ${entry.method} is not supported`);
}

// ---------------------------------------------------------------------------------------------
// ELF
// ---------------------------------------------------------------------------------------------

/**
 * The machine, the word size and the p_align of every PT_LOAD program header of an ELF file.
 * `align` is a BigInt: a 64-bit ELF stores it in 8 bytes.
 *
 * @returns {{ bits: 32 | 64, machine: number, loads: Array<{ align: bigint }> }}
 */
export function readElf(bytes) {
  if (bytes.length < 20 || bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
    throw new Error('not an ELF file');
  }

  const [wordSize, byteOrder] = [bytes[4], bytes[5]];
  if ((wordSize !== 1 && wordSize !== 2) || (byteOrder !== 1 && byteOrder !== 2)) {
    throw new Error('not a 32-bit or 64-bit ELF file with a known byte order');
  }

  const bits = wordSize === 2 ? 64 : 32;
  const little = byteOrder === 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < (bits === 64 ? 64 : 52)) {
    throw new Error('the ELF header is truncated');
  }

  const machine = view.getUint16(18, little);
  const tableOffset = bits === 64 ? Number(view.getBigUint64(32, little)) : view.getUint32(28, little);
  const entrySize = view.getUint16(bits === 64 ? 54 : 42, little);
  const entryCount = view.getUint16(bits === 64 ? 56 : 44, little);
  if (entryCount > 0 && entrySize < (bits === 64 ? 56 : 32)) {
    throw new Error('the program header entries are smaller than an ELF program header');
  }

  if (tableOffset + entrySize * entryCount > bytes.length) {
    throw new Error('the program header table is truncated');
  }

  const loads = [];
  for (let index = 0; index < entryCount; index++) {
    const at = tableOffset + index * entrySize;
    if (view.getUint32(at, little) !== PT_LOAD) {
      continue;
    }

    loads.push({
      align: bits === 64 ? view.getBigUint64(at + 48, little) : BigInt(view.getUint32(at + 28, little)),
    });
  }

  return { bits, machine, loads };
}

// ---------------------------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------------------------

/**
 * One library, checked. `problems` is empty when it passes.
 *
 * @returns {{ name: string, abi: string, stored: boolean, dataOffset: number, machine: string,
 *   alignments: bigint[], problems: string[] }}
 */
function checkLibrary(buf, entry, abi, kind) {
  const result = {
    name: entry.name,
    abi,
    stored: entry.method === 0,
    dataOffset: entry.dataOffset,
    machine: '',
    alignments: [],
    problems: [],
  };

  let elf;
  try {
    elf = readElf(entryBytes(buf, entry));
  } catch (error) {
    result.problems.push(`cannot be read as an ELF library: ${error.message}`);

    return result;
  }

  result.machine = MACHINES.get(elf.machine) ?? `machine ${hex(elf.machine)}`;
  result.alignments = elf.loads.map((segment) => segment.align);
  if (elf.loads.length === 0) {
    result.problems.push('has no PT_LOAD segment, so there is nothing for the loader to align');
  }

  const smallest = result.alignments.reduce(
    (least, align) => (align < least ? align : least),
    BigInt(PAGE_SIZE),
  );
  if (smallest < BigInt(PAGE_SIZE)) {
    result.problems.push(
      `ELF PT_LOAD p_align is ${hex(smallest)}, below ${hex(PAGE_SIZE)} (16 KiB): it was linked for ` +
        'smaller pages. Take a release of the dependency built with NDK r28 or newer, or relink with ' +
        '-Wl,-z,max-page-size=16384',
    );
  }

  if (kind === 'apk' && result.stored && entry.dataOffset % PAGE_SIZE !== 0) {
    result.problems.push(
      `stored uncompressed at offset ${hex(entry.dataOffset)}, which is not a multiple of 16 KiB ` +
        '(`zipalign -c -P 16 4` fails). Build with AGP 8.5.1 or newer, or run `zipalign -P 16 4` ' +
        'before signing',
    );
  }

  return result;
}

/**
 * Check every native library of an APK or AAB, given as the bytes of the file.
 *
 * @param {Buffer} buf
 * @param {{ abis?: string[] }} [options] ABIs to check; `all` means every ABI present.
 * @returns {{ kind: 'apk' | 'aab', libraries: ReturnType<typeof checkLibrary>[],
 *   skipped: Array<{ name: string, abi: string }>, unchecked: string[] }}
 *   `skipped` are libraries of ABIs that were not asked for; `unchecked` are .so entries outside
 *   lib/<abi>/, which nothing loads by name.
 */
export function checkPackage(buf, { abis = DEFAULT_ABIS } = {}) {
  const entries = readZip(buf);
  const kind = entries.some((entry) => entry.name === 'BundleConfig.pb') ? 'aab' : 'apk';
  const wanted = abis.includes('all') ? null : new Set(abis);
  const libraries = [];
  const skipped = [];
  const unchecked = [];

  for (const entry of entries) {
    if (!entry.name.endsWith('.so')) {
      continue;
    }

    const match = LIBRARY_PATH[kind].exec(entry.name);
    if (!match) {
      unchecked.push(entry.name);
    } else if (wanted && !wanted.has(match[1])) {
      skipped.push({ name: entry.name, abi: match[1] });
    } else {
      libraries.push(checkLibrary(buf, entry, match[1], kind));
    }
  }

  return { kind, libraries, skipped, unchecked };
}

// ---------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------

const USAGE = `usage: check-android-16kb.mjs [--abi <abi,abi,...|all>] [--allow-empty] <file.apk|file.aab> [...]

  --abi          ABIs to check (default: ${DEFAULT_ABIS.join(',')}); "all" checks every ABI in the file
  --allow-empty  do not fail when the package has no native library to check`;

export function parseArgs(argv) {
  const options = { files: [], abis: DEFAULT_ABIS, allowEmpty: false, help: false };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '--allow-empty') {
      options.allowEmpty = true;
    } else if (arg === '--abi' || arg.startsWith('--abi=')) {
      const value = arg === '--abi' ? argv[++index] : arg.slice('--abi='.length);
      const abis = (value ?? '')
        .split(',')
        .map((abi) => abi.trim())
        .filter(Boolean);
      if (abis.length === 0) {
        throw new UsageError('--abi needs a value, such as --abi arm64-v8a,x86_64 or --abi all');
      }

      options.abis = abis;
    } else if (arg.startsWith('-')) {
      throw new UsageError(`unknown option ${arg}`);
    } else {
      options.files.push(arg);
    }
  }

  return options;
}

/** A GitHub Actions annotation line. */
function annotation(message) {
  const escaped = message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

  return `::error title=16 KB page size::${escaped}`;
}

function libraryLines(library, kind) {
  const alignments = [...new Set(library.alignments.map(hex))].join(',') || 'none';
  const where =
    kind === 'apk' ? (library.stored ? `stored@${hex(library.dataOffset)}` : 'deflated') : 'in bundle';
  const lines = [
    `${library.problems.length === 0 ? 'PASS' : 'FAIL'}  ${library.name}  ` +
      `${library.machine || 'unreadable'}  p_align ${alignments}  ${where}`,
  ];
  for (const problem of library.problems) {
    lines.push(`        - ${problem}`);
  }

  return lines;
}

/**
 * Check each file named in `argv`.
 *
 * @returns {number} the exit code
 */
export function runCli(argv, { out = console.log, err = console.error, env = process.env } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    err(`check-android-16kb: ${error.message}\n${USAGE}`);

    return 2;
  }

  if (options.help) {
    out(USAGE);

    return 0;
  }

  if (options.files.length === 0) {
    err(`check-android-16kb: no APK or AAB given\n${USAGE}`);

    return 2;
  }

  let exitCode = 0;
  for (const file of options.files) {
    let report;
    try {
      report = checkPackage(readFileSync(file), { abis: options.abis });
    } catch (error) {
      err(`check-android-16kb: ${file}: ${error.message}`);
      exitCode = Math.max(exitCode, 2);
      continue;
    }

    out(`check-android-16kb: ${basename(file)} (${report.kind}, ABIs: ${options.abis.join(', ')})`);
    for (const library of report.libraries) {
      for (const line of libraryLines(library, report.kind)) {
        out(line);
      }
    }

    if (report.skipped.length > 0) {
      const abis = [...new Set(report.skipped.map((library) => library.abi))].join(', ');
      out(
        `skipped ${report.skipped.length} libraries in ABIs not checked (${abis}); --abi all includes them`,
      );
    }

    if (report.unchecked.length > 0) {
      out(`not checked, outside lib/<abi>/: ${report.unchecked.join(', ')}`);
    }

    const failed = report.libraries.filter((library) => library.problems.length > 0);
    if (failed.length > 0) {
      out(
        `FAILED: ${failed.length} of ${report.libraries.length} native libraries in ${basename(file)} are not 16 KB compatible`,
      );
      if (env.GITHUB_ACTIONS === 'true') {
        for (const library of failed) {
          out(annotation(`${basename(file)}: ${library.name}: ${library.problems.join('; ')}`));
        }
      }

      exitCode = Math.max(exitCode, 1);
    } else if (report.libraries.length === 0 && !options.allowEmpty) {
      out(
        `FAILED: ${basename(file)} has no native library in ${options.abis.join(', ')} to check, and a check ` +
          'that looked at nothing proves nothing. Is the path right, or did an ABI filter drop them? ' +
          'Pass --allow-empty if the app really ships none.',
      );
      exitCode = Math.max(exitCode, 1);
    } else {
      out(`OK: ${report.libraries.length} native libraries in ${basename(file)} are 16 KB compatible`);
    }
  }

  return exitCode;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = runCli(process.argv.slice(2));
}

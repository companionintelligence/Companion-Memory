import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { NameRepairOptions, NameRepairResult } from './repairEntryNames';
import { repairEntryNames } from './repairEntryNames';

/**
 * Extracting a zip through whichever system extractor can actually read it.
 *
 * `unzip` is the primary and stays that way: it is what the appliance image
 * ships, it streams (so a 50GB Takeout split never has to fit in memory), it
 * reads ZIP64, and it is tolerant of the path-collision quirks in Drive exports
 * that abort stricter extractors.
 *
 * It is also, on macOS, unable to extract a large class of real exports. The
 * system `unzip` there is Info-ZIP 6.00 (2009) with no `-O`/charset flag, so an
 * entry whose name is not ASCII — `Voice/Calls/Mariana Acuña - Text - ….html`
 * in a Google Takeout, which is to say any export belonging to a person with
 * accented names in their contacts — fails to create the file and aborts the
 * whole archive with **exit 50**, whose documented meaning is "the disk is (or
 * was) full during extraction". The disk is not full. Nothing downstream can
 * tell those two apart, so the run surfaces a disk error for a filename problem
 * and a multi-gigabyte import dies at 0%.
 *
 * The `-O`/`-I` charset flags that would make Info-ZIP read those names as
 * UTF-8 are a Fedora/RHEL patch. Debian and Ubuntu — and therefore the
 * appliance image and CI's `node:22` — do NOT carry it: their `unzip` has no
 * `-O`, and instead translates the bytes through a compiled-in CP437 table, so
 * the same Takeout that dies on macOS lands mojibake'd (`ñ` → `+¦`) on Linux.
 * That is not a locale setting; `LC_ALL=C.UTF-8` and `-UU` change nothing. So
 * neither of the two extractors can be relied on to write the real name, and
 * `./repairEntryNames` fixes the difference afterwards by reading the archive's
 * own central directory. `ditto` is still the macOS fallback for the exit-50
 * abort, which is a failure to extract at all rather than a naming problem.
 *
 * Path containment is deliberately NOT this module's job — callers that need it
 * (see `extract.ts`) assert it against the archive's listed entry names before
 * extracting, which holds whichever extractor then runs. The one exception is
 * the repair pass, which writes names the caller never saw and so re-checks
 * containment itself.
 */

export interface SystemExtractResult {
  ok: boolean;
  /**
   * True when an extractor errored but still produced a tree. A real Google
   * Takeout can carry entries no extractor will take — a name used as both a
   * file and a directory (a Drive-export quirk), an unsupported compression
   * method — and failing the whole archive over them throws away everything
   * else. Callers import what arrived and report the shortfall.
   */
  partial?: boolean;
  /** Which extractor produced the tree. `null` when none could run. */
  tool: 'unzip' | 'ditto' | null;
  /** Human-readable cause, for the error a caller raises. Empty when ok. */
  detail: string;
  /**
   * Outcome of the UTF-8 name repair (see `./repairEntryNames`). Absent when
   * the archive had no at-risk names, which is the common case.
   */
  nameRepair?: NameRepairResult;
}

export interface SystemExtractOptions {
  /**
   * `destDir` holds the output of THIS archive and nothing else, so the name
   * repair may delete the mangled copies it replaces (see
   * `NameRepairOptions.sweep`). `extract.ts` extracts into a directory named
   * after the archive and passes this; `unpack.ts` expands into the folder
   * that CONTAINS the archives and must not.
   */
  exclusiveDest?: boolean;
}

let unzipProbe: boolean | undefined;

/** Whether the system `unzip` can be invoked at all. Cached; probes once. */
export function systemUnzipAvailable(): boolean {
  if (unzipProbe === undefined) {
    try {
      unzipProbe = spawnSync('unzip', ['-v'], { stdio: 'ignore' }).status === 0;
    } catch {
      unzipProbe = false;
    }
  }

  return unzipProbe;
}

let unzipUtf8CharsetProbe: boolean | undefined;

/**
 * Whether this `unzip` accepts `-O`/`-I` charset flags (Debian/Ubuntu yes,
 * stock macOS Info-ZIP 6.00 no). Cached; probes once via `unzip -hh`.
 */
export function unzipSupportsUtf8Charset(): boolean {
  if (unzipUtf8CharsetProbe === undefined) {
    if (!systemUnzipAvailable()) {
      unzipUtf8CharsetProbe = false;
    } else {
      try {
        const help = spawnSync('unzip', ['-hh'], { encoding: 'utf8' });
        const text = `${help.stdout ?? ''}\n${help.stderr ?? ''}`;
        unzipUtf8CharsetProbe = /(?:^|\s)-O\s+CHARSET/i.test(text);
      } catch {
        unzipUtf8CharsetProbe = false;
      }
    }
  }

  return unzipUtf8CharsetProbe;
}

function unzipExtractArgs(archive: string, destDir: string): string[] {
  const args = ['-o', '-qq'];
  if (unzipSupportsUtf8Charset()) {
    // -O = DOS/Windows/OEM names (Takeout); -I = UNIX names. Both UTF-8 so
    // bit-11-clear archives keep the bytes Google actually wrote.
    args.push('-O', 'UTF-8', '-I', 'UTF-8');
  }

  args.push(archive, '-d', destDir);

  return args;
}

let dittoProbe: boolean | undefined;

/** Whether `ditto` can be invoked — true on macOS, false essentially everywhere else. */
export function dittoAvailable(): boolean {
  if (dittoProbe === undefined) {
    try {
      // `ditto` has no --version; it exits 1 on a bare invocation and 64 on a
      // usage error. Either proves the binary resolved, which is all we ask.
      dittoProbe = spawnSync('ditto', [], { stdio: 'ignore' }).error === undefined;
    } catch {
      dittoProbe = false;
    }
  }

  return dittoProbe;
}

/** True if SOME extractor is available, so a caller can fail early with a clear message. */
export function systemExtractAvailable(): boolean {
  return systemUnzipAvailable() || dittoAvailable();
}

let politeProbe: string[] | undefined;

/**
 * `nice`/`ionice` prefix for the extraction children, so a 350GB Takeout
 * inflating for an hour yields CPU and disk to its neighbours instead of
 * competing head-on: a sibling run's recognition is thousands of tiny reads,
 * and every one of them queuing behind the big extract is how a 200ms
 * recognition was measured taking six minutes. `ionice -c3` (idle class) only
 * exists on Linux; each half is probed once and used only where it works, so
 * macOS still gets `nice` and a system with neither runs the extractor bare.
 */
function politePrefix(): string[] {
  if (politeProbe === undefined) {
    politeProbe = [];
    for (const candidate of [
      ['nice', '-n', '10'],
      ['ionice', '-c3'],
    ]) {
      try {
        if (spawnSync(candidate[0], [...candidate.slice(1), 'true'], { stdio: 'ignore' }).status === 0) {
          politeProbe.push(...candidate);
        }
      } catch {
        /* not available — skip */
      }
    }
  }

  return politeProbe;
}

/**
 * Run one extractor to completion WITHOUT holding the event loop.
 *
 * The extraction used to be `spawnSync`, which blocks the whole Node process
 * until the child exits — and the import worker is one process running every
 * stage of every run, so each zip of a 136-part Takeout froze every
 * neighbouring run's stage (plus progress writes, queue polling and cron) for
 * the length of that zip. An async `spawn` does the same work in the same
 * child; the worker just stays alive around it.
 *
 * `status: null` covers both a spawn failure (binary vanished between probe
 * and use) and a signal-terminated child — either way "not a success", which
 * is all the callers ask.
 */
function runExtractor(cmd: string, args: string[]): Promise<{ status: number | null }> {
  const [head, ...rest] = [...politePrefix(), cmd, ...args];

  return new Promise((resolve) => {
    const child = spawn(head, rest, { stdio: 'ignore' });

    child.on('error', () => resolve({ status: null }));
    child.on('close', (code) => resolve({ status: code }));
  });
}

/**
 * Extract `archive` into `destDir`, trying `unzip` then `ditto`.
 *
 * `-o` overwrites, so a resumed extraction — or a retry after a partial `unzip`
 * left files behind — completes rather than prompting; `-qq` is silent. `unzip`
 * exits 0 (ok) or 1 (ok, with warnings such as a skipped bad entry) and both
 * count as success. `ditto -x -k` unpacks a PKZip archive; it reports success
 * only on 0.
 *
 * When BOTH refuse, the destination is checked before giving up: an archive can
 * carry a few entries nothing will take while the rest extracted fine.
 */
/** Whether anything at all landed under `destDir`. */
function extractedAnything(destDir: string): boolean {
  const walk = (dir: string): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }

    return entries.some((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : entry.isFile()));
  };

  return walk(destDir);
}

/**
 * Attach the UTF-8 name repair to a successful extraction.
 *
 * Runs on EVERY success rather than only where we expect mangling: it verifies
 * against the archive instead of predicting extractor behaviour, so it is a
 * cheap no-op wherever the names already landed correctly (macOS `ditto`,
 * Fedora `unzip -O`) and there is no environment sniffing to keep true. The
 * repair never fails the extraction — a raised error here would throw away a
 * tree that is already on disk.
 */
function withNameRepair(
  result: SystemExtractResult,
  archive: string,
  destDir: string,
  options: NameRepairOptions,
): SystemExtractResult {
  let repair: NameRepairResult;
  try {
    repair = repairEntryNames(archive, destDir, options);
  } catch {
    return result;
  }

  if (repair.repaired === 0 && repair.unrepaired === 0) {
    return result;
  }

  return { ...result, nameRepair: repair };
}

export async function systemExtract(
  archive: string,
  destDir: string,
  options: SystemExtractOptions = {},
): Promise<SystemExtractResult> {
  const repair: NameRepairOptions = { sweep: options.exclusiveDest ?? false };
  let detail = '';

  if (systemUnzipAvailable()) {
    const r = await runExtractor('unzip', unzipExtractArgs(archive, destDir));

    if (r.status === 0 || r.status === 1) {
      return withNameRepair({ ok: true, tool: 'unzip', detail: '' }, archive, destDir, repair);
    }

    detail =
      r.status === 50
        ? `unzip exit 50 — reported as "disk full", which on macOS is usually a non-ASCII entry name it cannot write`
        : `unzip exit ${r.status}`;
  } else {
    detail = `system 'unzip' is unavailable`;
  }

  if (dittoAvailable()) {
    const d = await runExtractor('ditto', ['-x', '-k', archive, destDir]);

    if (d.status === 0) {
      return withNameRepair({ ok: true, tool: 'ditto', detail: '' }, archive, destDir, repair);
    }

    detail += `; ditto exit ${d.status}`;
  }

  // Both refused — but between them they may have written most of the archive.
  // Measured on a real 3.3GB Takeout: unzip exited 50 and ditto exited 1 on two
  // bad entries, having already extracted 2.8GB across 1,087 files. Discarding
  // that is a worse answer than importing it and saying what was missed.
  if (extractedAnything(destDir)) {
    return withNameRepair({ ok: true, tool: null, partial: true, detail }, archive, destDir, repair);
  }

  return { ok: false, tool: null, detail };
}

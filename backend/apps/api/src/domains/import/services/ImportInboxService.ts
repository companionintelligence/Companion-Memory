import { Dirent } from 'node:fs';
import { chmod, lstat, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

import { BadRequestException, Injectable, type OnModuleInit } from '@nestjs/common';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { UserService } from '@ci/domains/user';

import { allDataSources, dataSourcesRecognize, type DirEntry } from '../datasources/registry';
import type { ImportRunSource } from '../entities/ImportRunEntity';
import {
  inboxRoot,
  realUserInboxDir,
  resolveWithinUserInbox,
  userInboxDir,
  userInboxDisplayDir,
} from '../sources/importRoots';
import { declaredSourcesForInboxUnit, serviceInboxFolders } from '../sources/inboxFolders';

import { ImportRunService } from './ImportRunService';
import { StagedSourceService } from './StagedSourceService';

/**
 * How deep the has-any-file probe looks inside a top-level folder. A folder
 * whose only files sit deeper than this is treated as empty and not offered —
 * the probe exists to hide empty drop folders, not to catalogue archives.
 */
const FILE_PROBE_DEPTH = 4;

/** Walk ceilings. Exceeding one sets `truncated`, never errors. */
const MAX_ENTRIES = 20_000;
const MAX_UNITS = 500;

/**
 * Per-call ceiling for the has-any-file probe, deliberately SEPARATE from the
 * walk's global budget: probing one 350GB archive must not eat the entry
 * budget that decides whether the units after it get listed at all — that
 * exact bug had every scan of a big inbox reporting `truncated` and silently
 * dropping the units that sorted after the archive. Exhausting it degrades
 * only its own answer (an offered folder), and flags nothing.
 */
const PROBE_ENTRY_BUDGET = 5_000;

/**
 * Time ceilings on the scan's RECOGNITION work, same contract as the walk
 * ceilings: exceeding one sets `truncated`, never errors or hangs.
 *
 * Recognition is the scan's only unbounded cost. Each call fans out to every
 * registered recognizer over a bounded descent, but many recognizers read
 * files SYNCHRONOUSLY — fine in the CLI they were ported from, event-loop
 * blocking here — and the inbox may hold a half-copied 350GB Takeout on a
 * disk already saturated by that copy. Without a deadline the scan (and,
 * because of the sync reads, every other request on the process) sat pending
 * for however long the whole tree took to read.
 *
 * Mutable and exported so tests can shrink the budget instead of hanging for
 * ten real seconds.
 */
export const SCAN_RECOGNITION_TIMING = {
  /** Wall-clock the whole scan may spend recognizing, across all units. */
  budgetMs: 10_000,
  /** Ceiling for any single recognize() call within that budget. */
  perCallMs: 3_000,
};

/**
 * The recognition cache's shape. Recognition over a large tree costs real
 * seconds even fully async — thousands of descend nodes, every registered
 * recognizer at each — and the Inbox tab re-scans on every visit. An answer
 * for an UNCHANGED path (same mtime + size) is still the answer, so repeat
 * scans reuse it, and a first scan that ran out of budget continues where it
 * left off next time instead of re-paying for what it already learned.
 *
 * Two TTLs, because staleness only threatens one class of verdict. A file's
 * stamp (mtime + size) tracks its content, and a POSITIVE directory verdict
 * only gets stronger as more of the archive lands — both safely long-lived.
 * But a directory's mtime moves only when its DIRECT children change: files
 * landing deep inside a Takeout leave the root stamp untouched, so an EMPTY
 * directory verdict ("nothing recognizable here yet") cached mid-copy must
 * age out quickly once the copy completes.
 */
export const SCAN_RECOGNITION_CACHE = {
  ttlMs: 10 * 60_000,
  emptyDirTtlMs: 60_000,
  maxEntries: 10_000,
};

/**
 * Sizing ceiling, per unit — deliberately NOT shared with the walk's
 * MAX_ENTRIES budget.
 *
 * `aggregate` recurses through a recognized unit purely to report sizeBytes /
 * fileCount. Charging that to the discovery budget means one big export starves
 * discovery of everything after it: a 79,623-file Google Takeout exhausts 20,000
 * entries on its own, and the walk then returns on its next iteration, so every
 * top-level source sorting after `google-takeout` — instagram, linkedin, reddit,
 * spotify, twitter, uber, whatsapp… — never becomes a unit at all. The scan
 * reports `truncated: true`, but a caller reading a 28-unit list has no way to
 * tell WHICH sources it lost, and importing that list reads as "imported
 * everything" (the same failure MAX_INBOX_BATCH_UNITS refuses to make).
 *
 * So sizing is budgeted per unit and its exhaustion is reported on the unit
 * (`sizeApproximate`) rather than by silently ending discovery.
 */
const MAX_UNIT_SIZING_ENTRIES = 50_000;

/**
 * The batch ceiling. A request over it is REJECTED, not truncated — silently
 * importing 100 of 130 units reads as "imported everything" to the person who
 * asked for everything.
 */
export const MAX_INBOX_BATCH_UNITS = 100;

/** Desktop litter that is never an export. */
const JUNK_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/** The walk's running tallies and ceilings, threaded through every level. */
interface WalkState {
  /** Top-level entries walked — the global ceiling's counter. */
  entries: number;
  symlinks: number;
  truncated: boolean;
  recognitionPartial: boolean;
  /** Epoch ms after which no further recognition is attempted. */
  recognitionDeadline: number;
}

export interface InboxUnitRecognition {
  dataSource: string;
  title: string;
  confidence: number;
}

/** One importable thing the scan found — a file, or a whole recognized directory. */
export interface InboxUnit {
  /** POSIX path relative to the inbox root: the handle a client sends back. */
  path: string;
  kind: 'file' | 'directory';
  sizeBytes: number;
  fileCount: number;
  recognized: InboxUnitRecognition[];
  /**
   * Display titles of the importers this unit's LOCATION declares — what a
   * drop in this service folder will import as, whatever recognition says.
   * The chips' fallback: most drops are archives, and a recognizer cannot see
   * inside a zip, so a `spotify/…zip` unit recognizes as nothing while its
   * import is nonetheless spoken for. Empty at the inbox root and in folders
   * matching no service, where the location says nothing.
   */
  declared: string[];
  /**
   * An unfinished run of THIS user's already consuming the unit, if any.
   * Null when the claim belongs to someone else — see {@link claimed}, which
   * is the field to test before offering a unit for import.
   */
  activeRunId: string | null;
  /**
   * Some run holds this unit, whoever started it.
   *
   * The scan is scoped to the caller's own subtree, so in the current layout
   * every claim here should be the caller's — but the claim registry, not the
   * folder layout, is the truth about who holds the bytes (the unpack
   * acquires by RENAME; a claimed unit's bytes may already be gone), so the
   * check stays cross-user. A foreign run id is deliberately not exposed;
   * this boolean is all a client needs to know the unit is unavailable.
   */
  claimed: boolean;
  /**
   * True when sizing stopped at MAX_UNIT_SIZING_ENTRIES, so `sizeBytes` and
   * `fileCount` are lower bounds. The unit is still fully importable — only the
   * preview numbers are partial.
   */
  sizeApproximate: boolean;
}

export interface InboxScan {
  available: boolean;
  reason?: string;
  /** The caller's inbox subtree as the API itself sees it (`CI_IMPORT_INBOX_DIR/<user>`). */
  inboxDir: string;
  /**
   * The same folder as a PERSON reaches it: the host-side spelling of the
   * bind mount when the operator set `CI_IMPORT_INBOX_HOST_DIR`, otherwise
   * `inboxDir`. This is what to show someone who is about to drop files in;
   * `inboxDir` is a path inside the container and means nothing on a desktop.
   * Display only — nothing accepts it back.
   */
  displayDir: string;
  units: InboxUnit[];
  skippedSymlinks: number;
  /** UNITS are missing: a walk ceiling dropped top-level entries. */
  truncated: boolean;
  /**
   * Only CHIPS are missing: recognition ran out of time for some units, so
   * they are listed with fewer (or no) recognitions than a rescan would show.
   * Deliberately not `truncated` — nothing importable is hidden.
   */
  recognitionPartial: boolean;
}

export interface InboxUnitResult {
  unit: string;
  runId?: string;
  label?: string;
  error?: string;
}

export interface InboxBatchResult {
  results: InboxUnitResult[];
}

export interface StartInboxBatchInput {
  /** Relative paths from a scan. Omitted means every unit the scan yields. */
  units?: readonly string[];
  label?: string | null;
  source: ImportRunSource;
}

/**
 * The inbox surface: what is waiting in the folder, and turning it into runs.
 *
 * Two properties carry the safety story. Every path leaving or entering this
 * service resolves through `resolveWithinUserInbox` — the consume-side
 * resolver, scoped to the CALLER's subtree of the shared mount — so nothing
 * under CI_IMPORT_ROOTS and nothing in another account's folder can reach the
 * claim, the move, or the delete. And the walk NEVER follows symlinks: a
 * consume-and-delete folder must not reach through a link to bytes it does
 * not own, so links are counted and skipped rather than adjudicated.
 */
@Injectable()
export class ImportInboxService implements OnModuleInit {
  /** Recognition verdicts by absolute path — see {@link SCAN_RECOGNITION_CACHE}. */
  private readonly recognitionCache = new Map<
    string,
    { stamp: string; expiresAt: number; value: InboxUnitRecognition[] }
  >();

  constructor(
    private readonly runs: ImportRunService,
    private readonly stagedSources: StagedSourceService,
    private readonly users: UserService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ImportInboxService.name);
  }

  /**
   * Boot-time folder creation, because the folders are DROP TARGETS: the
   * workflow they exist for is moving archives into them before ever opening
   * the app, so tying their creation to the first scan (someone opening the
   * Inbox panel) is backwards. Every existing account gets its subtree here;
   * accounts created later get theirs from the user-created event (see
   * InboxProvisionListener). Best-effort — an appliance whose inbox mount is
   * read-only or absent must still boot; the scan reports why when asked.
   */
  async onModuleInit(): Promise<void> {
    try {
      for (const user of await this.users.findAll()) {
        await this.ensureInboxTree(userInboxDir(user.email));
      }
    } catch (err: unknown) {
      this.logger.warn('Could not prepare the import inbox at boot', {
        error: (err as Error).message,
      });
    }
  }

  /**
   * Create one user's inbox subtree — the onboarding entry point, so a fresh
   * account has its drop folders without waiting for a restart or a scan.
   */
  async provisionUserInbox(email: string): Promise<void> {
    await this.ensureInboxTree(userInboxDir(email));
  }

  /**
   * The caller's slice of the shared inbox mount. Everything the scan and the
   * batch do happens under this directory and never outside it — who an
   * import is FOR is whoever's folder the archive sits in, not whoever
   * happens to press the button first.
   */
  private async userDir(
    ctx: UserServiceContext,
  ): Promise<{ dir: string; displayDir: string; email: string }> {
    const user = await this.users.findById({ userId: ctx.userId }, ctx.userId);

    if (user == null) {
      throw new BadRequestException('No such user');
    }

    return { dir: userInboxDir(user.email), displayDir: userInboxDisplayDir(user.email), email: user.email };
  }

  /**
   * List the inbox's units: its TOP-LEVEL entries, nothing deeper.
   *
   * A root file is one unit. A root folder holding at least one file within
   * {@link FILE_PROBE_DEPTH} levels is one unit, whole subtree; a folder with
   * nothing that shallow (the empty drop folders, above all) is not offered.
   * The old algebra — recognition deciding unit vs organization, recursion
   * into the latter — surfaced `discord/discord-package.zip` as a bare file
   * while hiding the folder the user actually dropped it in, and made unit
   * boundaries hostage to recognition quality. What you put at the top level
   * is what you meant to import. Deterministic (lexicographic) so two scans
   * of an unchanged inbox agree.
   */
  async scan(ctx: UserServiceContext): Promise<InboxScan> {
    const { dir: inboxDir, displayDir, email } = await this.userDir(ctx);

    try {
      // Re-ensured on every scan, not only at boot: a whole-folder unit
      // (`amazon/` recognized as one archive) is consumed by its run — moved
      // out and deleted — and the folder must come back for the next export.
      await this.ensureInboxTree(inboxDir);

      await readdir(inboxDir);
    } catch (err: unknown) {
      return {
        available: false,
        reason: `The inbox directory is not readable: ${(err as Error).message}`,
        inboxDir,
        displayDir,
        units: [],
        skippedSymlinks: 0,
        truncated: false,
        recognitionPartial: false,
      };
    }

    const state: WalkState = {
      entries: 0,
      symlinks: 0,
      truncated: false,
      recognitionPartial: false,
      recognitionDeadline: Date.now() + SCAN_RECOGNITION_TIMING.budgetMs,
    };
    const units: InboxUnit[] = [];

    await this.walk(inboxDir, state, units);

    // Every live claim on these paths, not just this user's. Scoping the walk
    // to the caller's subtree means another account SHOULD never hold one of
    // these paths, but the claim registry is the truth about the bytes —
    // belt-and-braces beats assuming the folder layout was always this shape.
    //
    // Keyed off the RESOLVED root for the same reason the declaration below
    // is: what a claim RECORDS is the path `resolveWithinUserInbox` handed
    // back, which is a realpath. Asked in the configured spelling, a symlinked
    // inbox matches no stored row at all — so every claimed unit reads as
    // free, the scan offers bytes another run already holds, and starting them
    // dies on the staged-source unique violation instead.
    const claimRoot = await realUserInboxDir(email);
    const active = await this.stagedSources.findActiveByPaths(
      units.map((unit) => path.join(claimRoot, unit.path)),
    );
    const claimedBy = new Map(active.map((row) => [row.sourcePath, row]));

    for (const unit of units) {
      const claim = claimedBy.get(path.join(claimRoot, unit.path));

      unit.claimed = claim != null;
      // The run id only when it is theirs to look at. A client uses it to open
      // the run; another user's would 404 there and disclose that the run
      // exists on the way.
      unit.activeRunId = claim != null && claim.userId === ctx.userId ? claim.runId : null;
    }

    return {
      available: true,
      inboxDir,
      displayDir,
      units,
      skippedSymlinks: state.symlinks,
      truncated: state.truncated,
      recognitionPartial: state.recognitionPartial,
    };
  }

  /**
   * Start one run per unit. Per-unit isolation is the contract: a unit that
   * fails to start records its error in the results and its siblings proceed,
   * because "one bad archive aborted the other forty" is the batch equivalent
   * of failing a whole import over one unreadable file.
   */
  async startBatch(ctx: UserServiceContext, input: StartInboxBatchInput): Promise<InboxBatchResult> {
    let requested: readonly string[];

    if (input.units == null) {
      const scanned = await this.scan(ctx);

      if (!scanned.available) {
        throw new BadRequestException(scanned.reason ?? 'The inbox is not available');
      }

      requested = scanned.units.filter((unit) => !unit.claimed).map((unit) => unit.path);
    } else {
      requested = input.units;
    }

    if (requested.length > MAX_INBOX_BATCH_UNITS) {
      throw new BadRequestException(
        `A batch starts at most ${MAX_INBOX_BATCH_UNITS} imports; this one names ${requested.length}. ` +
          `Import a subset, then the rest.`,
      );
    }

    const { dir: inboxDir, email } = await this.userDir(ctx);
    // Resolved once per batch, not per unit. Falls back to the configured path
    // when the directory does not exist yet — every unit then fails its own
    // resolve anyway, and a throw here would take the whole batch with it.
    const inboxRealDir = await realUserInboxDir(email);
    const resultByUnit = new Map<string, InboxUnitResult>();

    // Two passes so the runs can start SMALLEST FIRST. The stage queue is
    // finite-slot; in request (alphabetical) order one 350GB archive that
    // sorts early holds its slot while twenty near-instant units wait behind
    // it. Size-ascending, every quick win lands before the monster starts.
    const prepared: Array<{
      unit: string;
      resolved: string;
      kind: 'file' | 'directory';
      sizeBytes: number;
    }> = [];

    for (const unit of requested) {
      try {
        const resolved = await resolveWithinUserInbox(path.join(inboxDir, unit), email);
        const info = await lstat(resolved);

        if (info.isSymbolicLink()) {
          throw new Error('Symbolic links are not importable');
        }

        const kind = info.isDirectory() ? 'directory' : 'file';
        const sizeBytes =
          kind === 'file'
            ? info.size
            : (await this.aggregate(resolved, { entries: 0, exhausted: false })).sizeBytes;

        prepared.push({ unit, resolved, kind, sizeBytes });
      } catch (err: unknown) {
        resultByUnit.set(unit, { unit, error: (err as Error).message });
      }
    }

    prepared.sort((a, b) => a.sizeBytes - b.sizeBytes || a.unit.localeCompare(b.unit));

    for (const { unit, resolved, kind, sizeBytes } of prepared) {
      try {
        // A unit inside a service folder declares that service's importers,
        // exactly as the wizard card would have — the usage roll-up then
        // credits declared ∩ detected instead of dominant-only. Computed from
        // the RESOLVED path so the declaration matches where the bytes really
        // sit, not how the caller spelled the unit.
        // Both sides of this `relative` must be realpaths. `resolved` already is
        // — resolveWithinRoots resolves symlinks BEFORE its containment check,
        // deliberately — while `inboxDir` is composed from config. When the
        // configured inbox traverses a symlink the two disagree and
        // `path.relative` returns a `../../…` escape, whose first segment is
        // never a service folder, so EVERY unit silently declared nothing.
        //
        // Not hypothetical and not test-only: macOS puts /tmp and /var behind
        // symlinks (/private/…), and any bind-mounted or symlinked appliance
        // data dir does the same. The failure is invisible — the run starts
        // fine and only the usage roll-up quietly falls back to dominant-only.
        const declared = declaredSourcesForInboxUnit(
          path.relative(inboxRealDir, resolved).split(path.sep).join('/'),
        );

        const { run } = await this.runs.startRun(ctx, {
          localSource: { path: resolved, kind, sizeBytes },
          label: input.label ?? null,
          source: input.source,
          declaredSources: declared ?? undefined,
        });

        resultByUnit.set(unit, { unit, runId: run.id, label: run.label ?? undefined });
      } catch (err: unknown) {
        resultByUnit.set(unit, { unit, error: (err as Error).message });
      }
    }

    // The RESPONSE keeps the caller's order — only the enqueue is reordered;
    // a client that lined its rows up with its request must not see them
    // shuffled by size.
    const results = requested.map(
      (unit) => resultByUnit.get(unit) ?? { unit, error: 'The unit was not processed' },
    );

    this.logger.log('Started inbox batch', {
      userId: ctx.userId,
      requested: requested.length,
      started: results.filter((result) => result.runId != null).length,
    });

    return { results };
  }

  /**
   * One user's inbox subtree — the shared root, the user's own folder, and
   * the service drop folders inside it — created where missing.
   *
   * Freshly-created directories are made world-writable with the sticky bit —
   * /tmp's answer to this exact problem. The api container runs as root, so
   * without this each folder lands on the host root-owned 755 and the desktop
   * user cannot move archives in, which is the entire point of the folder.
   * Safe because the inbox only ever holds COPIES the importer consumes; the
   * sticky bit keeps one local user from removing another's. Only on
   * creation: an operator who tightened the mode afterwards stays tightened.
   * The mkdir mode argument is masked by umask, hence the explicit chmod.
   */
  private async ensureInboxTree(userDir: string): Promise<void> {
    await this.ensureDir(inboxRoot());
    await this.ensureDir(userDir);

    // The per-service drop folders. Best-effort past this point: a read-only
    // mount keeps working as a plain inbox without them.
    await this.ensureServiceFolders(userDir);
  }

  /** Create one directory if missing, with the 1777 treatment on creation only. */
  private async ensureDir(dir: string): Promise<void> {
    const existed = await lstat(dir).then(
      () => true,
      () => false,
    );

    if (!existed) {
      await mkdir(dir, { recursive: true });
      await chmod(dir, 0o1777).catch(() => undefined);
    }
  }

  /**
   * Create any missing service drop folders — top-level only, per
   * {@link serviceInboxFolders}.
   *
   * Never `recursive`, so ONLY a directory this call actually made gets the
   * inbox's own 1777 treatment — the api container runs as root, and without
   * the chmod a freshly-created `amazon/` would be root-owned 755 and the
   * desktop user could not drop anything into it. A folder that already
   * exists is left exactly as the operator has it, tightened modes included.
   */
  private async ensureServiceFolders(inboxDir: string): Promise<void> {
    for (const folder of serviceInboxFolders()) {
      const target = path.join(inboxDir, folder);

      try {
        await mkdir(target);
        await chmod(target, 0o1777).catch(() => undefined);
      } catch {
        // Exists already, or the mount will not have it — neither is this
        // scan's problem.
      }
    }
  }

  private async walk(inboxDir: string, state: WalkState, units: InboxUnit[]): Promise<void> {
    let entries: Dirent[];

    try {
      entries = await readdir(inboxDir, { withFileTypes: true });
    } catch {
      // Vanished mid-scan (a batch consumed it) is not an error; the next
      // scan will not see it either.
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (units.length >= MAX_UNITS || state.entries >= MAX_ENTRIES) {
        state.truncated = true;

        return;
      }

      state.entries += 1;

      if (entry.isSymbolicLink()) {
        state.symlinks += 1;
        continue;
      }

      if (JUNK_NAMES.has(entry.name) || entry.name.startsWith('.')) {
        continue;
      }

      const fullPath = path.join(inboxDir, entry.name);

      if (entry.isFile()) {
        const info = await lstat(fullPath);

        units.push({
          path: entry.name,
          kind: 'file',
          sizeBytes: info.size,
          fileCount: 1,
          // Recognition is purely advisory — a file that could not be
          // recognized in time is still a unit; hiding bytes that exist
          // reads as "your archive vanished".
          recognized: (await this.recognize(fullPath, entry.name, state)) ?? [],
          declared: this.declaredTitles(entry.name),
          activeRunId: null,
          claimed: false,
          sizeApproximate: false,
        });
        continue;
      }

      if (!entry.isDirectory()) {
        continue;
      }

      if (!(await this.hasFileWithin(fullPath, FILE_PROBE_DEPTH, { entries: 0 }))) {
        continue;
      }

      // A fresh budget per unit: sizing a huge export must not consume the
      // walk's discovery budget and strand its siblings. See
      // MAX_UNIT_SIZING_ENTRIES.
      const budget = { entries: 0, exhausted: false };
      const aggregate = await this.aggregate(fullPath, budget);

      units.push({
        path: entry.name,
        kind: 'directory',
        sizeBytes: aggregate.sizeBytes,
        fileCount: aggregate.fileCount,
        recognized: (await this.recognize(fullPath, entry.name, state)) ?? [],
        declared: this.declaredTitles(entry.name),
        activeRunId: null,
        claimed: false,
        sizeApproximate: budget.exhausted,
      });
    }
  }

  /**
   * Does the folder hold at least one regular file, this deep at most?
   *
   * The cheap gate that keeps empty drop folders (and a user's empty
   * scaffolding) out of the listing without any recognition at all. Early
   * exit on the first file; never follows symlinks. An unreadable subtree
   * counts as empty — fail closed, same as everywhere else on this surface.
   */
  private async hasFileWithin(dir: string, depth: number, budget: { entries: number }): Promise<boolean> {
    if (depth <= 0) {
      return false;
    }

    let entries: Dirent[];

    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }

    for (const entry of entries) {
      if (budget.entries >= PROBE_ENTRY_BUDGET) {
        // Too big to finish probing is the opposite of empty: offer it.
        return true;
      }

      budget.entries += 1;

      if (entry.isSymbolicLink() || entry.name.startsWith('.') || JUNK_NAMES.has(entry.name)) {
        continue;
      }

      if (entry.isFile()) {
        return true;
      }

      if (entry.isDirectory() && (await this.hasFileWithin(path.join(dir, entry.name), depth - 1, budget))) {
        return true;
      }
    }

    return false;
  }

  /**
   * What the importers make of one path, inside the scan's time budget.
   *
   * Returns null — "could not answer in time" — when the scan's budget is
   * spent or this one call outlives its own ceiling, and marks the scan
   * truncated so the client knows chips may be missing. Recognition is purely
   * advisory now: units are decided by location, and the parse stage
   * re-recognizes properly once a run owns the bytes.
   *
   * Inside a service drop folder, only THAT service's importers are asked —
   * `spotify/` can only hold what the Spotify importer reads, and the
   * all-importers fan-out is the scan's dominant cost — and the narrow set
   * affords a full-width descent. The inbox root and folders matching no
   * service still get every importer, over a thinner slice per directory:
   * there the location says nothing about the bytes.
   */
  private async recognize(
    target: string,
    relative: string,
    state: WalkState,
  ): Promise<InboxUnitRecognition[] | null> {
    const declared = declaredSourcesForInboxUnit(relative);
    const only = declared == null ? undefined : new Set(declared);

    // The stamp identifies the path's current content cheaply. Unstattable
    // paths (vanished mid-scan) skip the cache and fail closed below.
    const info = await lstat(target).catch(() => null);
    const stamp = info == null ? null : `${info.mtimeMs}:${info.size}`;

    if (stamp != null) {
      const cached = this.recognitionCache.get(target);

      if (cached != null && cached.stamp === stamp && cached.expiresAt > Date.now()) {
        return cached.value;
      }
    }

    const remaining = state.recognitionDeadline - Date.now();

    if (remaining <= 0) {
      state.recognitionPartial = true;

      return null;
    }

    const entry: DirEntry = {
      filename: path.basename(target),
      fullPath: target,
      fsRoot: target,
    };

    let timer: NodeJS.Timeout | undefined;

    try {
      const matches = await Promise.race([
        dataSourcesRecognize(
          undefined,
          entry,
          {},
          {
            descend: true,
            maxDepth: FILE_PROBE_DEPTH,
            maxEntriesPerDir: only == null ? 50 : 200,
            only,
          },
        ),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), Math.min(remaining, SCAN_RECOGNITION_TIMING.perCallMs));
          timer.unref?.();
        }),
      ]);

      if (matches == null) {
        // A timeout is NOT an answer — never cached, so the next scan tries
        // again with a fresh budget.
        state.recognitionPartial = true;
        this.logger.debug('Recognition timed out during inbox scan', {
          target: path.basename(target),
        });

        return null;
      }

      // One chip per data source, at its best confidence. The registry
      // deliberately keeps sibling matches (two files independently claimed
      // by one importer are two real matches — the parse stage needs both),
      // but as CHIPS a folder of thirty mboxes must read "Email", not
      // "Email ×30".
      const seen = new Set<string>();
      const value = matches
        .sort((a, b) => b.recognition.confidence - a.recognition.confidence)
        .filter((match) => {
          if (seen.has(match.data_source.name)) {
            return false;
          }

          seen.add(match.data_source.name);

          return true;
        })
        .map((match) => ({
          dataSource: match.data_source.name,
          title: match.data_source.title,
          confidence: match.recognition.confidence,
        }));

      if (stamp != null) {
        this.remember(target, stamp, value, info?.isDirectory() === true);
      }

      return value;
    } catch (err: unknown) {
      // Recognition is advisory on this surface; a parser that chokes on a
      // half-written file must not hide the unit from the listing.
      this.logger.debug('Recognition failed during inbox scan', {
        target: path.basename(target),
        error: (err as Error).message,
      });

      return [];
    } finally {
      if (timer != null) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Display titles for the importers a unit's location declares, importer
   * name standing in when the registry has no entry (a stub, or a test
   * without the registry loaded).
   */
  private declaredTitles(unitRelPath: string): string[] {
    const declared = declaredSourcesForInboxUnit(unitRelPath);

    if (declared == null) {
      return [];
    }

    const registered = allDataSources();

    return declared.map((name) => registered.find((source) => source.name === name)?.title ?? name);
  }

  /**
   * Store one recognition verdict, evicting oldest-inserted entries past the
   * cap — Map iteration order is insertion order, and a scan re-inserts what
   * it re-verifies, so the front of the map is the stalest.
   */
  private remember(target: string, stamp: string, value: InboxUnitRecognition[], isDirectory: boolean): void {
    const ttl =
      isDirectory && value.length === 0 ? SCAN_RECOGNITION_CACHE.emptyDirTtlMs : SCAN_RECOGNITION_CACHE.ttlMs;

    this.recognitionCache.delete(target);
    this.recognitionCache.set(target, {
      stamp,
      expiresAt: Date.now() + ttl,
      value,
    });

    while (this.recognitionCache.size > SCAN_RECOGNITION_CACHE.maxEntries) {
      const oldest = this.recognitionCache.keys().next().value;

      if (oldest == null) {
        break;
      }

      this.recognitionCache.delete(oldest);
    }
  }

  /**
   * Recursive size/count for ONE directory unit, bounded by its own entry
   * budget. Advisory: a unit bigger than the budget reports floor values —
   * never fewer units for the rest of the scan.
   */
  private async aggregate(
    dir: string,
    budget: { entries: number; exhausted: boolean },
  ): Promise<{ sizeBytes: number; fileCount: number }> {
    let sizeBytes = 0;
    let fileCount = 0;

    let entries: Dirent[];

    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return { sizeBytes, fileCount };
    }

    for (const entry of entries) {
      if (budget.entries >= MAX_UNIT_SIZING_ENTRIES) {
        budget.exhausted = true;
        break;
      }

      budget.entries += 1;

      if (entry.isSymbolicLink()) {
        continue;
      }

      const fullPath = path.join(dir, entry.name);

      if (entry.isFile()) {
        try {
          sizeBytes += (await lstat(fullPath)).size;
          fileCount += 1;
        } catch {
          // Vanished mid-walk; the aggregate is advisory.
        }
      } else if (entry.isDirectory()) {
        const nested = await this.aggregate(fullPath, budget);

        sizeBytes += nested.sizeBytes;
        fileCount += nested.fileCount;
      }
    }

    return { sizeBytes, fileCount };
  }
}

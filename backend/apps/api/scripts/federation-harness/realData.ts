/**
 * Loading REAL data into the two boxes, bounded and read-only.
 *
 * ═══ THE RULE THAT OUTRANKS EVERY OTHER CONSIDERATION HERE ═══
 *
 * The owner's archive at `/Users/liam/devel/liam-test-data-export` is 308GB of
 * irreplaceable personal history, and CI-Server's own tooling has already
 * destroyed part of one: `scripts/import-local-sources.sh` opens with
 *
 *     THE INBOX CONSUMES WHAT IT IMPORTS, by rename. Point it at
 *     ~/Library/Messages and your iMessage history moves into a scratch dir.
 *
 * A sibling repo's importer did exactly that to 2.8GB of this archive by
 * reclaiming its source directory. So:
 *
 *   - the archive is NEVER named as an import target, only as a COPY SOURCE;
 *   - every file is copied into `.federation-harness/staging/` first, and the
 *     importer only ever sees the copy;
 *   - box A boots with `CI_IMPORT_ROOTS` pinned to that staging directory, so
 *     the appliance is not merely asked politely to stay out of the archive —
 *     it cannot resolve a path into it at all (`importRoots.ts` refuses);
 *   - `assertOutsideArchive` re-checks the resolved staging path on every run,
 *     because a symlink or a relative `--source` is exactly how "outside" stops
 *     being true without anyone noticing.
 *
 * Nothing in this file deletes, moves, renames, or writes inside the archive.
 * The only syscalls it makes against that tree are `readdir`, `stat` and
 * `copyFile`.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { REPO_ROOT, STATE_DIR, type HarnessState } from './topology';

/** The owner's real archive. READ-ONLY. Never an import target. */
export const ARCHIVE_ROOT = process.env.FED_ARCHIVE_ROOT ?? '/Users/liam/devel/liam-test-data-export';

/**
 * A second person's memory, for box B.
 *
 * `CI-Test-Data-Person-1-John-Smith` is the better of the two candidates in the
 * workspace: it ships 16 CSVs of one coherent person (calendar, notes, emails,
 * purchases, journal, location…), 101 calendar rows among them.
 * `CI-Demo-Companions-John-Smith` is ten markdown COMPANION PERSONAS — assistant,
 * finance, travel — not a dataset, so there is nothing in it to import.
 */
export const PERSON_B_ROOT =
  process.env.FED_PERSON_B_ROOT ?? '/Users/liam/devel/ci/CI-Test-Data-Person-1-John-Smith';

const STAGING = path.join(STATE_DIR, 'staging');

/**
 * Refuse to treat any path inside the archive as a destination.
 *
 * The directory is CREATED first and then `realpath`'d, in that order. Resolving
 * a path that does not exist yet throws ENOENT, and the first version of this
 * did exactly that — the guard failed before it could guard anything, which is
 * the worst way for a safety check to be wrong: it looks like it ran.
 * `realpath` after `mkdir` is also the only form that catches the case that
 * matters, a staging directory someone has symlinked back into the archive.
 */
function assertOutsideArchive(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });

  const resolvedTarget = fs.realpathSync.native(dir);
  const resolvedArchive = fs.existsSync(ARCHIVE_ROOT) ? fs.realpathSync.native(ARCHIVE_ROOT) : ARCHIVE_ROOT;

  if (resolvedTarget === resolvedArchive || resolvedTarget.startsWith(`${resolvedArchive}${path.sep}`)) {
    throw new Error(
      `refusing to write inside the owner's archive (${resolvedTarget}). The archive is read-only, always.`,
    );
  }
}

/** Second bound, independent of the file count: total bytes copied. */
const MAX_STAGED_BYTES = Number(process.env.FED_MAX_STAGED_BYTES ?? 512 * 1024 * 1024);

/**
 * Copy at most `limit` regular files out of one archive source into the staging
 * tree, preserving their relative layout.
 *
 * RECURSIVE, BUT DOUBLY BOUNDED. The first version walked one flat level, on the
 * theory that a flat listing makes the bound legible — and then found nothing at
 * all, because the archive's sources are directories of directories
 * (`inbox/apple/{calendar,contacts,health,messages,photos}/…`) and the importer
 * recognizes per file inside an unpacked tree. So it walks, and the bound moves
 * to where it belongs: a file COUNT (`--limit`) and a byte ceiling
 * (`FED_MAX_STAGED_BYTES`, 512MB), either of which stops the copy. Depth-first
 * in sorted order, so which files you get is deterministic rather than
 * whatever readdir felt like.
 */
function stageSource(source: string, limit: number): { staged: string; files: string[]; bytes: number } {
  const sourceDir = path.resolve(ARCHIVE_ROOT, 'inbox', source);

  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    throw new Error(`no such archive source: ${sourceDir}`);
  }

  const staged = path.join(STAGING, source);
  assertOutsideArchive(staged);

  const files: string[] = [];
  let bytes = 0;

  const walk = (from: string, to: string): void => {
    if (files.length >= limit || bytes >= MAX_STAGED_BYTES) {
      return;
    }

    for (const entry of fs
      .readdirSync(from, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= limit || bytes >= MAX_STAGED_BYTES) {
        return;
      }

      // Dotfiles are skipped, `.DS_Store` chief among them, and symlinks are
      // skipped outright: following one is how a bounded copy of `inbox/apple`
      // becomes an unbounded copy of somewhere else.
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) {
        continue;
      }

      const childFrom = path.join(from, entry.name);
      const childTo = path.join(to, entry.name);

      if (entry.isDirectory()) {
        fs.mkdirSync(childTo, { recursive: true });
        walk(childFrom, childTo);

        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      // COPYFILE_FICLONE: an APFS clone where the filesystem supports it, a real
      // copy where it does not. Either way the original is untouched — this is a
      // read of `childFrom` and a write of `childTo`, never a rename.
      fs.copyFileSync(childFrom, childTo, fs.constants.COPYFILE_FICLONE);
      files.push(childTo);
      bytes += fs.statSync(childTo).size;
    }
  };

  walk(sourceDir, staged);

  return { staged, files, bytes };
}

/** What is available to stage, with sizes, so the owner can choose. */
function listArchiveSources(): void {
  const inbox = path.join(ARCHIVE_ROOT, 'inbox');

  if (!fs.existsSync(inbox)) {
    console.log(`\nNo archive at ${ARCHIVE_ROOT}. Set FED_ARCHIVE_ROOT to point at one.\n`);

    return;
  }

  console.log(`\nArchive sources under ${inbox} (READ-ONLY — nothing here is ever an import target):\n`);

  for (const entry of fs
    .readdirSync(inbox, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) {
      continue;
    }

    const dir = path.join(inbox, entry.name);
    const files = fs.readdirSync(dir).filter((name) => !name.startsWith('.'));
    console.log(`  ${entry.name.padEnd(20)} ${String(files.length).padStart(5)} entries`);
  }

  console.log('\n  yarn fed import-real-data --source <name> [--limit 200]\n');
}

/** Minimal RFC4180-ish CSV reader — quoted fields with embedded commas and newlines. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }

      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.trim().length > 0));
}

/**
 * Load John Smith's calendar into box B through `POST /v1/events`.
 *
 * The provenance triple is ('ci-test-data-person-1', 'calendar', '<date>-<n>'),
 * so a re-run dedups against the rows the previous one created rather than
 * doubling the calendar — the same property `make fed-seed` relies on.
 */
async function importPersonB(state: HarnessState, limit: number): Promise<void> {
  const csv = path.join(PERSON_B_ROOT, 'calendar.csv');

  if (!fs.existsSync(csv)) {
    throw new Error(`no calendar.csv at ${PERSON_B_ROOT}`);
  }

  const rows = parseCsv(fs.readFileSync(csv, 'utf8'));
  const [header, ...body] = rows;
  const column = (name: string) => header.findIndex((h) => h.trim() === name);

  const events = body.slice(0, limit).map((row, index) => {
    const date = row[column('Date')];
    const start = row[column('Start Time')] || '09:00';
    const end = row[column('End Time')] || '10:00';

    return {
      source_type: 'ci-test-data-person-1',
      source_system: 'calendar',
      source_id: `${date}-${index}`,
      kind: 'calendar.event',
      // The CSV carries no timezone. Read as UTC rather than guessing the
      // owner's — a free/busy answer that silently shifted by eight hours would
      // look like a disclosure bug rather than a parsing one.
      occurred_at: new Date(`${date}T${start}:00.000Z`).toISOString(),
      ended_at: new Date(`${date}T${end}:00.000Z`).toISOString(),
      title: row[column('Event Title')],
      description: row[column('Description')],
      payload: { location: row[column('Location')] },
    };
  });

  const response = await fetch(`http://127.0.0.1:${state.boxes.b.apiPort}/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': state.boxes.b.apiKey ?? '' },
    body: JSON.stringify({ events }),
  });

  if (!response.ok) {
    throw new Error(`box B ingest failed: ${response.status} ${await response.text()}`);
  }

  console.log(`  ✓ ${events.length} calendar event(s) from ${path.basename(PERSON_B_ROOT)} → box B`);
}

export async function importRealData(state: HarnessState, args: string[]): Promise<void> {
  const flag = (name: string): string | undefined => {
    const index = args.indexOf(`--${name}`);

    return index === -1 ? undefined : args[index + 1];
  };

  if (args.includes('--list')) {
    listArchiveSources();

    return;
  }

  // Two separate bounds, because they mean different things and sharing one
  // surprised the first caller: `--limit 2` was meant to stage two archive FILES
  // and silently cut box B's calendar to two EVENTS as well.
  const limit = Number(flag('limit') ?? 200);
  const personLimit = Number(flag('person-limit') ?? 200);

  console.log('\n▶ box B — a second person, from the workspace test-data repo');
  await importPersonB(state, personLimit);

  const source = flag('source');

  if (source == null) {
    console.log(
      "\n▶ box A — no --source given, so the owner's archive was not touched at all." +
        '\n  `yarn fed import-real-data --list` shows what is available.\n',
    );

    return;
  }

  console.log(
    `\n▶ box A — staging a bounded copy of ${source} (the archive itself is never read by the appliance)`,
  );

  const { staged, files, bytes } = stageSource(source, limit);
  console.log(`  ✓ copied ${files.length} file(s), ${(bytes / 1024 / 1024).toFixed(1)}MB → ${staged}`);

  if (files.length === 0) {
    console.log('  ! nothing to import');

    return;
  }

  // ═══ THE FILES, NAMED ONE BY ONE — NOT THE DIRECTORY, AND NEVER THE INBOX ═══
  //
  // `ci import` takes archive FILES. Handed a directory it refuses, and
  // its refusal suggests the other command: "Move it into the import inbox and
  // run `ci inbox --start`". Do not take that suggestion here. THE INBOX
  // CONSUMES WHAT IT IMPORTS, BY RENAME — that is the mechanism that ate 2.8GB
  // of this owner's archive in a sibling repo. Even against the staging copy it
  // would move files out from under a re-run; against anything else it is the
  // accident this whole file exists to prevent.
  //
  // The CLI is an ordinary API client with an ordinary api key; the paths it
  // names are resolved by the SERVER against CI_IMPORT_ROOTS, which box A boots
  // with pinned to the staging directory. So even a mistyped path cannot reach
  // the archive — the appliance refuses it before any read.
  const result = spawnSync(
    'yarn',
    ['workspace', '@ci/cli', 'dev', 'import', ...files, '--label', `federation-harness/${source}`, '--wait'],
    {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        CI_SERVER_URL: `http://127.0.0.1:${state.boxes.a.apiPort}`,
        CI_API_KEY: state.boxes.a.apiKey ?? '',
      },
    },
  );

  if (result.status !== 0) {
    throw new Error(`ci exited ${result.status}`);
  }
}

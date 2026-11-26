#!/usr/bin/env node
/**
 * The gate for this repo's LemmaScript proofs: `npm run check` from this directory proves every
 * file in LemmaScript-files.txt; `npm run check -- <repo-relative path> ...` proves only those.
 *
 * It fails, with a message, when any of these is true:
 *
 * - Dafny 4.11.0 is not on PATH (or at $DAFNY), or lsc is not the pinned 0.6.14;
 * - LemmaScript-files.txt is empty, names a missing file, or carries a timeout or flags column;
 * - a listed file uses a `//@` keyword outside ALLOWED_KEYWORDS (no assume, havoc, extern,
 *   type overrides and the rest), or a `case 'none':` / `case 'some':` label (see CTOR_CLASH);
 * - `lsc check` fails, or does not report a non-empty proof with no errors for every listed file;
 * - `dafny audit` reports anything for a proof file;
 * - a generated `.dfy.gen` or `.dfy` differs from what is staged or committed, or is untracked.
 *
 * Dependency-free on purpose, like the repo's other gate scripts: only node built-ins and git.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const MANIFEST = join(HERE, 'LemmaScript-files.txt');
const CONFIG = join(HERE, 'lemmascript.json');
const LSC = join(HERE, 'node_modules', '.bin', 'lsc');
const LSC_VERSION = '0.6.14';
const DAFNY_VERSION = '4.11.0';

/**
 * The `//@` keywords a listed file may use. Everything else either tells lsc to trust rather than
 * prove (assume, havoc, autohavoc, extern, impure) or changes what it models without a check
 * (type, declare-type, skip, option, pure), and needs a reviewed change to this list first.
 */
const ALLOWED_KEYWORDS = new Set(['verify', 'requires', 'ensures', 'invariant', 'decreases', 'contract']);

/**
 * lsc 0.6.14 writes a string-union member named `none` or `some` as Option's `None` / `Some`. As a
 * `case` label that becomes a Dafny pattern binding a fresh variable, which matches everything.
 * Comparisons (`x === 'none'`) are translated correctly; labels are refused here.
 */
const CTOR_CLASH = /\bcase\s+(['"])(none|some)\1\s*:/;

function fail(message) {
  console.error(`spec:lemmascript: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
}

function readManifest() {
  if (!existsSync(MANIFEST)) {
    fail(`${relative(REPO, MANIFEST)} is missing`);
  }

  const entries = readFileSync(MANIFEST, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

  if (entries.length === 0) {
    fail(`${relative(REPO, MANIFEST)} lists no files, so there is nothing to prove`);
  }

  return entries.map((entry) => {
    if (/\s/.test(entry)) {
      fail(`"${entry}": a timeout or flags column needs a reviewed change to check.mjs first`);
    }

    const source = resolve(HERE, entry);
    if (!existsSync(source)) {
      fail(`"${entry}" does not exist`);
    }

    return source;
  });
}

function checkAnnotations(source) {
  const lines = readFileSync(source, 'utf8').split('\n');
  let verified = 0;

  lines.forEach((line, index) => {
    const where = `${relative(REPO, source)}:${index + 1}`;
    const annotation = /\/\/@\s*([A-Za-z_-]+)/.exec(line);
    if (annotation) {
      if (!ALLOWED_KEYWORDS.has(annotation[1])) {
        fail(`${where}: \`//@ ${annotation[1]}\` is not allowed in a proved file (see ALLOWED_KEYWORDS)`);
      }

      if (annotation[1] === 'verify') {
        verified += 1;
      }
    }

    // Comments may name the label (to explain its absence); only code is checked.
    const code = /^\s*(\*|\/\*)/.test(line) ? '' : line.replace(/\/\/.*$/, '');
    if (CTOR_CLASH.test(code)) {
      fail(
        `${where}: a \`case 'none':\` or \`case 'some':\` label reaches Dafny as a catch-all (see CTOR_CLASH)`,
      );
    }
  });

  if (verified === 0) {
    fail(`${relative(REPO, source)} has no \`//@ verify\`, so lsc would prove nothing in it`);
  }
}

function probeDafny() {
  const dafny = process.env.DAFNY ?? 'dafny';
  const probe = run(dafny, ['--version']);
  if (probe.error || probe.status !== 0) {
    fail(
      `Dafny ${DAFNY_VERSION} is not on PATH (or at $DAFNY). Install the release zip from ` +
        `https://github.com/dafny-lang/dafny/releases/tag/v${DAFNY_VERSION}, check its sha256 against ` +
        'the published asset digest, and put its dafny/ directory on PATH.',
    );
  }

  const version = probe.stdout.trim();
  if (!version.startsWith(`${DAFNY_VERSION}+`) && version !== DAFNY_VERSION) {
    fail(`expected Dafny ${DAFNY_VERSION}, found ${version}`);
  }

  return dafny;
}

function probeLsc() {
  if (!existsSync(LSC)) {
    fail('lsc is not installed: run `npm ci` in spec/lemmascript');
  }

  const version = run(LSC, ['version']).stdout?.trim();
  if (version !== LSC_VERSION) {
    fail(`expected lemmascript ${LSC_VERSION}, found ${version || 'nothing'}; run \`npm ci\``);
  }
}

function generatedFiles(sources) {
  return sources.flatMap((source) => {
    const stem = source.replace(/\.ts$/, '');

    return [`${stem}.dfy.gen`, `${stem}.dfy`];
  });
}

function selectSources(listed) {
  const wanted = process.argv.slice(2);
  if (wanted.length === 0) {
    return listed;
  }

  return wanted.map((path) => {
    const source = resolve(REPO, path);
    if (!listed.includes(source)) {
      fail(`"${path}" is not listed in ${relative(REPO, MANIFEST)}`);
    }

    return source;
  });
}

const sources = selectSources(readManifest());
sources.forEach(checkAnnotations);

const dafny = probeDafny();
probeLsc();

// lsc runs `dafny` from PATH, so a $DAFNY binary's directory goes first.
const env = { ...process.env, LSC_RUN_LOG: 'false' };
if (process.env.DAFNY) {
  env.PATH = `${dirname(resolve(process.env.DAFNY))}${delimiter}${process.env.PATH ?? ''}`;
}

// With no file argument lsc batches over LemmaScript-files.txt; with some, it proves just those.
const only = process.argv.length > 2 ? sources : [];
const proof = run(LSC, ['check', '--backend=dafny', `--config=${CONFIG}`, ...only], { cwd: HERE, env });
process.stdout.write(proof.stdout ?? '');
process.stderr.write(proof.stderr ?? '');
if (proof.error || proof.status !== 0) {
  fail(`lsc check failed (exit ${proof.status ?? proof.error?.message})`);
}

// A green run can be vacuous. Every listed file must report a proof with something in it.
const finished = [...(proof.stdout ?? '').matchAll(/finished with (\d+) verified, (\d+) errors?/g)];
const sound = finished.filter((match) => Number(match[1]) > 0 && Number(match[2]) === 0);
if (finished.length !== sources.length || sound.length !== sources.length) {
  fail(`expected ${sources.length} non-empty proofs with no errors, lsc reported ${finished.length}`);
}

const generated = generatedFiles(sources);
for (const file of generated.filter((path) => path.endsWith('.dfy'))) {
  const audit = run(dafny, ['audit', file], { env });
  if (audit.status !== 0 || !/completed with 0 findings/.test(audit.stdout ?? '')) {
    process.stdout.write(audit.stdout ?? '');
    process.stderr.write(audit.stderr ?? '');
    fail(`dafny audit found something in ${relative(REPO, file)}`);
  }
}

const paths = generated.map((path) => relative(REPO, path));
const untracked = run('git', ['ls-files', '--others', '--exclude-standard', '--', ...paths], { cwd: REPO });
if (untracked.status !== 0) {
  fail(`git ls-files failed: ${untracked.stderr}`);
}

if (untracked.stdout.trim() !== '') {
  fail(`generated files are not in git, add them:\n${untracked.stdout}`);
}

const stale = run('git', ['diff', '--exit-code', '--stat', '--', ...paths], { cwd: REPO });
if (stale.status !== 0) {
  fail(`generated files changed; review and stage them:\n${stale.stdout}${stale.stderr}`);
}

console.log(`spec:lemmascript: ${sources.length} files proved, audit clean, generated files unchanged`);

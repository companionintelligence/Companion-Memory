#!/usr/bin/env node
/**
 * The gate for this repo's LemmaScript proofs: `npm run check` from this directory proves every
 * file in LemmaScript-files.txt; `npm run check -- <repo-relative path> ...` proves only those.
 *
 * It fails, with a message, when any of these is true:
 *
 * - Dafny 4.11.0 is not on PATH (or at $DAFNY), or lsc is not the pinned 0.6.14;
 * - lemmascript.json is not exactly EXPECTED_CONFIG;
 * - LemmaScript-files.txt is empty, names a missing file, or carries a timeout or flags column;
 * - a listed file uses a `//@` keyword outside ALLOWED_KEYWORDS (no assume, havoc, extern,
 *   requires, type overrides and the rest), or a `case 'none':` / `case 'some':` label (see
 *   CTOR_CLASH);
 * - a file that a listed file imports by a relative path, directly or through other files, carries
 *   a `//@` annotation and is not listed itself (lsc reads type overrides from such files);
 * - `lsc check` fails, or does not report a non-empty proof with no errors for every listed file;
 * - a proof `.dfy` is not byte for byte the `.dfy.gen` lsc generated, or includes another file;
 * - `dafny audit` reports anything for a proof file;
 * - a generated `.dfy.gen` or `.dfy` differs from what is staged or committed, or is untracked.
 *
 * Dependency-free on purpose, like the repo's other gate scripts: only node built-ins and git.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const MANIFEST = join(HERE, 'LemmaScript-files.txt');
const CONFIG = join(HERE, 'lemmascript.json');
const LSC = join(HERE, 'node_modules', '.bin', 'lsc');
const LSC_VERSION = '0.6.14';
const DAFNY_VERSION = '4.11.0';
const INSTALL = 'run `npm ci --ignore-scripts` in spec/lemmascript';

/**
 * The `//@` keywords a listed file may use. Everything else either tells lsc to trust rather than
 * prove (assume, havoc, autohavoc, extern, impure, requires) or changes what it models without a
 * check (type, declare-type, skip, option, pure, backend), and needs a reviewed change to this
 * list first.
 *
 * `requires` is out because the proved functions are called from unverified code, so nothing
 * checks a precondition at a call site. One that no input meets makes every `ensures` vacuous.
 */
const ALLOWED_KEYWORDS = new Set(['verify', 'ensures', 'invariant', 'decreases', 'contract']);

/**
 * lemmascript.json, exactly. `proof-dir` would move the generated files away from the paths this
 * script checks, `unread-annotations` below `error` lets a misspelt annotation prove nothing, and
 * `string-semantics` changes what every string contract means.
 */
const EXPECTED_CONFIG = { 'unread-annotations': 'error', 'dafny-library': 'local', 'run-log': false };

/**
 * lsc 0.6.14 writes a string-union member named `none` or `some` as Option's `None` / `Some`. As a
 * `case` label that becomes a Dafny pattern binding a fresh variable, which matches everything.
 * Comparisons (`x === 'none'`) are translated correctly; labels are refused here.
 */
const CTOR_CLASH = /\bcase\s+(['"])(none|some)\1\s*:/;

/** A `//@` annotation's keyword. `//@ts-...` is TypeScript's, and lsc does not read it either. */
const ANNOTATION = /\/\/@(?!ts-)\s*([A-Za-z_-]+)/g;

/** A relative module specifier: `from '...'`, `import '...'` or `import('...')`. */
const RELATIVE_IMPORT = /\b(?:from|import)\s*\(?\s*(['"])(\.\.?\/[^'"]*)\1/g;

function fail(message) {
  console.error(`spec:lemmascript: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
}

function isFile(path) {
  return existsSync(path) && statSync(path).isFile();
}

function checkConfig() {
  let config;
  try {
    config = JSON.parse(readFileSync(CONFIG, 'utf8'));
  } catch (error) {
    fail(`${relative(REPO, CONFIG)} is missing or is not JSON: ${error.message}`);
  }

  const keys =
    config !== null && typeof config === 'object' && !Array.isArray(config) ? Object.keys(config) : [];
  const exact =
    keys.length > 0 &&
    keys.length === Object.keys(EXPECTED_CONFIG).length &&
    keys.every((key) => Object.hasOwn(EXPECTED_CONFIG, key) && config[key] === EXPECTED_CONFIG[key]);
  if (!exact) {
    fail(
      `${relative(REPO, CONFIG)} must be exactly ${JSON.stringify(EXPECTED_CONFIG)}; ` +
        'a change to it needs a reviewed change to EXPECTED_CONFIG in check.mjs first',
    );
  }
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
    for (const [, keyword] of line.matchAll(ANNOTATION)) {
      if (!ALLOWED_KEYWORDS.has(keyword)) {
        fail(`${where}: \`//@ ${keyword}\` is not allowed in a proved file (see ALLOWED_KEYWORDS)`);
      }

      if (keyword === 'verify') {
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

/** The TypeScript file a relative specifier names, as TypeScript would find it, if there is one. */
function resolveImport(importer, specifier) {
  const target = resolve(dirname(importer), specifier);
  const stem = target.replace(/\.[cm]?js$/, '');
  const candidates = [
    target,
    ...['.ts', '.tsx', '.mts', '.cts'].map((extension) => `${stem}${extension}`),
    join(target, 'index.ts'),
    join(target, 'index.tsx'),
  ];

  // lsc skips declaration files when it reads types, so they are not followed either.
  return candidates.find((path) => /\.[cm]?tsx?$/.test(path) && !/\.d\.[cm]?ts$/.test(path) && isFile(path));
}

/**
 * lsc reads the types a proved function uses from whichever file declares them, including a
 * leading `//@ type` override on an alias and a trailing one on an interface field. So every file a
 * selected file reaches through relative imports is checked too: a listed one against the
 * allowlist, any other for having no annotation at all.
 */
function checkImportedFiles(sources, listed) {
  const seen = new Set(sources);
  const pending = [...sources];

  while (pending.length > 0) {
    const importer = pending.pop();
    for (const match of readFileSync(importer, 'utf8').matchAll(RELATIVE_IMPORT)) {
      const file = resolveImport(importer, match[2]);
      if (file === undefined || seen.has(file) || relative(REPO, file).startsWith('..')) {
        continue;
      }

      seen.add(file);
      pending.push(file);

      if (listed.includes(file)) {
        checkAnnotations(file);
        continue;
      }

      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          for (const [, keyword] of line.matchAll(ANNOTATION)) {
            fail(
              `${relative(REPO, file)}:${index + 1}: \`//@ ${keyword}\` in a file that a proved file imports. ` +
                'lsc reads annotations there without this check: remove it, or list the file and prove it.',
            );
          }
        });
    }
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
    fail(`lsc is not installed: ${INSTALL}`);
  }

  const version = run(LSC, ['version']).stdout?.trim();
  if (version !== LSC_VERSION) {
    fail(`expected lemmascript ${LSC_VERSION}, found ${version || 'nothing'}; ${INSTALL}`);
  }
}

function generatedFiles(source) {
  const stem = source.replace(/\.ts$/, '');

  return { gen: `${stem}.dfy.gen`, dfy: `${stem}.dfy` };
}

function selectSources(listed) {
  const wanted = process.argv.slice(2);
  if (wanted.length === 0) {
    return listed;
  }

  return [
    ...new Set(
      wanted.map((path) => {
        const source = resolve(REPO, path);
        if (!listed.includes(source)) {
          fail(`"${path}" is not listed in ${relative(REPO, MANIFEST)}`);
        }

        return source;
      }),
    ),
  ];
}

checkConfig();
const listed = readManifest();
const sources = selectSources(listed);
sources.forEach(checkAnnotations);
checkImportedFiles(sources, listed);

const dafny = probeDafny();
probeLsc();

// lsc runs `dafny` from PATH, so a $DAFNY binary's directory goes first.
const env = { ...process.env, LSC_RUN_LOG: 'false' };
if (process.env.DAFNY) {
  env.PATH = `${dirname(resolve(process.env.DAFNY))}${delimiter}${process.env.PATH ?? ''}`;
}

// With no file argument lsc batches over LemmaScript-files.txt. It reads only one file argument,
// so a selection runs it once per file.
const runs = process.argv.length > 2 ? sources.map((source) => [source]) : [[]];
let reported = '';
for (const only of runs) {
  const proof = run(LSC, ['check', '--backend=dafny', `--config=${CONFIG}`, ...only], { cwd: HERE, env });
  process.stdout.write(proof.stdout ?? '');
  process.stderr.write(proof.stderr ?? '');
  if (proof.error || proof.status !== 0) {
    fail(
      `lsc check failed (exit ${proof.status ?? proof.error?.message}). If you changed a proved ` +
        'function, regenerate its proof first: see "Changing a proved function" in README.md.',
    );
  }

  reported += proof.stdout ?? '';
}

// A green run can be vacuous. Every listed file must report a proof with something in it.
const finished = [...reported.matchAll(/finished with (\d+) verified, (\d+) errors?/g)];
const sound = finished.filter((match) => Number(match[1]) > 0 && Number(match[2]) === 0);
if (finished.length !== sources.length || sound.length !== sources.length) {
  fail(`expected ${sources.length} non-empty proofs with no errors, lsc reported ${finished.length}`);
}

// lsc's own check lets a proof add lines to what it generated, an `include` among them, and then
// verifies the proof with whatever those lines bring in. No proof here adds anything, so each one
// must be exactly what lsc generated from its .ts.
for (const source of sources) {
  const { gen, dfy } = generatedFiles(source);
  const generated = readFileSync(gen);
  if (!readFileSync(dfy).equals(generated)) {
    fail(
      `${relative(REPO, dfy)} is not byte for byte the ${basename(gen)} lsc generated. Hand-written ` +
        'proof additions need a reviewed change to check.mjs first.',
    );
  }

  if (/^\s*include\b/m.test(generated.toString('utf8'))) {
    fail(`${relative(REPO, gen)} includes another Dafny file, which this check does not verify`);
  }

  const audit = run(dafny, ['audit', dfy], { env });
  if (audit.status !== 0 || !/completed with 0 findings/.test(audit.stdout ?? '')) {
    process.stdout.write(audit.stdout ?? '');
    process.stderr.write(audit.stderr ?? '');
    fail(`dafny audit found something in ${relative(REPO, dfy)}`);
  }
}

const paths = sources
  .flatMap((source) => Object.values(generatedFiles(source)))
  .map((path) => relative(REPO, path));
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

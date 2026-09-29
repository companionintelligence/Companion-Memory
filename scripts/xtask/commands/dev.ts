/**
 * dev — ports the `dev` target.
 *
 * `build` is called in-process (it is ported); `health` and `init` are not, and
 * are invoked as `make` subprocesses exactly as the original recipe did.
 * `health` staying in the Makefile is deliberate rather than incidental: it is
 * the toolchain diagnostic, so it has to keep working on a checkout where the
 * JS toolchain is the thing that is broken.
 */
import { parseArgs } from 'node:util';

import { run, tryRun, which } from '../lib/exec';
import { detectGpu, type Gpu } from '../lib/gpu';
import { computeProjectName } from '../lib/identity';
import { readUvVersion } from '../lib/uv';
import { computeBuildPlan, runBuild, type BuildStep } from './build';
import { ok, note } from '../../dev-stack/log';

const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[0;33m';
const RESET = '\x1b[0m';

// The embedding model (`embedding.model` in backend/apps/api/config/default.json)
// and the chat model every LLM-backed feature falls back to
// (`DEFAULT_CHAT_MODEL` in backend/apps/api/src/configuration.ts). Keep this
// list in step with those two sources of truth — the pre-port Makefile's own comment.
const REQUIRED_OLLAMA_MODELS = ['nomic-embed-text', 'gemma4:e4b'];

function checkOvermind(): void {
  const found = which('overmind');

  if (!found) {
    throw new Error("You do not have 'overmind' installed or it is not in your PATH.");
  }

  ok(`overmind found at ${found}`);
  console.log('');
}

function checkCaddy(): void {
  const found = which('caddy');

  if (!found) {
    throw new Error("You do not have 'caddy' installed or it is not in your PATH.");
  }

  ok(`caddy found at ${found}`);
  console.log('');

  if (tryRun('curl', ['-sf', 'http://localhost:2019/config/']).status !== 0) {
    throw new Error("caddy admin API not reachable on :2019. Start it with 'brew services start caddy'.");
  }

  console.log(`  ${GREEN}✓${RESET} caddy admin API reachable on :2019\n`);
}

function checkOllama(): void {
  const found = which('ollama');

  if (!found) {
    throw new Error("You do not have 'ollama' installed or it is not in your PATH.");
  }

  ok(`ollama found at ${found} 🦙`);
  console.log('');

  if (tryRun('nc', ['-z', 'localhost', '11434']).status !== 0) {
    throw new Error("ollama is NOT running on port 11434. Please start ollama (e.g., 'ollama serve')");
  }

  console.log(`  ${GREEN}✓${RESET} ollama is running on port 11434\n`);
}

/** Ollama binding loopback-only is a real footgun: the sidecars reach it via
 * `host.docker.internal`, not localhost, and ollama binds 127.0.0.1 by
 * default. Warning-only — OLLAMA_HOST may legitimately point elsewhere, and
 * a host with no docker bridge skips the check entirely, silently, matching
 * the pre-port Makefile's bare `if [ -n "$$GW" ]; then ... fi` with no else. */
function checkOllamaReachableFromContainers(): void {
  const gw = tryRun('docker', [
    'network',
    'inspect',
    'bridge',
    '--format',
    '{{(index .IPAM.Config 0).Gateway}}',
  ]).stdout.trim();

  if (!gw) {
    return;
  }

  // curl with explicit connect and total timeouts rather than netcat: macOS
  // netcat can leave a SYN to the Docker Desktop gateway pending well past its
  // -w value, making `make dev` appear hung on a normal loopback-only Ollama
  // install. (Carried over from #2643, which fixed this in the shell recipe
  // this function replaced.)
  const probe = tryRun('curl', [
    '-fsS',
    '--noproxy',
    '*',
    '--connect-timeout',
    '2',
    '--max-time',
    '3',
    `http://${gw}:11434/api/tags`,
  ]);

  if (probe.status === 0) {
    console.log(`  ${GREEN}✓${RESET} ollama is reachable from containers (via ${gw})\n`);

    return;
  }

  console.log(`  ${YELLOW}•${RESET} ollama is listening on loopback only, so containers cannot reach it`);
  console.log('    through host.docker.internal and the summary service will crash-loop on model');
  console.log(
    `    discovery. Restart it bound to all interfaces:  ${YELLOW}OLLAMA_HOST=0.0.0.0 ollama serve${RESET}`,
  );
  console.log(`    (or pin ${YELLOW}LLM_DEFAULT_CHAT_MODEL${RESET} in .env to skip discovery entirely).\n`);
}

/** `ollama list`'s columns are padded with runs of whitespace, so the model
 * name is the first whitespace-delimited field of each non-header line —
 * mirrors `awk 'NR>1 {print $1}'`. */
function ollamaModelAvailable(model: string): boolean {
  const names = tryRun('ollama', ['list'])
    .stdout.split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean);

  return names.includes(model) || names.includes(`${model}:latest`);
}

/** `ollama pull` streams its own progress and blocks until the blobs are on
 * disk, so this waits on a cold machine instead of failing outright. */
function ensureOllamaModels(): void {
  for (const model of REQUIRED_OLLAMA_MODELS) {
    if (ollamaModelAvailable(model)) {
      console.log(`  ${GREEN}✓${RESET} ollama model '${model}' is available\n`);
      continue;
    }

    console.log(
      `  ${YELLOW}•${RESET} ollama model '${model}' is not pulled yet — downloading now (this can take several minutes)...\n`,
    );

    try {
      run('ollama', ['pull', model]);
    } catch {
      throw new Error(
        `Failed to pull ollama model '${model}'. Fix the error above (or run ${YELLOW}ollama pull ${model}${RESET} manually) and retry.`,
      );
    }

    console.log(`\n  ${GREEN}✓${RESET} ollama model '${model}' pulled\n`);
  }
}

function imageExists(repo: string): boolean {
  return tryRun('docker', ['image', 'inspect', `${repo}:latest`]).status === 0;
}

function imageSourceTreeLabel(repo: string): string {
  return tryRun('docker', [
    'image',
    'inspect',
    '--format',
    '{{index .Config.Labels "ci.source-tree"}}',
    `${repo}:latest`,
  ]).stdout.trim();
}

/**
 * Which of the local ENV's images to (re)build: missing ones, and warm ones
 * whose `ci.source-tree` label differs from the stamp a build at HEAD would
 * give them — every image in the local set carries one (see `sourceTree` in
 * build.ts), so a committed change to any of their sources is noticed, not
 * just the two Python sidecars'. The stamps come from the same
 * `computeBuildPlan` that `build` runs, so the two cannot disagree about what
 * an image is built from.
 *
 * Missing takes priority over stale (an image already flagged missing is
 * never also flagged stale — the pre-port Makefile's `case " $$missing " in ...
 * continue`), and an unreadable stamp means "skip the staleness judgment",
 * not "assume stale" (the pre-port Makefile). An image built before it was
 * stamped has no label, so it reads as stale once and is rebuilt.
 */
function checkImagesNeedBuild(root: string, gpu: Gpu): { missing: BuildStep[]; stale: BuildStep[] } {
  const { steps } = computeBuildPlan(root, 'local', gpu, readUvVersion(root));
  const missing = steps.filter((step) => !imageExists(step.repo));
  const stale = steps.filter(
    (step) =>
      !missing.includes(step) && step.sourceTree && imageSourceTreeLabel(step.repo) !== step.sourceTree,
  );

  return { missing, stale };
}

export interface DevOptions {
  gpu: Gpu;
  rebuild?: boolean;
}

export async function runDev(root: string, opts: DevOptions): Promise<void> {
  console.log('🧑‍💻 Starting development environment...\n');

  // `make health`, not an in-process call: health is the toolchain diagnostic,
  // so it stays pure shell in the Makefile and must keep working on a checkout
  // where node/yarn/uv are missing or mismatched — the exact case it exists to
  // report. It exits nonzero on a fatal check, which aborts `dev` here just as
  // the original `@$(MAKE) health` line did.
  run('make', ['health'], { cwd: root });

  checkOvermind();
  checkCaddy();
  checkOllama();
  checkOllamaReachableFromContainers();
  ensureOllamaModels();

  run('make', ['init'], { cwd: root });

  const { missing, stale } = checkImagesNeedBuild(root, opts.gpu);

  if (opts.rebuild) {
    await runBuild(root, { env: 'local', gpu: opts.gpu });
  } else if (missing.length > 0 || stale.length > 0) {
    if (missing.length > 0) {
      note(`building — missing image(s):${missing.map((m) => ` ${m.repo}`).join('')}`);
      console.log('');
    }

    if (stale.length > 0) {
      note(`building — image(s) built from other source:${stale.map((m) => ` ${m.repo}`).join('')}`);
      console.log('');
    }

    // Only those: an edit to the object store's entrypoint should not cost an
    // HBPE rebuild. REBUILD=1 above still rebuilds the whole set.
    await runBuild(root, {
      env: 'local',
      gpu: opts.gpu,
      images: [...missing, ...stale].map((step) => step.key),
    });
  } else {
    ok(`Reusing existing local images (set ${YELLOW}REBUILD=1${RESET} to rebuild)`);
    console.log('');
  }

  // Hand off to the per-worktree stack supervisor: it allocates ports,
  // brings up the compose stack, migrates, registers the Caddy route, and
  // runs the Procfile via overmind. Foreground; Ctrl-C tears it down.
  const projectName = computeProjectName(root);

  run('yarn', ['tsx', 'scripts/dev-stack/index.ts', 'up', '--key', projectName], { cwd: root });
}

const HELP = `Usage: xtask dev [--gpu cpu|cuda|rocm] [--rebuild]

Run the development environment locally.`;

export async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { gpu: { type: 'string' }, rebuild: { type: 'boolean' }, help: { type: 'boolean' } },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(HELP);

    return;
  }

  const root = process.cwd();
  const gpu = (values.gpu as Gpu | undefined) ?? detectGpu(root);

  await runDev(root, { gpu, rebuild: values.rebuild as boolean | undefined });
}

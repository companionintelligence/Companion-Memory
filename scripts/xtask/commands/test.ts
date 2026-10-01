/**
 * test — ports the `test` target, the pre-port Makefile, and aggregates it.
 *
 * The pre-port recipe was a chain of bare `@cmd` lines, so the first failing
 * workspace aborted `make test` and hid every suite after it — including, in
 * practice, the ones that would have told you whether the failure was yours.
 * Every step now runs regardless of an earlier one failing, a summary table
 * says which passed and which did not, and the exit status is nonzero when any
 * did. Only an interrupt (Ctrl-C) stops the run early: that is the operator
 * asking to stop, not a step failing.
 *
 * `yarn workspaces foreach` is replaced by one step per workspace that declares
 * a `test` script — the same set, in the same order, run the same way
 * (`yarn workspace <name> run test`). foreach has no keep-going flag, so it
 * cannot be told to carry on past a failure; the per-workspace list is what
 * makes "every step runs" true for the workspaces too.
 *
 * The untested-workspace report (1006-1017) is reimplemented natively here
 * (`yarn workspaces list --json` + `JSON.parse` each package.json) rather
 * than porting the original's sed-plus-shelled-`node -e` pipeline
 * character-for-character — behaviorally identical, considerably easier to
 * read.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { TERMINATION_SIGNALS, TSX_RELAY_WARNING, run, tryRun, underTsxRelay } from '../lib/exec';
import { fail, info, note, ok, step as logStep, table } from '../../dev-stack/log';

const YELLOW = '\x1b[0;33m';
const RESET = '\x1b[0m';

/** Mirrors `find frontend/apps/desktop/scripts -name '*.test.cjs'` filtered to
 * exclude any node_modules subtree, then `sort` — recursive. */
function findDesktopTestSuites(root: string): string[] {
  const start = path.join(root, 'frontend/apps/desktop/scripts');
  const results: string[] = [];

  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) {
      return;
    }

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') {
        continue;
      }

      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.test.cjs')) {
        results.push(full);
      }
    }
  };

  walk(start);

  return results.sort();
}

interface WorkspaceListEntry {
  location: string;
  name: string;
}

export interface Workspace {
  location: string;
  name: string;
  hasTestScript: boolean;
}

/** Every Yarn workspace, root included, with whether it declares a `test`
 * script. `foreach --all` skips the ones that do not, silently. */
function listWorkspaces(root: string): Workspace[] {
  const res = tryRun('yarn', ['workspaces', 'list', '--json'], { cwd: root });

  if (res.status !== 0) {
    throw new Error(`yarn workspaces list --json exited ${res.status}: ${res.stderr.trim()}`);
  }

  return res.stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const entry = JSON.parse(line) as WorkspaceListEntry;
      const pkgPath = path.join(root, entry.location, 'package.json');
      const pkg = fs.existsSync(pkgPath)
        ? (JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> })
        : {};

      return { location: entry.location, name: entry.name, hasTestScript: Boolean(pkg.scripts?.test) };
    });
}

/** Every workspace `yarn workspaces foreach --all run test` silently skips
 * because it declares no `test` script — the pre-port Makefile's own fix for
 * `foreach`'s silent skip, which `typecheck` (the pre-port Makefile) already had to
 * learn the same lesson from. */
export function untestedWorkspaces(workspaces: Workspace[]): string[] {
  return workspaces.filter((w) => !w.hasTestScript).map((w) => w.location);
}

/** One unit of `make test`. `run` throws when the step fails — the same
 * contract `exec.run()` already has, so a step is usually a one-line closure. */
export interface Step {
  name: string;
  run: () => void | Promise<void>;
}

export type Outcome = 'pass' | 'fail' | 'not-run';

export interface StepResult {
  name: string;
  outcome: Outcome;
  durationMs: number;
  /** Why it failed, or why it did not run. */
  detail?: string;
}

export interface RunStepsHooks {
  onStart?: (step: Step, index: number, total: number) => void;
  onDone?: (result: StepResult) => void;
  /** Checked before each step; true stops the run and marks the rest `not-run`. */
  shouldStop?: () => boolean;
  /** Injectable clock, for tests. */
  now?: () => number;
  /**
   * Awaited after every step, so a signal that arrived while the step ran gets delivered before
   * `shouldStop` is asked. Injectable for tests; see {@link yieldToEventLoop} for why the default is not
   * a no-op.
   */
  yieldToEventLoop?: () => Promise<void>;
}

/**
 * Let node deliver the signals that arrived while a step blocked the event loop.
 *
 * Every step here is a `spawnSync`, which parks the loop until the child exits. A Ctrl-C (or a hangup)
 * reaches the child, which dies, and `spawnSync` returns — but node has not yet RUN its own handler for the
 * same signal: that happens on a later turn of the loop, and a plain `forEach` never takes one. The flag
 * `shouldStop` reads was therefore still false, and every remaining step started. One `setImmediate` is
 * not enough either — it can fire in the same turn before the signal pipe is polled — so it is two: the
 * second is only reached on the following turn, whose poll phase has read the pending signal.
 */
export const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

/**
 * Run every step in order. A step that throws is a FAILED step, never a reason
 * to skip the next one — that is the whole point of this function, and the
 * thing the unit tests pin. The only early exit is `shouldStop`, and the steps
 * it cuts off are reported as `not-run`, not dropped, so the summary still
 * accounts for every step that was supposed to happen.
 */
export async function runSteps(steps: Step[], hooks: RunStepsHooks = {}): Promise<StepResult[]> {
  const now = hooks.now ?? Date.now;
  const yielder = hooks.yieldToEventLoop ?? yieldToEventLoop;
  const results: StepResult[] = [];
  let stopped = false;

  for (const [index, s] of steps.entries()) {
    if (!stopped && hooks.shouldStop?.()) {
      stopped = true;
    }

    if (stopped) {
      const result: StepResult = { name: s.name, outcome: 'not-run', durationMs: 0, detail: 'interrupted' };

      results.push(result);
      hooks.onDone?.(result);

      continue;
    }

    hooks.onStart?.(s, index, steps.length);

    const started = now();
    let result: StepResult;

    try {
      await s.run();
      result = { name: s.name, outcome: 'pass', durationMs: now() - started };
    } catch (err) {
      result = {
        name: s.name,
        outcome: 'fail',
        durationMs: now() - started,
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    results.push(result);
    hooks.onDone?.(result);

    await yielder();
  }

  return results;
}

/** Steps that did not pass — failed, or cut off by an interrupt. Nonempty
 * means the whole run is red. */
export function unsuccessful(results: StepResult[]): StepResult[] {
  return results.filter((r) => r.outcome !== 'pass');
}

const formatDuration = (ms: number): string => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

/** The aggregate table's rows: step, verdict, wall time. */
export function summaryRows(results: StepResult[]): string[][] {
  return results.map((r) => [
    r.name,
    r.outcome === 'pass' ? 'pass' : r.outcome === 'fail' ? 'FAIL' : 'not run',
    r.outcome === 'not-run' ? '—' : formatDuration(r.durationMs),
  ]);
}

/** The steps `make test` runs, in order. Built lazily so `--help` and the unit
 * tests never touch the filesystem or yarn. */
export function buildSteps(root: string, workspaces: Workspace[]): Step[] {
  // A workspace with no `test` script is reported below, not run here: `yarn
  // workspace <name> run test` on it would fail, where foreach skipped it. A
  // new workspace that declares one is picked up without a line here.
  const steps: Step[] = workspaces
    .filter((w) => w.hasTestScript)
    .map((w) => ({
      name: `workspace ${w.name}`,
      run: () => run('yarn', ['workspace', w.name, 'run', 'test'], { cwd: root }),
    }));

  // frontend/apps/desktop is deliberately EXCLUDED from the Yarn workspaces
  // (Tauri needs a real node_modules tree PnP does not produce), so it is
  // invisible to the steps above and to the untested-workspace warning below.
  // Dependency-free — node's own runner, no install.
  steps.push({
    name: 'desktop (node --test)',
    run: () => {
      const suites = findDesktopTestSuites(root);

      if (suites.length === 0) {
        throw new Error(
          'Found no *.test.cjs under frontend/apps/desktop/scripts — this step would have checked nothing.',
        );
      }

      run('node', ['--test', ...suites], { cwd: root });
    },
  });

  steps.push({ name: 'python (pytest)', run: () => run('uv', ['run', 'pytest'], { cwd: root }) });

  // The gateway entrypoint is plain sh with no Docker in its test, so it runs
  // here rather than in any workspace. Its own file says what it covers.
  steps.push({
    name: 'gateway (sh)',
    run: () => run('sh', ['infrastructure/gateway/test.sh'], { cwd: root }),
  });

  // The secrets generator is plain sh with no Docker in its test, so it runs
  // here rather than in any workspace. Its own file says what it covers.
  steps.push({
    name: 'setup-secrets (sh)',
    run: () => run('sh', ['infrastructure/setup-secrets/test.sh'], { cwd: root }),
  });

  return steps;
}

export async function runTest(root: string): Promise<void> {
  console.log('🧪 Running tests...\n');

  const workspaces = listWorkspaces(root);
  const steps = buildSteps(root, workspaces);

  // Ctrl-C reaches the whole foreground group, so the running step's child dies
  // on its own. index.ts keeps THIS process alive through it (see the note
  // there) — which, without this flag, would read as "that step failed" and
  // march on into the next one. An interrupt means stop. All of
  // TERMINATION_SIGNALS, not just Ctrl-C: index.ts swallows SIGHUP for every
  // command, so a closed terminal would otherwise be ignored here.
  let interrupted = false;
  const onInterrupt = (): void => {
    interrupted = true;
  };

  for (const signal of TERMINATION_SIGNALS) {
    process.on(signal, onInterrupt);
  }

  let results: StepResult[];

  try {
    results = await runSteps(steps, {
      shouldStop: () => interrupted,
      onStart: (s, index, total) => {
        logStep(`[${index + 1}/${total}] ${s.name}`);
      },
      onDone: (r) => {
        if (r.outcome === 'fail') {
          fail(`${r.name} FAILED — ${r.detail}`);
        }

        console.log('');
      },
    });
  } finally {
    for (const signal of TERMINATION_SIGNALS) {
      process.off(signal, onInterrupt);
    }
  }

  console.log('Summary');
  table(['Step', 'Result', 'Time'], summaryRows(results), ['left', 'left', 'right']);
  console.log('');

  const bad = unsuccessful(results);

  if (bad.length === 0) {
    ok('All the tests that exist passed.');
    console.log('');
  }

  const untested = untestedWorkspaces(workspaces);

  if (untested.length > 0) {
    console.log(
      `${YELLOW}⚠${RESET}  ${untested.length} workspace(s) declare no 'test' script, so no step ran for them (\`foreach\` used to skip them silently):`,
    );

    for (const loc of untested) {
      // The root workspace used to be listed here permanently with a note that
      // its only suites were the Playwright e2e configs. It now declares a
      // `test` script (the xtask suite), so it no longer reaches this branch —
      // the label is kept only for the case where that script is removed again.
      const text = loc === '.' ? '. (repo root)' : loc;

      console.log(`       ${text}`);
    }

    console.log('');
  }

  // The native suites are deliberately not part of this target.
  info(`Native suites are separate: ${YELLOW}make test-android${RESET}, ${YELLOW}make test-desktop${RESET}`);
  info(
    `Database-backed jest suites need a database and are skipped without one: ${YELLOW}make test-db${RESET}`,
  );
  console.log('');

  if (bad.length > 0) {
    // Throwing, not process.exit(): index.ts prints the single `✗` line and sets
    // the exit code, the contract every command here follows.
    throw new Error(
      `${bad.length} of ${results.length} test step(s) did not pass: ${bad.map((r) => r.name).join(', ')}`,
    );
  }
}

export async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { help: { type: 'boolean' } },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(
      'Usage: xtask test\n\nRun the unit tests, both stacks. Every step runs even if an earlier one fails;\n' +
        'a summary table says which did not pass and the exit status is nonzero if any did.\n' +
        'Database-backed jest suites are separate: see `xtask test-db --help`.',
    );

    return;
  }

  if (underTsxRelay()) {
    note(TSX_RELAY_WARNING);
  }

  await runTest(process.cwd());
}

/**
 * test-db — run the database-backed jest suites against a throwaway Postgres.
 *
 * ~85 be-api suites need a real database, and without one every one of them
 * SKIPS — silently, with jest exiting 0. `make test` therefore says "passed" on
 * a machine that ran none of the integration coverage, and the obvious cure —
 * point them at the database `.env` names — points them at the owner's real
 * corpus, which they write to.
 *
 * This command is the third way: it starts a disposable container of the
 * appliance's own database image, bootstraps it exactly as CI does
 * (scripts/test-db/bootstrap.sql), migrates it, runs jest against it with every
 * connection variable pointing ONLY there and `CI_REQUIRE_DB=1` so a suite that
 * cannot find it FAILS instead of skipping, then judges the run: no unexplained
 * skips, no database crash in the container's log. The container is removed on
 * success, failure, an exception, SIGINT, SIGTERM and SIGHUP.
 *
 * A test file that fails the parallel run is re-run once, serially, before it is
 * called a failure (lib/flakes.ts): it is a FLAKE if it then passes — a warning,
 * not a failure — and REAL if it fails again.
 *
 * What it will not do: touch a container it did not create (names `ci-testdb-*`
 * that also carry the `ci.test-db=1` label — both, always), bind a fixed host
 * port, or hand jest any database setting from the parent environment. See
 * lib/testDb.ts for the last of those.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fail, info, note, ok, step, table } from '../../dev-stack/log';
import { ExitBackstop } from '../lib/backstop';
import {
  containerLogs,
  dockerReachable,
  imageState,
  justCreated,
  psql,
  removeContainers,
  startContainer,
  waitUntilReady,
  type StartedContainer,
} from '../lib/docker';
import {
  TERMINATION_SIGNALS,
  TSX_RELAY_WARNING,
  runAsync,
  runAsyncOrThrow,
  underTsxRelay,
} from '../lib/exec';
import { findCrashSignatures, formatFindings, type CrashFinding } from '../lib/dbLogSentinel';
import {
  asUnretried,
  classifyRetry,
  decide,
  failedFiles,
  mergeRetryIntoReport,
  planRetry,
  retryJestArgs,
  type ClassifiedFailure,
  type Decision,
} from '../lib/flakes';
import {
  checkNoSkips,
  parseAllowList,
  type AllowedSkip,
  type JestReport,
  type NoSkipsResult,
} from '../lib/noSkips';
import { reapStaleContainers } from '../lib/reaper';
import {
  APP_DATABASE,
  DEFAULT_KEEP_FOR_MS,
  LOCAL_IMAGE,
  LOOPBACK,
  MAX_KEEP_FOR_MS,
  STALE_AFTER_MS,
  assertOnlyThrowaway,
  buildTestEnv,
  chooseImage,
  formatAge,
  formatDuration,
  jestChoosesWorkers,
  jestFiltersByName,
  keptNotice,
  newContainerName,
  parseCiDatabaseImage,
  parseTestDbArgs,
  randomPassword,
  type TestDbArgs,
} from '../lib/testDb';

export const HELP = `Usage: xtask test-db [flags] [jest path patterns...] [-- jest args...]

Run the database-backed jest suites against a throwaway Postgres container.

Flags:
  --keep           Leave the container running afterwards (prints how to connect).
                   Later runs leave it alone for ${formatAge(DEFAULT_KEEP_FOR_MS)} (change it with --keep-for),
                   and for as long as anything is connected to it.
  --keep-for <t>   Like --keep, and sets how long later runs must leave the container
                   alone: a whole number and one unit, m, h or d (30m, 12h, 2d), at
                   most ${formatAge(MAX_KEEP_FOR_MS)}. It is fixed when the container is created.
  --image <ref>    Database image. Default: the local ci/database:latest when present
                   (what 'make dev' runs), else the pin in .github/workflows/ci.yml.
  --workers <n>    Jest worker processes (default 4; the machine is often shared).
  --no-retry       Do not re-run failed test files. By default each file that fails the
                   parallel run is re-run once, serially: it is a FLAKE if it then
                   passes (a warning, not a failure) and REAL if it fails again.
  --help, -h       This text.

Everything else is passed to jest: bare words are path patterns, and anything
after '--' is passed verbatim.

  make test-db                                     # the whole be-api suite
  make test-db ARGS='src/domains/import'           # one directory
  make test-db ARGS='-t revocation'                # a jest flag (the no-skip check is then off)
  make test-db KEEP=1 WORKERS=2 DB_IMAGE=my/db:1   # the flags above, as make variables
  make test-db KEEP_FOR=12h                        # keep it for 12h (implies KEEP=1)
  make test-db NO_RETRY=1                          # a failing file fails the run at once

Every connection variable the suites read is pointed at the container, and
CI_REQUIRE_DB=1 is set, so a suite that cannot reach it fails rather than skips.
The run fails on: any jest failure that survives the serial retry, any skipped
test that scripts/test-db/allowed-skips.json does not forgive, and any crash
signature in the database's own log. Docker must be running.

Every run first removes the test databases earlier runs left behind, but only a
container that is named ci-testdb-*, carries the ci.test-db=1 label, is more than
${formatAge(STALE_AFTER_MS)} old, is outside its --keep window and has nothing connected to it. One that
is in use is left alone and named in the output. Renaming a container (docker
rename <name> <new name>) protects it from every later run.`;

const READY_TIMEOUT_MS = 120_000;
/**
 * The first-run image pull is the one docker call whose duration is the network's, so its ceiling is
 * far above any healthy pull (a multi-gigabyte image on a slow line) and exists only so that a daemon
 * that accepted the call and went quiet cannot hold the run for ever. Ctrl-C stops it sooner.
 */
export const PULL_TIMEOUT_MS = 30 * 60_000;
const API_WORKSPACE = '@ci/be-api';

/** Where the summary is built up as the run goes, so a failure part-way still reports what it had. */
interface RunSummary {
  image?: string;
  imageSource?: string;
  postgres?: string;
  timescaledb?: string;
  migrations?: string;
  jest?: string;
  skips?: NoSkipsResult;
  skipCheck: 'ran' | 'off-because-name-filter' | 'not-reached';
  /** Every test file that failed the parallel run, and what the retry made of it. */
  failures: ClassifiedFailure[];
  /** Why nothing was retried, when files failed and that is so. */
  retrySkipped?: string;
  sentinel?: { findings: CrashFinding[]; lines: number };
  container?: string;
  containerState: 'not-created' | 'removed' | 'kept' | 'REMOVAL FAILED';
  problems: string[];
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface Lifecycle<H> {
  start: () => Promise<H> | H;
  /** Runs whether or not the body succeeded, BEFORE the removal, while the logs still exist. */
  inspect: (handle: H) => Promise<void> | void;
  remove: (handle: H) => Promise<void> | void;
}

/**
 * Run `body` against a started resource and remove the resource afterwards, no
 * matter how the body ended: return, throw, or a rejected promise. `inspect`
 * runs first (the crash sentinel needs the container's log, which the removal
 * destroys) and a failure in it does not prevent the removal. With `keep`, the
 * resource is left in place — and only then.
 */
export async function withThrowaway<H, T>(
  lifecycle: Lifecycle<H>,
  opts: { keep: boolean },
  body: (handle: H) => Promise<T>,
): Promise<T> {
  const handle = await lifecycle.start();

  try {
    return await body(handle);
  } finally {
    try {
      await lifecycle.inspect(handle);
    } catch (err) {
      note(`post-run inspection failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!opts.keep) {
      try {
        await lifecycle.remove(handle);
      } catch (err) {
        // Never let a failed cleanup replace the run's own error.
        note(`cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? '';
}

/**
 * Is `ref` an image the daemon has? "Could not tell" is an ERROR here and never a "no": a wrong "no"
 * quietly picks another image or attempts a pull that cannot work (see {@link imageState}).
 */
function imageIsLocal(ref: string): boolean {
  const seen = imageState(ref);

  if (seen.state === 'unknown') {
    throw new Error(
      `could not tell whether the image ${ref} is present locally (${seen.detail}). Not guessing: a wrong "absent" would ` +
        'swap it for another image or try to pull one that only exists here. Run this again once docker is answering.',
    );
  }

  return seen.state === 'present';
}

function pickImage(args: TestDbArgs, root: string): { ref: string; source: string; isLocal: boolean } {
  const choice = chooseImage({
    flag: args.image,
    // Not asked at all when --image names the image: the answer would not be used.
    localPresent: args.image === undefined && imageIsLocal(LOCAL_IMAGE),
    ciPin: () => parseCiDatabaseImage(fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8')),
  });

  return {
    ref: choice.ref,
    isLocal: choice.source === 'local',
    source:
      choice.source === 'flag' ? 'from --image' : choice.source === 'local' ? 'local dev image' : "CI's pin",
  };
}

export async function runTestDb(root: string, args: TestDbArgs): Promise<void> {
  const startedAt = Date.now();
  const summary: RunSummary = {
    skipCheck: 'not-reached',
    containerState: 'not-created',
    failures: [],
    problems: [],
  };
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-test-db-'));
  const reportPath = path.join(workDir, 'jest-report.json');
  const retryReportPath = path.join(workDir, 'jest-retry-report.json');
  let interrupted = false;

  // Ctrl-C, `kill <pid>`, and the terminal going away (SIGHUP) all mean the same
  // thing here: forward it to jest (runAsync does), stop, remove the container,
  // say so in the summary, exit nonzero.
  const onSignal = (): void => {
    interrupted = true;
  };

  for (const signal of TERMINATION_SIGNALS) {
    process.on(signal, onSignal);
  }

  // The backstop. Every normal path removes the container in withThrowaway's
  // finally, and startContainer removes what it created if it fails part-way;
  // this catches what neither can — a removal that itself failed, an id that was
  // never learned, or process.exit() from somewhere I did not write. It also
  // removes THIS run's work directory. See lib/backstop.ts for what it is owed
  // and why it lets go of a container only once its removal is confirmed.
  const backstop = new ExitBackstop({ keep: args.keep, workDir });
  const onExit = (): void => {
    backstop.sweep();
  };

  process.on('exit', onExit);

  try {
    if (!fs.existsSync(path.join(root, '.pnp.cjs'))) {
      throw new Error('Dependencies are not installed here (no .pnp.cjs). Run `make install` first.');
    }

    step('Checking Docker');

    const reachable = dockerReachable();

    if (!reachable.ok) {
      throw new Error(
        `Docker is not reachable (${reachable.detail}). Start Docker Desktop (or the Docker daemon) and run this again — ` +
          'test-db needs it to start a throwaway Postgres, and there is no fallback to any other database on purpose.',
      );
    }

    ok(`Docker ${reachable.detail} is up`);

    reapStaleContainers();

    const image = pickImage(args, root);

    summary.image = image.ref;
    summary.imageSource = image.source;

    // The local dev image was just found; anything else is looked for before it is pulled.
    if (!image.isLocal && !imageIsLocal(image.ref)) {
      step(`Pulling ${image.ref} (first run only)`);
      await runAsyncOrThrow('docker', ['pull', image.ref], { timeoutMs: PULL_TIMEOUT_MS });
    }

    info(`Image ${image.ref} (${image.source})`);

    const db = { appPassword: randomPassword(), adminPassword: randomPassword() };
    const name = newContainerName();
    const noDotenv = path.join(workDir, 'no-such.env');
    // The reaper's protection for a kept container is a label, and a label is fixed when the container is created.
    const keepUntil = args.keep ? Date.now() + (args.keepFor ?? DEFAULT_KEEP_FOR_MS) : undefined;

    await withThrowaway<StartedContainer, void>(
      {
        start: () => {
          step(`Starting a throwaway database (${name})`);

          const started = startContainer(image.ref, name, db.adminPassword, {
            keepUntil,
            onCreated: (c) => backstop.created(c),
            onRemoved: (c) => backstop.released(c),
            onUncertain: (n) => backstop.uncertainName(n),
          });

          backstop.claimed(started);
          summary.container = started.name;
          summary.containerState = 'kept'; // provisional: corrected once removal is confirmed

          return started;
        },

        inspect: (started) => {
          // Read the log BEFORE removal; it is the only witness to a crash restart.
          const log = containerLogs(started.name);
          const findings = findCrashSignatures(log);

          summary.sentinel = { findings, lines: log.split('\n').length };

          if (findings.length > 0) {
            summary.problems.push(
              `the database CRASHED or restarted during the run (${findings.length} log line(s))`,
            );
          }
        },

        remove: (started) => {
          const { failed } = removeContainers([justCreated(started)]);

          if (failed.length === 0) {
            backstop.released(started);
            summary.containerState = 'removed';
          } else {
            // Not confirmed gone, so the backstop still holds it; the sweep in the
            // finally below tries once more and settles this state either way.
            summary.containerState = 'REMOVAL FAILED';
          }
        },
      },
      { keep: args.keep },
      async (started) => {
        const ready = waitUntilReady(started.name, READY_TIMEOUT_MS);

        if (!ready.ready) {
          const log = containerLogs(started.name).trim().split('\n').slice(-15).join('\n');

          throw new Error(
            `the database did not become ready within ${formatDuration(READY_TIMEOUT_MS)}. Last log lines:\n${log}`,
          );
        }

        ok(`Ready on ${LOOPBACK}:${started.port} after ${formatDuration(ready.waitedMs)}`);

        step('Bootstrapping role, databases and extensions');

        // The application password goes in as a `\set` line on STDIN, ahead of the
        // shared file: never on a command line, where `ps` would show it.
        const bootstrap = fs.readFileSync(path.join(root, 'scripts/test-db/bootstrap.sql'), 'utf8');
        const boot = psql(started.name, 'postgres', {
          sql: `\\set app_password '${db.appPassword}'\n${bootstrap}`,
        });

        if (boot.status !== 0) {
          throw new Error(`bootstrap.sql failed:\n${boot.stderr.trim() || boot.stdout.trim()}`);
        }

        const pgVersion = psql(started.name, APP_DATABASE, { tuplesOnly: true, command: 'SELECT version()' });
        const tsdbVersion = psql(started.name, APP_DATABASE, {
          tuplesOnly: true,
          command: "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'",
        });

        summary.postgres = firstLine(pgVersion.stdout).split(' on ')[0];
        summary.timescaledb = firstLine(tsdbVersion.stdout);
        ok(`${summary.postgres}, timescaledb ${summary.timescaledb}`);

        // Everything below runs with the throwaway's environment and nothing else.
        const env = buildTestEnv(process.env, { port: started.port, ...db }, noDotenv);

        assertOnlyThrowaway(env, started.port);

        step('Migrating the throwaway database');

        const migrateStarted = Date.now();

        // Captured: `dbmate up` prints two lines per migration, several hundred
        // in all. A failure still shows the tail.
        await runAsyncOrThrow('yarn', ['workspace', API_WORKSPACE, 'migrate'], {
          cwd: root,
          env,
          capture: true,
          group: true,
        });
        await runAsyncOrThrow('yarn', ['workspace', API_WORKSPACE, 'pgboss:ensure'], {
          cwd: root,
          env,
          capture: true,
          group: true,
        });

        const applied = psql(started.name, APP_DATABASE, {
          tuplesOnly: true,
          command: 'SELECT count(*) FROM public.schema_migrations',
        });

        summary.migrations = firstLine(applied.stdout);
        ok(
          `${summary.migrations} migrations applied and the pg-boss schema created in ${formatDuration(Date.now() - migrateStarted)}`,
        );

        if (interrupted) {
          throw new Error('interrupted');
        }

        step('Running the jest suites');

        const jestArgs = [
          'workspace',
          API_WORKSPACE,
          'jest',
          '--ci',
          '--json',
          `--outputFile=${reportPath}`,
          ...(jestChoosesWorkers(args.jestArgs) ? [] : [`--maxWorkers=${args.workers}`]),
          ...args.jestArgs,
        ];
        // `group`: yarn is only a wrapper, and a signal that reaches it alone leaves jest and its workers running.
        const jest = await runAsync('yarn', jestArgs, { cwd: root, env, group: true });

        if (jest.interrupted) {
          throw new Error('interrupted');
        }

        if (!fs.existsSync(reportPath)) {
          throw new Error(
            `jest wrote no report (exit ${jest.status ?? jest.signal}) — it died before finishing; see its output above.`,
          );
        }

        const firstReport = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as JestReport;

        // Files that failed under parallel load are re-run once, serially, before
        // anything is called a failure. What the retry says is recorded per file.
        const failed = failedFiles(firstReport, root);
        const plan = planRetry(failed, { enabled: args.retry, interrupted });
        let report = firstReport;

        summary.failures = asUnretried(failed, plan.skipReason);
        summary.retrySkipped = plan.skipReason;

        if (plan.files.length > 0) {
          step(
            `Re-running ${plan.files.length} failed test file(s) once, serially, to tell flakes from real failures`,
          );

          const retry = await runAsync(
            'yarn',
            [
              'workspace',
              API_WORKSPACE,
              'jest',
              ...retryJestArgs(
                retryReportPath,
                plan.files.map((f) => f.file),
                args.jestArgs,
              ),
            ],
            { cwd: root, env, group: true },
          );

          if (retry.interrupted) {
            throw new Error('interrupted');
          }

          const retryReport = fs.existsSync(retryReportPath)
            ? (JSON.parse(fs.readFileSync(retryReportPath, 'utf8')) as JestReport)
            : null;

          summary.failures = classifyRetry(plan.files, retryReport);
          report = mergeRetryIntoReport(firstReport, retryReport, summary.failures);
        }

        // From here the report is the one with flakes set aside; a REAL or
        // UNRETRIED failure is still in it.
        summary.jest =
          `${report.numTotalTestSuites ?? '?'} suites (${report.numFailedTestSuites ?? 0} failed, ${report.numPendingTestSuites ?? 0} skipped), ` +
          `${report.numTotalTests ?? '?'} tests (${report.numPassedTests ?? 0} passed, ${report.numFailedTests ?? 0} failed, ` +
          `${report.numPendingTests ?? 0} skipped, ${report.numTodoTests ?? 0} todo)`;

        step('Checking the run: skips and failures');

        // The first run exits nonzero whenever a file failed in it. That is
        // accounted for as long as some file did; only a nonzero exit with NO
        // failed file to show for it is a mystery worth reporting.
        const exitUnexplained = jest.status !== 0 && failed.length === 0;

        if (jestFiltersByName(args.jestArgs)) {
          summary.skipCheck = 'off-because-name-filter';
          note(
            'A name filter (-t / --onlyChanged …) makes jest report every unselected test as skipped, so the no-skip check is off for this run.',
          );

          if (exitUnexplained) {
            summary.problems.push(`jest exited ${jest.status ?? jest.signal}`);
          }
        } else {
          const allowFile = path.join(root, 'scripts/test-db/allowed-skips.json');
          const allow: AllowedSkip[] = parseAllowList(JSON.parse(fs.readFileSync(allowFile, 'utf8')));
          const verdict = checkNoSkips(report, allow, undefined, path.join(root, 'backend/apps/api'));

          summary.skips = verdict;
          summary.skipCheck = 'ran';

          if (!verdict.ok) {
            summary.problems.push(...verdict.failures);
          } else if (exitUnexplained) {
            summary.problems.push(
              `jest exited ${jest.status ?? jest.signal} although its report shows no failure`,
            );
          }
        }

        if (keepUntil !== undefined) {
          printKept(started, db.appPassword, keepUntil);
        }
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    summary.problems.push(message);
  } finally {
    for (const signal of TERMINATION_SIGNALS) {
      process.off(signal, onSignal);
    }

    process.off('exit', onExit);

    const swept = backstop.sweep();

    if (swept.removed.length > 0) {
      note(`The final sweep removed ${swept.removed.join(', ')}`);
    }

    // The final word on the container: gone, or still held because docker would
    // not confirm it — and then the operator is told the command to run.
    if (summary.container !== undefined && summary.containerState !== 'kept') {
      const held = backstop.held();

      summary.containerState = held.length === 0 ? 'removed' : 'REMOVAL FAILED';

      if (held.length > 0) {
        summary.problems.push(
          `could not confirm ${held.join(', ')} was removed — run: docker rm -f -v ${held[0]}`,
        );
      }
    }
  }

  // A run that never got as far as starting a database has nothing to summarise;
  // a table of dashes above one real error would only bury it.
  if (summary.container === undefined) {
    if (summary.problems.length > 0) {
      throw new Error(summary.problems.join('\n'));
    }

    return;
  }

  const decision = decide({ problems: summary.problems, failures: summary.failures });

  printSummary(summary, decision, Date.now() - startedAt, interrupted);

  if (!decision.pass) {
    throw new Error(
      interrupted
        ? 'test-db was interrupted'
        : `test-db failed: ${[
            summary.problems.length > 0 ? `${summary.problems.length} problem(s)` : '',
            decision.blocking.length > 0 ? `${decision.blocking.length} test file(s) failed for good` : '',
          ]
            .filter(Boolean)
            .join(', ')} — see the summary above`,
    );
  }
}

function printKept(started: StartedContainer, appPassword: string, keepUntil: number): void {
  console.log('');

  for (const line of keptNotice(started.name, started.port, appPassword, keepUntil, Date.now())) {
    info(line);
  }
}

/** One line for the table: what the retry did. */
function retryRow(s: RunSummary, decision: Decision): string {
  if (s.failures.length === 0) {
    return 'not needed (no test file failed)';
  }

  if (s.retrySkipped !== undefined) {
    return `NOT RUN — ${s.retrySkipped}; ${s.failures.length} failed file(s) count as failures`;
  }

  const real = decision.blocking.length;

  return `${s.failures.length} failed file(s) re-run once, serially: ${decision.flakes.length} FLAKE, ${real} REAL`;
}

function printFailureBlocks(decision: Decision): void {
  if (decision.flakes.length > 0) {
    note(
      `WARNING — ${decision.flakes.length} FLAKE(S): failed the parallel run, PASSED when re-run serially. They do not fail this run, but they are not nothing:`,
    );

    for (const f of decision.flakes) {
      console.log(`    ⚠ ${f.display}\n        first error: ${f.firstError}`);
    }

    console.log('');
  }

  if (decision.blocking.length > 0) {
    fail(`${decision.blocking.length} test file(s) FAILED FOR GOOD:`);

    for (const f of decision.blocking) {
      const why = f.kind === 'real' ? 'failed again on the serial re-run' : 'not re-run';

      console.log(
        `    ✗ ${f.display} (${why}${f.note ? `: ${f.note}` : ''})\n        first error: ${f.firstError}`,
      );
    }

    console.log('');
  }
}

function printSummary(s: RunSummary, decision: Decision, durationMs: number, interrupted: boolean): void {
  console.log('');
  console.log('test-db summary');

  const rows: string[][] = [
    ['image', s.image ? `${s.image} (${s.imageSource})` : '—'],
    ['postgres', s.postgres ?? '—'],
    ['timescaledb', s.timescaledb ?? '—'],
    ['migrations applied', s.migrations ?? '—'],
    ['jest', s.jest ?? '—'],
  ];

  if (s.skipCheck === 'ran' && s.skips) {
    const files = new Set(s.skips.allowed.map((a) => a.file));

    rows.push([
      'skipped',
      s.skips.unexpected.length === 0
        ? `${s.skips.allowed.length} test(s) in ${files.size} file(s), all allowed with a reason; 0 unexplained`
        : `${s.skips.unexpected.length} UNEXPLAINED (and ${s.skips.allowed.length} allowed)`,
    ]);
  } else {
    rows.push([
      'skipped',
      s.skipCheck === 'off-because-name-filter'
        ? 'not checked (name filter in use)'
        : 'not checked (run did not finish)',
    ]);
  }

  rows.push(['retry', retryRow(s, decision)]);
  rows.push([
    'db crash sentinel',
    s.sentinel
      ? s.sentinel.findings.length === 0
        ? `clean (${s.sentinel.lines} log lines read)`
        : `TRIPPED (${s.sentinel.findings.length} line(s))`
      : 'not read',
  ]);
  rows.push(['duration', formatDuration(durationMs)]);
  rows.push(['container', `${s.container ?? '—'}: ${s.containerState}`]);
  table(['check', 'result'], rows);
  console.log('');

  if (s.skips && s.skips.allowed.length > 0) {
    console.log('Skipped, and allowed:');

    const seen = new Map<string, { count: number; reason: string }>();

    for (const a of s.skips.allowed) {
      const cur = seen.get(a.file) ?? { count: 0, reason: a.reason };

      seen.set(a.file, { count: cur.count + 1, reason: cur.reason });
    }

    for (const [file, { count, reason }] of [...seen].sort()) {
      console.log(`  · ${file} (${count}) — ${reason}`);
    }

    console.log('');
  }

  if (s.sentinel && s.sentinel.findings.length > 0) {
    console.log('Database crash evidence:');

    for (const line of formatFindings(s.sentinel.findings)) {
      console.log(`  ${line}`);
    }

    console.log('');
  }

  printFailureBlocks(decision);

  if (decision.pass) {
    ok(
      decision.flakes.length === 0
        ? 'test-db passed: every database-backed suite ran, nothing skipped without a reason, the database stayed up.'
        : `test-db passed WITH ${decision.flakes.length} FLAKE(S) (listed above): every database-backed suite ran and passed, ${decision.flakes.length} of them only on the serial re-run; nothing skipped without a reason, the database stayed up.`,
    );
  } else if (!interrupted) {
    for (const problem of s.problems) {
      fail(problem);
    }
  }

  console.log('');
}

export async function main(argv: string[]): Promise<void> {
  const args = parseTestDbArgs(argv);

  if (args.help) {
    console.log(HELP);

    return;
  }

  if (underTsxRelay()) {
    // Not a refusal: it works, and the stale-container reaper covers a leak. But say so BEFORE a container exists.
    note(TSX_RELAY_WARNING);
  }

  await runTestDb(process.cwd(), args);
}

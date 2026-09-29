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
 * success, failure, an exception, SIGINT and SIGTERM.
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
import {
  containerLogs,
  docker,
  dockerReachable,
  imagePresent,
  justCreated,
  listOurContainers,
  psql,
  removeContainers,
  startContainer,
  waitUntilReady,
  type CreatedContainer,
  type StartedContainer,
} from '../lib/docker';
import { runAsync, runAsyncOrThrow } from '../lib/exec';
import { findCrashSignatures, formatFindings, type CrashFinding } from '../lib/dbLogSentinel';
import {
  checkNoSkips,
  parseAllowList,
  type AllowedSkip,
  type JestReport,
  type NoSkipsResult,
} from '../lib/noSkips';
import {
  APP_DATABASE,
  LOOPBACK,
  STALE_AFTER_MS,
  assertOnlyThrowaway,
  buildTestEnv,
  chooseImage,
  formatDuration,
  jestChoosesWorkers,
  jestFiltersByName,
  newContainerName,
  parseCiDatabaseImage,
  parseTestDbArgs,
  randomPassword,
  selectStale,
  type TestDbArgs,
} from '../lib/testDb';

const HELP = `Usage: xtask test-db [flags] [jest path patterns...] [-- jest args...]

Run the database-backed jest suites against a throwaway Postgres container.

Flags:
  --keep           Leave the container running afterwards (prints how to connect).
                   The next run removes it once it is more than two hours old.
  --image <ref>    Database image. Default: the local ci/database:latest when present
                   (what 'make dev' runs), else the pin in .github/workflows/ci.yml.
  --workers <n>    Jest worker processes (default 4; the machine is often shared).
  --help, -h       This text.

Everything else is passed to jest: bare words are path patterns, and anything
after '--' is passed verbatim.

  make test-db                                     # the whole be-api suite
  make test-db ARGS='src/domains/import'           # one directory
  make test-db ARGS='-t revocation'                # a jest flag (the no-skip check is then off)
  make test-db KEEP=1 WORKERS=2 DB_IMAGE=my/db:1   # the flags above, as make variables

Every connection variable the suites read is pointed at the container, and
CI_REQUIRE_DB=1 is set, so a suite that cannot reach it fails rather than skips.
The run fails on: any jest failure, any skipped test that
scripts/test-db/allowed-skips.json does not forgive, and any crash signature in
the database's own log. Docker must be running.`;

const READY_TIMEOUT_MS = 120_000;
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

async function reapStale(): Promise<void> {
  const stale = selectStale(listOurContainers(), Date.now(), STALE_AFTER_MS);

  if (stale.length === 0) {
    ok('No stale test databases to reap');

    return;
  }

  const { removed, failed } = removeContainers(stale);

  note(
    `Removed ${removed.length} stale test database container(s) older than ${formatDuration(STALE_AFTER_MS)}: ${removed.join(', ')}`,
  );

  if (failed.length > 0) {
    note(`Could not remove: ${failed.join(', ')}`);
  }
}

function pickImage(args: TestDbArgs, root: string): { ref: string; source: string } {
  const choice = chooseImage({
    flag: args.image,
    localPresent: imagePresent('ci/database:latest'),
    ciPin: () => parseCiDatabaseImage(fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8')),
  });

  return {
    ref: choice.ref,
    source:
      choice.source === 'flag' ? 'from --image' : choice.source === 'local' ? 'local dev image' : "CI's pin",
  };
}

export async function runTestDb(root: string, args: TestDbArgs): Promise<void> {
  const startedAt = Date.now();
  const summary: RunSummary = { skipCheck: 'not-reached', containerState: 'not-created', problems: [] };
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-test-db-'));
  const reportPath = path.join(workDir, 'jest-report.json');
  let interrupted = false;

  const onSignal = (): void => {
    interrupted = true;
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  // The backstop. Every normal path removes the container in withThrowaway's
  // finally, and startContainer removes what it created if it fails part-way;
  // this catches what neither can — a removal that itself failed, or
  // process.exit() from somewhere I did not write. It is synchronous, which
  // 'exit' handlers must be.
  //
  // Two slots, because they are owed different things. `unclaimed` is a
  // container `docker run` has created that startContainer has not yet handed
  // back as a usable database: it is removed on exit even under --keep, since
  // "keep" is a promise about a working database and this is not one.
  // `liveContainer` is the working database, kept under --keep.
  let unclaimed: CreatedContainer | null = null;
  let liveContainer: StartedContainer | null = null;
  const removeOnExit = (): void => {
    for (const c of [unclaimed, args.keep ? null : liveContainer]) {
      if (c !== null) {
        docker(['rm', '-f', '-v', c.id], { timeoutMs: 30_000 });
      }
    }
  };

  process.on('exit', removeOnExit);

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

    await reapStale();

    const image = pickImage(args, root);

    summary.image = image.ref;
    summary.imageSource = image.source;

    if (!imagePresent(image.ref)) {
      step(`Pulling ${image.ref} (first run only)`);
      await runAsyncOrThrow('docker', ['pull', image.ref]);
    }

    info(`Image ${image.ref} (${image.source})`);

    const db = { appPassword: randomPassword(), adminPassword: randomPassword() };
    const name = newContainerName();
    const noDotenv = path.join(workDir, 'no-such.env');

    await withThrowaway<StartedContainer, void>(
      {
        start: () => {
          step(`Starting a throwaway database (${name})`);

          const started = startContainer(image.ref, name, db.adminPassword, {
            onCreated: (c) => {
              unclaimed = c;
            },
            onRemoved: () => {
              unclaimed = null;
            },
          });

          unclaimed = null;
          liveContainer = started;
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

          summary.containerState = failed.length === 0 ? 'removed' : 'REMOVAL FAILED';

          if (failed.length === 0) {
            liveContainer = null;
          } else {
            summary.problems.push(`could not remove ${started.name} — run: docker rm -f -v ${started.name}`);
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
        });
        await runAsyncOrThrow('yarn', ['workspace', API_WORKSPACE, 'pgboss:ensure'], {
          cwd: root,
          env,
          capture: true,
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
        const jest = await runAsync('yarn', jestArgs, { cwd: root, env });

        if (jest.interrupted) {
          throw new Error('interrupted');
        }

        if (!fs.existsSync(reportPath)) {
          throw new Error(
            `jest wrote no report (exit ${jest.status ?? jest.signal}) — it died before finishing; see its output above.`,
          );
        }

        const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as JestReport;

        summary.jest =
          `${report.numTotalTestSuites ?? '?'} suites (${report.numFailedTestSuites ?? 0} failed, ${report.numPendingTestSuites ?? 0} skipped), ` +
          `${report.numTotalTests ?? '?'} tests (${report.numPassedTests ?? 0} passed, ${report.numFailedTests ?? 0} failed, ` +
          `${report.numPendingTests ?? 0} skipped, ${report.numTodoTests ?? 0} todo)`;

        step('Checking the run: skips and failures');

        if (jestFiltersByName(args.jestArgs)) {
          summary.skipCheck = 'off-because-name-filter';
          note(
            'A name filter (-t / --onlyChanged …) makes jest report every unselected test as skipped, so the no-skip check is off for this run.',
          );

          if (jest.status !== 0) {
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
          } else if (jest.status !== 0) {
            summary.problems.push(
              `jest exited ${jest.status ?? jest.signal} although its report shows no failure`,
            );
          }
        }

        if (args.keep) {
          printKept(started, db.appPassword);
        }
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    summary.problems.push(message);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('exit', removeOnExit);
    removeOnExit();

    fs.rmSync(workDir, { recursive: true, force: true });
  }

  // A run that never got as far as starting a database has nothing to summarise;
  // a table of dashes above one real error would only bury it.
  if (summary.container === undefined) {
    if (summary.problems.length > 0) {
      throw new Error(summary.problems.join('\n'));
    }

    return;
  }

  printSummary(summary, Date.now() - startedAt, interrupted);

  if (summary.problems.length > 0) {
    throw new Error(
      interrupted
        ? 'test-db was interrupted'
        : `test-db failed: ${summary.problems.length} problem(s) — see the summary above`,
    );
  }
}

function printKept(started: StartedContainer, appPassword: string): void {
  console.log('');
  info(`Kept ${started.name} on ${LOOPBACK}:${started.port} (throwaway; loopback only).`);
  info(`  psql as superuser:  docker exec -it ${started.name} psql -U postgres -d ${APP_DATABASE}`);
  info(
    `  application URL:    postgres://companion:${appPassword}@${LOOPBACK}:${started.port}/${APP_DATABASE}?sslmode=disable`,
  );
  info(`  remove it:          docker rm -f -v ${started.name}`);
  info('  (the next `make test-db` removes it anyway once it is more than two hours old)');
}

function printSummary(s: RunSummary, durationMs: number, interrupted: boolean): void {
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

  if (s.problems.length === 0) {
    ok(
      'test-db passed: every database-backed suite ran, nothing skipped without a reason, the database stayed up.',
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

  await runTestDb(process.cwd(), args);
}

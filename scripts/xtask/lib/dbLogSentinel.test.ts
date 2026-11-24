import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findCrashSignatures, formatFindings } from './dbLogSentinel';

// The shapes below are copied from real Postgres 18 logs, including the ones
// from the 2026-09-28 incident: `[1]` is the postmaster as PID 1, which is
// exactly the no-init condition the sentinel exists to catch.
const INCIDENT = `
2026-09-28 20:11:21.900 UTC [1] LOG:  untracked child process (PID 45672) exited with exit code 2
2026-09-28 20:11:21.901 UTC [1] LOG:  terminating any other active server processes
2026-09-28 20:11:21.910 UTC [1] LOG:  all server processes terminated; reinitializing
2026-09-28 20:11:22.150 UTC [46000] LOG:  database system was interrupted; last known up at 2026-09-28 20:09:00 UTC
2026-09-28 20:11:22.900 UTC [46000] LOG:  database system was not properly shut down; automatic recovery in progress
2026-09-28 20:11:23.100 UTC [46001] FATAL:  the database system is in recovery mode
`.trim();

const ids = (log: string) => findCrashSignatures(log).map((f) => f.signature);

test('the 2026-09-28 incident log trips the sentinel, with each line named by what it is', () => {
  assert.deepEqual(ids(INCIDENT), [
    'untracked-child',
    'terminating-other-processes',
    'reinitializing',
    'crash-recovery',
    'in-recovery',
  ]);
});

// Captured from a REAL crash-restart of the appliance's Postgres 18.6 container:
// `kill -9` on a backend, 2026-09-29. The wording is the server's, not ours.
const REAL_KILL_9 = `
2026-09-29 04:34:55.675 UTC [71] FATAL:  terminating background worker "TimescaleDB Background Worker Launcher" due to administrator command
2026-09-29 04:34:58.016 UTC [7] LOG:  client backend (PID 109) was terminated by signal 9: Killed
2026-09-29 04:34:58.016 UTC [7] LOG:  terminating any other active server processes
2026-09-29 04:34:58.017 UTC [7] LOG:  all server processes terminated; reinitializing
2026-09-29 04:34:58.069 UTC [127] LOG:  database system was not properly shut down; automatic recovery in progress
2026-09-29 04:34:58.072 UTC [128] LOG:  checkpoint starting: end-of-recovery immediate wait
`.trim();

test('a real kill -9 of a backend, as Postgres 18 logged it, trips the sentinel — and its unrelated administrator-command line does not', () => {
  assert.deepEqual(ids(REAL_KILL_9), [
    'terminated-by-signal',
    'terminating-other-processes',
    'reinitializing',
    'crash-recovery',
  ]);
});

test('the literal shapes from the task: untracked child, terminating others', () => {
  assert.deepEqual(ids('[1] LOG:  untracked child process (PID 45672) exited with exit code 2'), [
    'untracked-child',
  ]);
  assert.deepEqual(ids('[1] LOG:  terminating any other active server processes'), [
    'terminating-other-processes',
  ]);
});

test('a backend or worker killed by a signal is a crash, in both the old and new wording', () => {
  assert.deepEqual(
    ids('2026-09-28 20:11:21.800 UTC [1] LOG:  client backend (PID 812) was terminated by signal 9: Killed'),
    ['terminated-by-signal'],
  );
  assert.deepEqual(
    ids(
      '2026-09-28 20:11:21.800 UTC [7] LOG:  server process (PID 812) was terminated by signal 11: Segmentation fault',
    ),
    ['terminated-by-signal'],
  );
  assert.deepEqual(
    ids(
      '[7] LOG:  background worker "TimescaleDB Background Worker Scheduler" (PID 88) was terminated by signal 11: Segmentation fault',
    ),
    ['terminated-by-signal'],
  );
});

test('a server process that exited abnormally is a crash', () => {
  assert.deepEqual(ids('[7] LOG:  server process (PID 5123) exited with exit code 3'), [
    'server-process-exited',
  ]);
});

test('PANIC at the PANIC level trips it, whatever the message says', () => {
  assert.deepEqual(
    ids(
      '2026-09-28 20:11:21.800 UTC [812] PANIC:  could not write to file "pg_wal/xlogtemp.812": No space left on device',
    ),
    ['panic'],
  );
});

test('the session-side messages of a crash restart trip it too', () => {
  assert.deepEqual(
    ids(
      '[900] WARNING:  terminating connection because of crash of another server process\n' +
        '[900] DETAIL:  The postmaster has commanded this server process to roll back the current transaction and exit',
    ),
    ['crash-of-another-process'],
  );
});

test('a healthy log — startup, a clean shutdown, ordinary errors — trips nothing', () => {
  const healthy = `
2026-09-29 04:14:28.815 UTC [7] LOG:  starting PostgreSQL 18.6 (Debian 18.6-1.pgdg12+2) on aarch64-unknown-linux-gnu
2026-09-29 04:14:28.815 UTC [7] LOG:  listening on IPv4 address "0.0.0.0", port 5432
2026-09-29 04:14:28.819 UTC [79] LOG:  database system was shut down at 2026-09-29 04:14:28 UTC
2026-09-29 04:14:28.822 UTC [7] LOG:  database system is ready to accept connections
2026-09-29 04:14:28.825 UTC [82] LOG:  TimescaleDB background worker launcher connected to shared catalogs
2026-09-29 04:20:01.100 UTC [120] ERROR:  duplicate key value violates unique constraint "users_email_key"
2026-09-29 04:20:01.100 UTC [120] STATEMENT:  INSERT INTO ci.users (id, email) VALUES ($1, $2)
2026-09-29 04:31:10.000 UTC [7] LOG:  received fast shutdown request
2026-09-29 04:31:10.010 UTC [7] LOG:  aborting any active transactions
2026-09-29 04:31:10.050 UTC [7] LOG:  database system is shut down
`.trim();

  assert.deepEqual(findCrashSignatures(healthy), []);
});

test('deliberate backend kills (pg_terminate_backend, DROP DATABASE ... FORCE) are not crashes', () => {
  assert.deepEqual(
    ids(
      '[300] FATAL:  terminating connection due to administrator command\n' +
        '[300] STATEMENT:  SELECT pg_terminate_backend(pid) FROM pg_stat_activity\n' +
        '[301] ERROR:  canceling statement due to user request',
    ),
    [],
  );
});

test('a scratch database being dropped stops its TimescaleDB scheduler with exit code 1, which is normal', () => {
  assert.deepEqual(
    ids(
      '2026-09-29 04:20:09.500 UTC [7] LOG:  background worker "TimescaleDB Background Worker Scheduler" (PID 431) exited with exit code 1',
    ),
    [],
  );
});

test('the text of a signature inside a statement is not evidence — only leveled log messages count', () => {
  const echo = [
    '2026-09-29 04:20:01.100 UTC [120] ERROR:  value too long for type character varying(10)',
    "2026-09-29 04:20:01.100 UTC [120] STATEMENT:  INSERT INTO t (note) VALUES ('terminating any other active server processes')",
    "\tSELECT 'untracked child process (PID 1) exited with exit code 2',",
    "\t       'was terminated by signal 9'",
  ].join('\n');

  assert.deepEqual(findCrashSignatures(echo), []);
});

test('a PANIC-looking word in an ordinary message is not a PANIC', () => {
  assert.deepEqual(ids("[1] LOG:  statement: SELECT 'PANIC: not a real one'"), []);
});

test('line numbers are 1-based positions in the log, and text is trimmed', () => {
  const [f] = findCrashSignatures(
    `[1] LOG:  ready\n   [1] LOG:  terminating any other active server processes   `,
  );

  assert.equal(f.line, 2);
  assert.equal(f.text, '[1] LOG:  terminating any other active server processes');
});

test('an allowed pattern suppresses its own lines only', () => {
  const allowed = [{ pattern: /PID 45672/, reason: 'test' }];

  assert.deepEqual(
    findCrashSignatures(INCIDENT, allowed).map((f) => f.signature),
    ['terminating-other-processes', 'reinitializing', 'crash-recovery', 'in-recovery'],
  );
});

test('formatFindings groups by signature, shows the first few lines and counts the rest', () => {
  const lines = Array.from(
    { length: 5 },
    (_, i) => `[1] LOG:  untracked child process (PID ${100 + i}) exited with exit code 2`,
  );
  const out = formatFindings(findCrashSignatures(lines.join('\n')));

  assert.match(out[0], /^untracked-child x5/);
  assert.equal(out.filter((l) => l.startsWith('    log line')).length, 3);
  assert.match(out[out.length - 1], /and 2 more/);
});

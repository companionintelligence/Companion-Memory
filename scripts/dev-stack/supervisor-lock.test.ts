import assert from 'node:assert/strict';
import { test } from 'node:test';

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
  LOCK_FILE,
  acquireSupervisorLock,
  isHolderLive,
  liveStackMessage,
  parseHolder,
  readLiveHolder,
  socketIsLive,
  type ProcessProbe,
} from './supervisor-lock';

const SUPERVISOR = 'node --import tsx scripts/dev-stack/index.ts up --key ci-server-x';

function probe(alive: boolean, command: string | null): ProcessProbe {
  return { alive: () => alive, command: () => command };
}

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dev-stack-lock-'));
}

function writeLock(root: string, holder: object | string): void {
  fs.writeFileSync(path.join(root, LOCK_FILE), typeof holder === 'string' ? holder : JSON.stringify(holder));
}

const OTHER = { pid: 424242, key: 'ci-server-x', startedAt: '2026-09-29T19:00:00.000Z' };

test('acquire on a free worktree writes our pid, and release removes it', () => {
  const root = tempRoot();
  const lock = acquireSupervisorLock(root, 'ci-server-x', probe(false, null));

  assert.equal(lock.acquired, true);
  assert.equal(parseHolder(fs.readFileSync(path.join(root, LOCK_FILE), 'utf8'))?.pid, process.pid);

  if (lock.acquired) {
    lock.release();
  }

  assert.equal(fs.existsSync(path.join(root, LOCK_FILE)), false);
});

test('a live supervisor keeps the lock, and its file is left alone', () => {
  const root = tempRoot();
  writeLock(root, OTHER);

  const lock = acquireSupervisorLock(root, 'ci-server-x', probe(true, SUPERVISOR));

  assert.deepEqual(lock, { acquired: false, holder: OTHER });
  assert.equal(parseHolder(fs.readFileSync(path.join(root, LOCK_FILE), 'utf8'))?.pid, OTHER.pid);
});

test('a lock whose supervisor died (kill -9) is stale and taken over', () => {
  const root = tempRoot();
  writeLock(root, OTHER);

  const lock = acquireSupervisorLock(root, 'ci-server-x', probe(false, null));

  assert.equal(lock.acquired, true);
  assert.equal(parseHolder(fs.readFileSync(path.join(root, LOCK_FILE), 'utf8'))?.pid, process.pid);
});

test('a pid the OS has reused for something else does not hold the worktree', () => {
  assert.equal(isHolderLive(OTHER, probe(true, '/usr/bin/vim notes.md')), false);
});

test('an unreadable command line counts as live: refusing is recoverable, two supervisors are not', () => {
  assert.equal(isHolderLive(OTHER, probe(true, null)), true);
});

test('a garbage lock file is stale', () => {
  const root = tempRoot();
  writeLock(root, 'not json');

  assert.equal(readLiveHolder(root, probe(true, SUPERVISOR)), null);
  assert.equal(acquireSupervisorLock(root, 'ci-server-x', probe(true, SUPERVISOR)).acquired, true);
});

test('release never deletes a lock another supervisor has since taken', () => {
  const root = tempRoot();
  const lock = acquireSupervisorLock(root, 'ci-server-x', probe(false, null));
  writeLock(root, OTHER);

  if (lock.acquired) {
    lock.release();
  }

  assert.equal(parseHolder(fs.readFileSync(path.join(root, LOCK_FILE), 'utf8'))?.pid, OTHER.pid);
});

test('socketIsLive: a listening socket is live; a missing or dead one is not', async () => {
  const root = tempRoot();
  const sock = path.join(root, 's.sock');

  assert.equal(await socketIsLive(sock), false);

  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(sock, resolve));
  assert.equal(await socketIsLive(sock), true);
  await new Promise<void>((resolve) => server.close(() => resolve()));

  // What a crashed overmind leaves: the path exists, nothing answers.
  fs.writeFileSync(sock, '');
  assert.equal(await socketIsLive(sock), false);
});

test('liveStackMessage names the pid when there is a lock, the socket when there is not', () => {
  assert.match(liveStackMessage(OTHER, '.overmind.sock'), /pid 424242.*kill -INT 424242/);
  assert.match(liveStackMessage(null, '.overmind.sock'), /OVERMIND_SOCKET=\.overmind\.sock overmind quit/);
});

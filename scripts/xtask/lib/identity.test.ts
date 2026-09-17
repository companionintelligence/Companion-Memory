import assert from 'node:assert/strict';
import { test } from 'node:test';

import { projectNameFor, repoStemFromUrl } from './identity';

test('repoStemFromUrl strips a .git suffix off an SSH remote', () => {
  assert.equal(repoStemFromUrl('git@github.com:companionintelligence/CI-Server.git'), 'CI-Server');
});

test('repoStemFromUrl strips a .git suffix off an HTTPS remote', () => {
  assert.equal(repoStemFromUrl('https://github.com/companionintelligence/CI-Server.git'), 'CI-Server');
});

test('repoStemFromUrl leaves a remote with no .git suffix alone', () => {
  assert.equal(repoStemFromUrl('https://github.com/companionintelligence/CI-Server'), 'CI-Server');
});

test('repoStemFromUrl returns empty for an empty remote', () => {
  assert.equal(repoStemFromUrl(''), '');
});

test('projectNameFor: the main checkout gets the bare repo name', () => {
  assert.equal(projectNameFor('/home/dev/ci-server', '/home/dev/ci-server', 'ci-server'), 'ci-server');
});

test('projectNameFor: a linked worktree gets repo-<lowercased dir basename>', () => {
  // The worktree's own directory is just "feat-Foo" — the pre-port Makefile's comment
  // gives exactly this shape as its example ("ci-server-feat-a").
  assert.equal(
    projectNameFor('/home/dev/worktrees/feat-Foo', '/home/dev/ci-server', 'ci-server'),
    'ci-server-feat-foo',
  );
});

test('projectNameFor: an unknown worktree root (empty mainRoot lookup failed) falls back to bare repo', () => {
  assert.equal(projectNameFor('', '/home/dev/ci-server', 'ci-server'), 'ci-server');
});

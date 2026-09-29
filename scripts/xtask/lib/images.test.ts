import assert from 'node:assert/strict';
import { test } from 'node:test';

import { execFileSync } from 'node:child_process';

import { contextStamp, versionedTagArgs } from './images';

test('versionedTagArgs is empty when there is no tag', () => {
  assert.deepEqual(versionedTagArgs('ci/api', ''), []);
});

test('versionedTagArgs adds -t repo:tag when a tag is present', () => {
  assert.deepEqual(versionedTagArgs('ci/api', 'v1.2.3'), ['-t', 'ci/api:v1.2.3']);
});

test("contextStamp is git's tree hash for the directory at HEAD", () => {
  const root = process.cwd();
  const want = execFileSync('git', ['rev-parse', 'HEAD:infrastructure/object-store'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();

  assert.match(want, /^[0-9a-f]{40,64}$/);
  assert.equal(contextStamp(root, 'infrastructure/object-store'), want);
});

test('contextStamp is empty, not an echoed revision, for a directory not in HEAD', () => {
  assert.equal(contextStamp(process.cwd(), 'infrastructure/no-such-dir'), '');
});

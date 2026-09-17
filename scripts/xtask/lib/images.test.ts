import assert from 'node:assert/strict';
import { test } from 'node:test';

import { versionedTagArgs } from './images';

test('versionedTagArgs is empty when there is no tag', () => {
  assert.deepEqual(versionedTagArgs('ci/api', ''), []);
});

test('versionedTagArgs adds -t repo:tag when a tag is present', () => {
  assert.deepEqual(versionedTagArgs('ci/api', 'v1.2.3'), ['-t', 'ci/api:v1.2.3']);
});

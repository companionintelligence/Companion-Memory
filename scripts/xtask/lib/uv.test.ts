import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseUvVersion } from './uv';

test('parseUvVersion reads the pin out of [tool.uv]', () => {
  const toml = `[tool.uv]\nrequired-version = "==0.9.17"\n\n[tool.uv.workspace]\nmembers = []\n`;

  assert.equal(parseUvVersion(toml), '0.9.17');
});

test('parseUvVersion returns empty when the field is absent', () => {
  assert.equal(parseUvVersion('[tool.uv.workspace]\nmembers = []\n'), '');
});

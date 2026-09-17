/**
 * uv — the uv version pin, read from `required-version` in the root
 * pyproject.toml. Mirrors the pre-port Makefile's
 * `sed -n 's/^required-version = "==\(.*\)"$/\1/p' pyproject.toml`.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Pure: takes the file content directly so it's testable without disk I/O. */
export function parseUvVersion(pyprojectToml: string): string {
  const match = pyprojectToml.match(/^required-version = "==(.*)"$/m);

  return match?.[1] ?? '';
}

export function readUvVersion(root: string): string {
  return parseUvVersion(fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf8'));
}

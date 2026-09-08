/**
 * license — the distribute/clean pair `build` runs around every image build.
 * Mirrors Makefile:63-67 (LICENSE_DIRS) and the `distribute-license`/
 * `clean-license` PHONY targets it fed (Makefile:397-407), now inlined here
 * since `build` was their only caller.
 *
 * Images built from the repo root (api, gateway, summary, hbpe) read
 * LICENSE.md directly from the build context and need no copy; these four
 * subdirectory contexts do not see the repo root at all, so a copy has to
 * land inside each one first.
 */
import fs from 'node:fs';
import path from 'node:path';

export const LICENSE_DIRS = [
  'infrastructure/database',
  'infrastructure/object-store',
  'infrastructure/setup-database',
  'infrastructure/setup-secrets',
];

export function distributeLicense(root: string): void {
  for (const dir of LICENSE_DIRS) {
    fs.copyFileSync(path.join(root, 'LICENSE.md'), path.join(root, dir, 'LICENSE.md'));
  }
}

export function cleanLicense(root: string): void {
  for (const dir of LICENSE_DIRS) {
    fs.rmSync(path.join(root, dir, 'LICENSE.md'), { force: true });
  }
}

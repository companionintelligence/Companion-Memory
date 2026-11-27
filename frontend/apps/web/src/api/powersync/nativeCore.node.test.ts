/**
 * The phone apps run two halves of PowerSync that are versioned in different places:
 *
 * - The JavaScript SDK (`@powersync/common` / `@powersync/web`, and `@powersync/capacitor`'s
 *   adapter) is bundled into the web build, from this workspace's lockfile.
 * - The native plugin, which loads the PowerSync core SQLite extension into the replica, comes
 *   from each shell's own lockfile (`frontend/apps/{android,ios}/yarn.lock`), because those two
 *   apps sit outside the Yarn workspaces.
 *
 * The core decides the replica's schema. Core 0.5 (bundled from `@powersync/capacitor` 0.8.1 on)
 * dropped `ps_buckets.target_op` and the `$local` bucket, but `@powersync/common` 1.x still reads
 * them after every upload (`SqliteBucketStorage.updateLocalTarget`). #3352 moved only the shells
 * to 0.9.4 (core 0.5.3), and from then on every phone's upload loop failed with "no such column:
 * target_op" every few seconds and never asked for a write checkpoint.
 *
 * So the core a shell bundles must be one the bundled SDK was written for. This reads the
 * versions each side resolves and fails when they part.
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const APPS = path.resolve(process.cwd(), '..');
const WORKSPACE_ROOT = path.resolve(APPS, '..', '..');

/**
 * The newest `@powersync/capacitor` whose native half bundles core 0.4.x, the line the 1.x SDK
 * reads: 0.5.x to 0.8.0 all ship 0.4.12 (their `powerSyncCoreVersion` / podspec), 0.8.1 ships 0.5.2.
 * 0.8.0 already wants `@powersync/web` 2.x, so 0.7.x is the newest one this SDK can run on.
 */
const NEWEST_CORE_04_PLUGIN: [number, number, number] = [0, 8, 0];

function lockedVersion(lockfile: string, pkg: string): string {
  const text = fs.readFileSync(lockfile, 'utf8');
  const escaped = pkg.replace(/[/@]/g, (c) => `\\${c}`);
  const match = new RegExp(`^"${escaped}@npm:[^"]*":\\n {2}version: (\\S+)`, 'm').exec(text);

  if (!match) {
    throw new Error(`${pkg} is not in ${lockfile}`);
  }

  return match[1];
}

function parse(version: string): [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map((part) => Number.parseInt(part, 10));

  return [major, minor, patch];
}

function atMost(version: string, limit: [number, number, number]): boolean {
  const v = parse(version);

  for (let i = 0; i < 3; i += 1) {
    if (v[i] !== limit[i]) {
      return v[i] < limit[i];
    }
  }

  return true;
}

describe('PowerSync on the phones: native core and bundled SDK', () => {
  const common = lockedVersion(path.join(WORKSPACE_ROOT, 'yarn.lock'), '@powersync/common');

  it('the web build bundles the 1.x SDK this pin is about', () => {
    // Moving to @powersync/common 2.x (and @powersync/web 2.x) is the upgrade that lets the shells
    // take a core-0.5 plugin. Do both together and rewrite this test with them.
    expect(parse(common)[0]).toBe(1);
  });

  it.each(['android', 'ios'])('the %s shell bundles a core the 1.x SDK reads (0.4.x)', (shell) => {
    const plugin = lockedVersion(path.join(APPS, shell, 'yarn.lock'), '@powersync/capacitor');

    expect(atMost(plugin, NEWEST_CORE_04_PLUGIN), `@powersync/capacitor ${plugin} in ${shell}`).toBe(true);
  });
});

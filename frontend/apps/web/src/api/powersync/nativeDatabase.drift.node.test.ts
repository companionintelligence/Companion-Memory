/**
 * `EncryptedCapacitorSQLiteAdapter` carries a copy of the vendored adapter's
 * `init()` with the two connection lines changed (see nativeDatabase.ts). That
 * copy is correct for exactly the adapter version it was taken from. This pins
 * the vendored body, so bumping `@powersync/capacitor` fails here first and the
 * copy gets re-read against the new original instead of drifting in silence.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { expect, test } from 'vitest';

/** sha256 of the `async init() {…}` method text in dist/esm/adapter/CapacitorSQLiteAdapter.js, 0.5.3. */
const PINNED_INIT_SHA256 = 'e5994d6cd86b02a2f91b271a115dec1f370e16c7ec5dadc7b9c4754212d7525f';
const PINNED_VERSION = '0.5.3';

function vendoredAdapter(): { version: string; initSha256: string } {
  const require = createRequire(path.join(process.cwd(), 'package.json'));
  // The package's `exports` map only exposes ".", so resolve the entry and walk
  // from its dist/ directory to the ESM source Vite bundles.
  const entry = require.resolve('@powersync/capacitor');
  const dist = entry.includes(`${path.sep}dist${path.sep}`)
    ? entry.slice(0, entry.indexOf(`${path.sep}dist${path.sep}`) + 5)
    : path.dirname(entry);
  const adapterFile = path.join(dist, 'esm', 'adapter', 'CapacitorSQLiteAdapter.js');
  const text = fs.readFileSync(adapterFile, 'utf8');
  const init = text.match(/\n {4}async init\(\) \{[\s\S]*?\n {4}\}\n/);

  if (!init) {
    throw new Error(`could not find init() in ${adapterFile}`);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(dist, '..', 'package.json'), 'utf8')) as {
    version: string;
  };

  return { version: pkg.version, initSha256: createHash('sha256').update(init[0]).digest('hex') };
}

test('the vendored @powersync/capacitor init() is the one EncryptedCapacitorSQLiteAdapter copies', () => {
  const { version, initSha256 } = vendoredAdapter();

  expect(
    { version, initSha256 },
    'The adapter changed. Re-read CapacitorConnectionPool.init() in @powersync/capacitor against ' +
      'encryptedInit() in nativeDatabase.ts, port any difference, then update the pinned version and hash here.',
  ).toEqual({ version: PINNED_VERSION, initSha256: PINNED_INIT_SHA256 });
});

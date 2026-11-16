import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  appVersion,
  decidePhones,
  desktopPlan,
  lastPhoneTag,
  windowsVersion,
} from './release/release-plan.mjs';

test('apps take the server version, three numbers at most', () => {
  assert.equal(appVersion('v2026.11.17'), '2026.11.17');
  assert.equal(appVersion('2026.11.17.1'), '2026.11.17');
  assert.equal(appVersion('0.1.10'), '0.1.10');
  assert.equal(appVersion('2026.11'), '2026.11.0');
});

test('Windows installer version fits MSI limits', () => {
  assert.equal(windowsVersion('2026.11.17'), '26.11.17');
  assert.equal(windowsVersion('2026.11.17.1'), '26.11.17.1');
  assert.equal(windowsVersion('2026.1.5'), '26.1.5');
  assert.equal(windowsVersion('0.1.10'), '');
  assert.throws(() => windowsVersion('3000.1.1'), /doesn't fit/);
});

test('desktop plan: Tauri version, release tag and Windows version', () => {
  assert.deepEqual(desktopPlan('2026.11.17.1'), {
    version: '2026.11.17.1',
    name: '2026.11.17',
    tag: 'desktop-v2026.11.17.1',
    windows_version: '26.11.17.1',
  });
  assert.deepEqual(desktopPlan('0.1.11'), {
    version: '0.1.11',
    name: '0.1.11',
    tag: 'desktop-v0.1.11',
    windows_version: '',
  });
  assert.deepEqual(desktopPlan('0.2.0-beta'), {
    version: '0.2.0-beta',
    name: '0.2.0-beta',
    tag: 'desktop-v0.2.0-beta',
    windows_version: '',
  });
});

test('last phone tag ignores the old numbering and newer releases', () => {
  const tags = [
    'mobile-v0.1.0-appstoreprep-1',
    'mobile-v2026.11.10',
    'mobile-v2026.11.17',
    'mobile-v2026.11.20',
    '',
  ];
  assert.equal(lastPhoneTag(tags, '2026.11.18'), 'mobile-v2026.11.17');
  assert.equal(lastPhoneTag(tags, '2026.11.17'), 'mobile-v2026.11.17');
  assert.equal(lastPhoneTag(['mobile-v0.1.0-test'], '2026.11.18'), null);
});

test('phones build only when something they contain changed', () => {
  const base = { version: '2026.11.18', lastTag: 'mobile-v2026.11.17' };
  assert.equal(decidePhones({ ...base, mode: 'auto', changedFiles: [] }).build, false);
  assert.equal(
    decidePhones({ ...base, mode: 'auto', changedFiles: ['frontend/apps/web/src/a.tsx'] }).build,
    true,
  );
  assert.equal(decidePhones({ ...base, mode: 'always', changedFiles: [] }).build, true);
  assert.equal(decidePhones({ ...base, mode: 'skip', changedFiles: ['x'] }).build, false);
  assert.equal(
    decidePhones({ mode: 'auto', version: '2026.11.18', lastTag: null, changedFiles: [] }).build,
    true,
  );
});

test('a re-cut that rebuilds the phones warns about the App Store', () => {
  const plan = decidePhones({
    mode: 'auto',
    version: '2026.11.17.1',
    lastTag: 'mobile-v2026.11.17',
    changedFiles: ['frontend/apps/ios/x'],
  });
  assert.equal(plan.build, true);
  assert.match(plan.reason, /App Store refuses it if 2026\.11\.17 is already live/);
});

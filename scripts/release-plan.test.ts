import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  appVersion,
  compareVersions,
  decidePhones,
  desktopPlan,
  lastPhoneTag,
  PHONE_PATHS,
  phonesPlan,
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

test('pre-releases sort before the release they lead up to', () => {
  assert.equal(compareVersions('0.3.14-rc1', '0.3.14'), -1);
  assert.equal(compareVersions('0.3.14', '0.3.14-rc1'), 1);
  assert.equal(compareVersions('0.3.14-rc2', '0.3.14-rc1'), 1);
  assert.equal(compareVersions('2026.11.11.1', '2026.11.11'), 1);
  assert.equal(compareVersions('1.6.2', '1.6.10'), -1);
});

test('an old-style re-cut still gets its own Windows installer version', () => {
  assert.equal(windowsVersion('0.1.10.1'), '0.1.10.1');
  assert.equal(windowsVersion('0.1.10'), '');
});

test('phonesPlan reads tags and the diff through the git runner it is given', () => {
  const calls: string[][] = [];
  const fakeGit = (args: string[]) => {
    calls.push(args);
    if (args[0] === 'tag') {
      return 'mobile-v0.1.0-test\nmobile-v2026.11.17\n';
    }

    return args.includes('yarn.lock') ? 'yarn.lock\n' : '';
  };

  const plan = phonesPlan('v2026.11.18', 'auto', fakeGit);
  assert.equal(plan.build, true);
  assert.equal(plan.last_tag, 'mobile-v2026.11.17');
  assert.equal(plan.app_version, '2026.11.18');
  assert.deepEqual(calls[1].slice(0, 4), ['diff', '--name-only', 'mobile-v2026.11.17', 'v2026.11.18']);
  assert.ok(PHONE_PATHS.includes('yarn.lock') && PHONE_PATHS.includes('package.json'));
});

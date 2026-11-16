#!/usr/bin/env node
// Version numbers and the phone-app decision for one Memory release. release.yml and
// desktop-release.yml call it; scripts/release-plan.test.ts covers the rules.
//
//   node scripts/release/release-plan.mjs desktop 2026.11.17.1
//   node scripts/release/release-plan.mjs phones v2026.11.17 auto
//
// Both print key=value lines for $GITHUB_OUTPUT.
//
// The desktop and phone apps carry the server's version: server 2026.11.17 ships Memory Desktop
// 2026.11.17 and phone apps 2026.11.17, so the number on an app says which server release it
// was built from.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// What the phone apps contain: the web build (frontend/apps/web and the frontend packages it
// imports) inside the Capacitor shells, plus the workflow that builds them. A release that
// changes none of these would ship the same phone app under a new number.
export const PHONE_PATHS = [
  'frontend/apps/web',
  'frontend/packages',
  'frontend/apps/android',
  'frontend/apps/ios',
  '.github/workflows/mobile-release.yml',
];

// release.yml tags the commit a phone release was built from as mobile-v<server version>.
export const PHONE_TAG_PREFIX = 'mobile-v';

const NUMERIC = /^\d+(\.\d+){1,3}$/;

export function stripPrefix(value) {
  return String(value ?? '')
    .trim()
    .replace(/^(desktop-|mobile-)?v/, '');
}

export function isNumericVersion(value) {
  return NUMERIC.test(stripPrefix(value));
}

export function compareVersions(a, b) {
  const pa = stripPrefix(a).split('.').map(Number);
  const pb = stripPrefix(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) {
      return x < y ? -1 : 1;
    }
  }

  return 0;
}

// The version an app shows. Apple allows at most three numbers in an app version and Tauri
// needs semver, so a re-cut such as 2026.11.17.1 ships as 2026.11.17. The phone build number
// and the Windows installer version (below) still tell the two builds apart.
export function appVersion(version) {
  const parts = stripPrefix(version).split('.');
  while (parts.length < 3) {
    parts.push('0');
  }

  return parts.slice(0, 3).join('.');
}

// Windows installers (MSI) allow at most 255 in the first two numbers, so 2026.11.17 can't be an
// MSI version. A calendar version becomes 26.11.17 there, and a re-cut adds its number as a
// fourth part (26.11.17.1). Tauri's installer replaces whatever version is installed, so the
// re-cut still installs over the first build. Returns '' when the version already fits.
export function windowsVersion(version) {
  const [major, minor, patch = 0, recut] = stripPrefix(version).split('.').map(Number);
  if (major <= 255 && minor <= 255) {
    return '';
  }

  if (major < 2000 || major > 2255 || minor > 255) {
    throw new Error(`${version} doesn't fit a Windows installer version, even as a calendar version`);
  }

  return [major - 2000, minor, patch, ...(recut ? [recut] : [])].join('.');
}

export function desktopPlan(version) {
  const v = stripPrefix(version);
  if (!isNumericVersion(v)) {
    return { version: v, name: v, tag: `desktop-v${v}`, windows_version: '' };
  }

  return { version: v, name: appVersion(v), tag: `desktop-v${v}`, windows_version: windowsVersion(v) };
}

// The newest phone release at or before `version`. Older mobile-v tags (mobile-v0.1.0-...) used
// their own numbering and don't count.
export function lastPhoneTag(tags, version) {
  return tags
    .filter(
      (t) =>
        t.startsWith(PHONE_TAG_PREFIX) && isNumericVersion(t) && Number(stripPrefix(t).split('.')[0]) >= 2000,
    )
    .filter((t) => compareVersions(t, version) <= 0)
    .reduce((best, t) => (best == null || compareVersions(t, best) > 0 ? t : best), null);
}

export function decidePhones({ mode, version, lastTag, changedFiles }) {
  const app = appVersion(version);
  if (mode === 'skip') {
    return { build: false, reason: 'phones=skip was chosen for this run' };
  }

  if (mode === 'always') {
    return { build: true, reason: 'phones=always was chosen for this run' };
  }

  if (!lastTag) {
    return { build: true, reason: 'no phone release carries a server version yet' };
  }

  if (!changedFiles.length) {
    return { build: false, reason: `nothing the phone apps contain changed since ${lastTag}` };
  }

  const reason = `${changedFiles.length} file(s) the phone apps contain changed since ${lastTag}, such as ${changedFiles[0]}`;
  if (appVersion(lastTag) === app) {
    return {
      build: true,
      reason: `${reason}. Same app version ${app} as ${lastTag}: the App Store refuses it if ${app} is already live there`,
    };
  }

  return { build: true, reason };
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function phonesPlan(tag, mode) {
  if (!['auto', 'always', 'skip'].includes(mode)) {
    throw new Error(`phones mode must be auto, always or skip, not ${mode}`);
  }

  const version = stripPrefix(tag);
  const lastTag =
    mode === 'auto'
      ? lastPhoneTag(git(['tag', '--list', `${PHONE_TAG_PREFIX}*`]).split('\n'), version)
      : null;
  const changedFiles = lastTag
    ? git(['diff', '--name-only', lastTag, tag, '--', ...PHONE_PATHS])
        .split('\n')
        .filter(Boolean)
    : [];

  return {
    ...decidePhones({ mode, version, lastTag, changedFiles }),
    app_version: appVersion(version),
    last_tag: lastTag ?? '',
  };
}

function main(argv) {
  const [command, ...rest] = argv.slice(2);
  let plan;
  if (command === 'desktop' && rest.length === 1) {
    plan = desktopPlan(rest[0]);
  } else if (command === 'phones' && rest.length === 2) {
    plan = phonesPlan(rest[0], rest[1]);
  } else {
    console.error('usage: release-plan.mjs desktop <version> | phones <tag> <auto|always|skip>');

    return 2;
  }

  for (const [key, value] of Object.entries(plan)) {
    console.log(`${key}=${value}`);
  }

  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv);
}

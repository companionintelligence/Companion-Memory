import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';

import {
  compareVersions,
  desktopVersionOnDownloadPage,
  DESKTOP_INSTALLERS,
  formatMarkdown,
  imagesInPublishScript,
  isReleaseVersion,
  livePlayReleases,
  maxVersion,
  missingFiles,
  normalizeVersion,
  parseCaskVersion,
  parseChromeUpdateXml,
  pickLatestDesktopRelease,
  readFileFromDeb,
  versionStatus,
} from './release/release-check.mjs';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

function installerPatterns(prefix: string): string[] {
  const row = DESKTOP_INSTALLERS.find(([label]) => label.startsWith(prefix));
  assert.ok(row, `no desktop installer row starts with "${prefix}"`);
  const [, patterns] = row;

  return patterns;
}

test('normalizeVersion strips the tag prefixes', () => {
  assert.equal(normalizeVersion('v2026.11.17'), '2026.11.17');
  assert.equal(normalizeVersion('desktop-v2026.11.17'), '2026.11.17');
  assert.equal(normalizeVersion('mobile-v2026.11.17'), '2026.11.17');
  assert.equal(normalizeVersion(null), null);
});

test('compareVersions compares numbers, not text', () => {
  assert.equal(compareVersions('2026.11.11.1', '2026.11.11'), 1);
  assert.equal(compareVersions('2026.9.30', '2026.10.1'), -1);
  assert.equal(compareVersions('v2026.11.11', '2026.11.11'), 0);
});

test('versionStatus', () => {
  assert.equal(versionStatus('2026.11.17', '2026.11.17'), 'OK');
  assert.equal(versionStatus('2026.11.17', '1.0.10'), 'BEHIND');
  assert.equal(versionStatus('2026.11.17', '2026.11.18'), 'AHEAD');
  assert.equal(versionStatus('2026.11.17', null), 'MISSING');
});

test('maxVersion skips per-arch and named tags', () => {
  assert.equal(
    maxVersion(['2026.11.11-arm64', 'latest', '2026.11.10', '2026.11.11', 'dev-abc']),
    '2026.11.11',
  );
  assert.equal(maxVersion([]), null);
  assert.equal(isReleaseVersion('2026.11.11-amd64'), false);
});

test('the image list comes from publish.sh', () => {
  const images = imagesInPublishScript(readFileSync(join(ROOT, 'scripts/publish/publish.sh'), 'utf8'));
  assert.ok(images.includes('companion/api'));
  assert.ok(images.includes('companion/hbpe-service'));
  assert.ok(images.every((name) => /^companion\/[a-z0-9-]+$/.test(name)));
});

test('desktop installer names use the version Tauri built with', () => {
  const assets = ['Companion.Memory_2026.11.17_universal.dmg', 'Companion.Memory_2026.11.17_amd64.deb'];
  assert.deepEqual(missingFiles(assets, installerPatterns('macOS'), '2026.11.17'), []);
  assert.deepEqual(missingFiles(assets, installerPatterns('Linux'), '2026.11.17'), [
    '-2026.11.17-1.x86_64.rpm',
  ]);
});

test('parseCaskVersion', () => {
  assert.equal(parseCaskVersion('cask "companion-memory" do\n  version "0.1.10"\n'), '0.1.10');
  assert.equal(parseCaskVersion('cask "x" do\nend\n'), null);
});

test('parseChromeUpdateXml picks the version of the right extension', () => {
  const xml =
    '<gupdate><app appid="abc" status="ok"><updatecheck codebase="https://x" version="1.6.1" status="ok"/></app></gupdate>';
  assert.equal(parseChromeUpdateXml(xml, 'abc'), '1.6.1');
  assert.equal(parseChromeUpdateXml(xml, 'other'), null);
});

test('desktopVersionOnDownloadPage finds the newest Memory Desktop link', () => {
  const html =
    '<a href="https://github.com/companionintelligence/Companion-Memory/releases/download/desktop-v0.1.8/m.dmg">' +
    '<a href="https://github.com/companionintelligence/Companion-Memory/releases/download/desktop-v0.1.10/m.deb">';
  assert.equal(desktopVersionOnDownloadPage(html), '0.1.10');
});

test('pickLatestDesktopRelease skips server releases, drafts and prereleases', () => {
  const releases = [
    { tag_name: 'v2026.11.17', draft: false, prerelease: false },
    { tag_name: 'desktop-v0.1.10', draft: false, prerelease: false },
    { tag_name: 'desktop-v2026.11.17', draft: false, prerelease: false },
    { tag_name: 'desktop-v2026.11.18', draft: true, prerelease: false },
  ];
  assert.equal(pickLatestDesktopRelease(releases).tag_name, 'desktop-v2026.11.17');
});

// A minimal .deb: an ar archive with a gzip tar inside.
function tarEntry(path: string, content: string) {
  const header = Buffer.alloc(512);
  header.write(path, 0, 'utf8');
  header.write('0000644\0', 100);
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('0', 156);
  header.write('ustar\0', 257);
  const body = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  body.write(content);

  return Buffer.concat([header, body]);
}

function arMember(name: string, data: Buffer) {
  const header = Buffer.from(
    `${name.padEnd(16)}${'0'.padEnd(12)}${'0'.padEnd(6)}${'0'.padEnd(6)}${'100644'.padEnd(8)}${String(data.length).padEnd(10)}\`\n`,
  );

  return Buffer.concat([header, data, data.length % 2 ? Buffer.from('\n') : Buffer.alloc(0)]);
}

test('readFileFromDeb reads image-tag.txt out of data.tar.gz', () => {
  const tar = Buffer.concat([
    tarEntry('./usr/lib/Companion Memory/resources/docker-compose.yml', 'services: {}\n'),
    tarEntry('./usr/lib/Companion Memory/resources/image-tag.txt', '2026.11.17\n'),
    Buffer.alloc(1024),
  ]);
  const deb = Buffer.concat([
    Buffer.from('!<arch>\n'),
    arMember('debian-binary', Buffer.from('2.0\n')),
    arMember('control.tar.gz', gzipSync(Buffer.alloc(1024))),
    arMember('data.tar.gz', gzipSync(tar)),
  ]);
  assert.equal(readFileFromDeb(deb, 'resources/image-tag.txt'), '2026.11.17\n');
  assert.equal(readFileFromDeb(deb, 'resources/nope.txt'), null);
  assert.throws(() => readFileFromDeb(Buffer.from('not a deb'), 'x'), /not an ar archive/);
});

test('formatMarkdown bolds failing statuses and escapes pipes', () => {
  const md = formatMarkdown([{ where: 'a|b', expected: '1', found: '0', status: 'BEHIND', note: '' }]);
  assert.match(md, /\| a\\\|b \| 1 \| 0 \| \*\*BEHIND\*\* \|/);
});

test('livePlayReleases keeps what each track serves, staged rollouts included', () => {
  const releases = [
    { track: 'production', status: 'completed', name: '2026.11.11', codes: ['460100'] },
    { track: 'production', status: 'inProgress', name: '2026.11.17', codes: ['468000'] },
    { track: 'internal', status: 'draft', name: '2026.11.18', codes: ['469000'] },
    { track: 'beta', status: 'halted', name: '2026.11.12', codes: ['461000'] },
  ];
  assert.deepEqual(
    livePlayReleases(releases).map((r: { track: string; name: string }) => `${r.track} ${r.name}`),
    ['production 2026.11.17'],
  );
  assert.deepEqual(livePlayReleases([{ track: 'internal', status: 'draft', name: 'x', codes: ['1'] }]), []);
});

test('versionStatus treats a release candidate as behind the release', () => {
  assert.equal(versionStatus('2026.11.17', '2026.11.17-rc1'), 'BEHIND');
});

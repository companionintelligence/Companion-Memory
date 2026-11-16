#!/usr/bin/env node
// Asks every place a Memory release ships to which version it has and prints one table.
// A row that is BEHIND or MISSING is a place the release hasn't reached.
//
//   node scripts/release/release-check.mjs                     # the newest server release
//   node scripts/release/release-check.mjs --version 2026.11.17
//   node scripts/release/release-check.mjs --format markdown   # for a job summary, PR or issue
//   node scripts/release/release-check.mjs --format json
//
// release.yml runs it as its last job. Run it from a checkout with tags fetched: the phone rows
// read git to tell whether the phone apps needed a new build. Needs `gh` signed in. The Google
// Play rows need a Play service-account key, either as JSON text in PLAY_KEY_JSON or as a file
// in PLAY_KEY_FILE; without one they show SKIP. Nothing here writes anywhere: the Play lookup
// opens an edit, reads the tracks and deletes the edit.
//
// Exit code 0 when every row is OK, INFO or SKIP; 1 when any row is BEHIND, MISSING or ERROR;
// 2 on a usage error; 3 when the script itself crashed, so a crash never reads as "behind".
// scripts/release-check.test.ts covers the parsing and comparison helpers.

import { execFileSync } from 'node:child_process';
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { appVersion, compareVersions, phonesPlan, stripPrefix } from './release-plan.mjs';

export { compareVersions };

const ORG = 'companionintelligence';
const MEMORY_REPO = `${ORG}/Companion-Memory`;
const EXTENSION_REPO = `${ORG}/CI-Browser-Extension`;
const MARKETPLACE_REPO = `${ORG}/CI-Marketplace`;
const TAP_REPO = `${ORG}/homebrew-tap`;
const BUCKET_REPO = `${ORG}/scoop-bucket`;
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const STORE_HOSTS = [
  ['dev', 'hub.companionintelligence.com'],
  ['staging', 'hub.companionintel.com'],
  ['prod', 'hub.ci.computer'],
];
const MARKETPLACE_BRANCHES = [
  ['dev', 'dev'],
  ['staging', 'staging'],
  ['prod', 'main'],
];

const PLAY_PACKAGE = 'com.ci.memory';
const IOS_BUNDLE = 'com.companionintelligence.app';
const CHROME_EXTENSION_ID = 'bcocflgkdeimninckpmdifcniajoneih';
const FIREFOX_ADDON_SLUG = 'companion-intelligence';

// One row per platform. A release that lacks any file in a row has not shipped that platform.
// `{v}` is the version Tauri builds with, so a leftover file from an older build doesn't count.
export const DESKTOP_INSTALLERS = [
  ['macOS (universal)', ['_{v}_universal.dmg']],
  ['Windows x64', ['_{v}_x64_en-US.msi', '_{v}_x64-setup.exe']],
  ['Linux x64', ['_{v}_amd64.deb', '-{v}-1.x86_64.rpm']],
];

// ---------------------------------------------------------------------------------------------
// Pure helpers

export function normalizeVersion(value) {
  return value == null ? null : stripPrefix(value);
}

// The release each Play track serves: the newest one that is completed, or inProgress (a staged
// rollout). Drafts serve nobody, so they don't count.
export function livePlayReleases(releases) {
  const live = [];
  for (const track of ['production', 'beta', 'alpha', 'internal']) {
    const serving = releases.filter(
      (r) => r.track === track && ['completed', 'inProgress'].includes(r.status),
    );
    if (serving.length) {
      live.push(
        serving.reduce((a, b) =>
          Math.max(...a.codes.map(Number)) >= Math.max(...b.codes.map(Number)) ? a : b,
        ),
      );
    }
  }

  return live;
}

export function versionStatus(expected, found) {
  if (found == null || found === '') {
    return 'MISSING';
  }

  const cmp = compareVersions(found, expected);
  if (cmp === 0) {
    return 'OK';
  }

  return cmp < 0 ? 'BEHIND' : 'AHEAD';
}

export function isReleaseVersion(value) {
  return /^\d+(\.\d+)+$/.test(normalizeVersion(value) ?? '');
}

// Newest dotted-number version. Entries such as "latest" or "2026.11.11-arm64" are skipped.
export function maxVersion(values) {
  return values
    .filter(isReleaseVersion)
    .reduce((best, v) => (best == null || compareVersions(v, best) > 0 ? v : best), null);
}

export function missingFiles(assetNames, patterns, version) {
  return patterns
    .map((p) => p.replaceAll('{v}', version))
    .filter((suffix) => !assetNames.some((name) => name.endsWith(suffix)));
}

// The companion/* images a release pushes, read from the compose that publish.sh registers.
export function imagesInPublishScript(shellText) {
  return [
    ...new Set([...shellText.matchAll(/\/(companion\/[a-z0-9-]+):\$\{ver\}/g)].map((m) => m[1])),
  ].sort();
}

export function parseCaskVersion(rubyText) {
  return rubyText.match(/^\s*version\s+"([^"]+)"/m)?.[1] ?? null;
}

export function parseChromeUpdateXml(xml, extensionId) {
  const app = xml.match(new RegExp(`<app[^>]*appid="${extensionId}"[^>]*>([\\s\\S]*?)</app>`));

  return app?.[1].match(/<updatecheck[^>]*\sversion="([^"]+)"/)?.[1] ?? null;
}

export function desktopVersionOnDownloadPage(html) {
  return maxVersion(
    [...html.matchAll(/Companion-Memory\/releases\/download\/desktop-v(\d+(?:\.\d+)+)/g)].map((m) => m[1]),
  );
}

export function pickLatestDesktopRelease(releases) {
  const desktop = releases.filter((r) => r.tag_name.startsWith('desktop-v') && !r.draft && !r.prerelease);

  return desktop.reduce(
    (best, r) => (best == null || compareVersions(r.tag_name, best.tag_name) > 0 ? r : best),
    null,
  );
}

// A .deb is an `ar` archive holding data.tar.gz. Returns the text of the first file whose path
// ends with `suffix`, or null. Only gzip data is handled, which is what Tauri writes.
export function readFileFromDeb(debBuffer, suffix) {
  if (debBuffer.subarray(0, 8).toString('latin1') !== '!<arch>\n') {
    throw new Error('not an ar archive');
  }

  let offset = 8;
  while (offset + 60 <= debBuffer.length) {
    const name = debBuffer
      .subarray(offset, offset + 16)
      .toString('latin1')
      .trim()
      .replace(/\/$/, '');
    const size = Number.parseInt(
      debBuffer
        .subarray(offset + 48, offset + 58)
        .toString('latin1')
        .trim(),
      10,
    );
    const start = offset + 60;
    if (name.startsWith('data.tar')) {
      if (!name.endsWith('.gz')) {
        throw new Error(`unsupported ${name}`);
      }

      return readFileFromTar(gunzipSync(debBuffer.subarray(start, start + size)), suffix);
    }

    offset = start + size + (size % 2);
  }

  return null;
}

export function readFileFromTar(tar, suffix) {
  let offset = 0;
  let longName = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) {
      break;
    }

    const field = (from, len) =>
      header
        .subarray(from, from + len)
        .toString('utf8')
        .replace(/\0.*$/s, '');
    const size = Number.parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1);
    const prefix = field(345, 155);
    const path = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = null;
    const body = tar.subarray(offset + 512, offset + 512 + size);
    if (type === 'L') {
      longName = body.toString('utf8').replace(/\0.*$/s, '');
    } else if ((type === '0' || type === '') && path.endsWith(suffix)) {
      return body.toString('utf8');
    }

    offset += 512 + Math.ceil(size / 512) * 512;
  }

  return null;
}

// ---------------------------------------------------------------------------------------------
// Lookups

function gh(args, { binary = false } = {}) {
  return execFileSync('gh', args, {
    encoding: binary ? 'buffer' : 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function ghJson(path) {
  return JSON.parse(gh(['api', path]));
}

function ghFileText(repo, path, ref) {
  return gh([
    'api',
    '-H',
    'Accept: application/vnd.github.raw+json',
    `repos/${repo}/contents/${path}?ref=${ref}`,
  ]);
}

function git(args) {
  return execFileSync('git', ['-C', REPO_ROOT, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function fetchText(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    throw new Error(`${url}: HTTP ${res.status}`);
  }

  return res.text();
}

async function fetchJson(url, init) {
  return JSON.parse(await fetchText(url, init));
}

const INDEX_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

// One anonymous pull token per repository, reused for every manifest request.
const ghcrTokens = new Map();
function ghcrToken(repository) {
  if (!ghcrTokens.has(repository)) {
    ghcrTokens.set(
      repository,
      fetchJson(`https://ghcr.io/token?scope=repository:${repository}:pull`).then((r) => r.token),
    );
  }

  return ghcrTokens.get(repository);
}

// Public GHCR images only (anonymous pull token). Returns null when the tag doesn't exist.
async function ghcrImage(repository, tag) {
  const res = await fetch(`https://ghcr.io/v2/${repository}/manifests/${tag}`, {
    headers: { Authorization: `Bearer ${await ghcrToken(repository)}`, Accept: INDEX_ACCEPT },
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 404) {
    return null;
  }

  if (!res.ok) {
    throw new Error(`ghcr.io/${repository}:${tag}: HTTP ${res.status}`);
  }

  const body = await res.json();
  const platforms = (body.manifests ?? [])
    .map((m) => m.platform)
    .filter((p) => p && p.os !== 'unknown')
    .map((p) => `${p.os}/${p.architecture}`);

  return { digest: res.headers.get('docker-content-digest'), platforms };
}

async function ghcrTags(repository) {
  const url = `https://ghcr.io/v2/${repository}/tags/list?n=10000`;

  return (
    (await fetchJson(url, { headers: { Authorization: `Bearer ${await ghcrToken(repository)}` } })).tags ?? []
  );
}

function readPlayKey() {
  if (process.env.PLAY_KEY_JSON) {
    return JSON.parse(process.env.PLAY_KEY_JSON);
  }

  if (process.env.PLAY_KEY_FILE) {
    return JSON.parse(readFileSync(process.env.PLAY_KEY_FILE, 'utf8'));
  }

  return null;
}

async function playTracks(key, packageName) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: key.token_uri,
    iat: now,
    exp: now + 600,
  })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key, 'base64url');
  const { access_token: accessToken } = await fetchJson(key.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  });
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}/edits`;
  const call = async (method, url) => {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      throw new Error(
        `Play ${method} ${packageName}: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`,
      );
    }

    const text = await res.text();

    return text ? JSON.parse(text) : {};
  };

  const { id } = await call('POST', base);
  try {
    const { tracks = [] } = await call('GET', `${base}/${id}/tracks`);

    return tracks.flatMap((t) =>
      (t.releases ?? []).map((r) => ({
        track: t.track,
        status: r.status,
        name: r.name ?? null,
        codes: r.versionCodes ?? [],
      })),
    );
  } finally {
    // A failed cleanup mustn't replace the tracks just read (or the error that stopped the
    // read). An edit nobody commits expires by itself.
    await call('DELETE', `${base}/${id}`).catch(() => {});
  }
}

async function appStoreListing(bundleId) {
  const data = await fetchJson(`https://itunes.apple.com/lookup?bundleId=${bundleId}&country=us`);
  const app = data.results?.[0];

  return app ? { version: app.version, released: app.currentVersionReleaseDate } : null;
}

// ---------------------------------------------------------------------------------------------
// Rows. A lookup that throws becomes an ERROR row instead of stopping the run.

class Rows {
  constructor() {
    this.list = [];
  }

  add(where, expected, found, status, note = '') {
    this.list.push({ where, expected: expected ?? '', found: found ?? '', status, note });
  }

  version(where, expected, found, note = '') {
    this.add(where, expected, found, versionStatus(expected, found), note);
  }

  // `privateRepo` marks a row that reads another private repository, which a workflow's own token can't.
  async try(where, fn, { privateRepo = false } = {}) {
    try {
      await fn();
    } catch (err) {
      const message = String(err.stderr || err.message || err)
        .trim()
        .split('\n')[0]
        .slice(0, 200);
      if (privateRepo && process.env.GITHUB_ACTIONS === 'true' && /HTTP 40[34]/.test(message)) {
        this.add(
          where,
          '',
          '',
          'SKIP',
          'not readable with this workflow token; run the script locally for this row',
        );
      } else {
        this.add(where, '', '', 'ERROR', message);
      }
    }
  }
}

// Which phone version this release should have. The phone apps only need a new build when
// something they contain changed (release-plan.mjs's PHONE_PATHS); otherwise the last phone
// release stays current. This asks phonesPlan, the same rule release.yml's plan job follows.
function expectedPhoneVersion(version) {
  try {
    const plan = phonesPlan(`v${version}`, 'auto', git);
    if (!plan.last_tag) {
      return { expected: plan.app_version, note: 'no phone release carries a server version yet' };
    }

    if (plan.build) {
      return { expected: plan.app_version, note: `phone app files changed after ${plan.last_tag}` };
    }

    return {
      expected: appVersion(plan.last_tag),
      note: `nothing in the phone apps changed after ${plan.last_tag}`,
    };
  } catch {
    return {
      expected: appVersion(version),
      note: `couldn't read v${version} from git; run git fetch --tags`,
    };
  }
}

async function checkMemory(requested) {
  const rows = new Rows();

  let version = normalizeVersion(requested);
  if (!version) {
    await rows.try('Server release', async () => {
      version = maxVersion(await ghcrTags('companionintelligence/companion/api'));
      if (!version) {
        throw new Error('no release tag on ghcr.io/companionintelligence/companion/api');
      }
    });
    if (!version) {
      return rows.list;
    }
  }

  const tag = `v${version}`;

  await rows.try('Docker images', async () => {
    const images = imagesInPublishScript(
      readFileSync(new URL('../publish/publish.sh', import.meta.url), 'utf8'),
    );
    const problems = [];
    for (const name of images) {
      const short = name.split('/').pop();
      const image = await ghcrImage(`${ORG}/${name}`, version);
      if (!image) {
        problems.push(`${short} missing`);
        continue;
      }

      const arches = ['linux/amd64', 'linux/arm64'].filter((p) => !image.platforms.includes(p));
      if (arches.length) {
        problems.push(`${short} lacks ${arches.join(', ')}`);
      }

      const latest = await ghcrImage(`${ORG}/${name}`, 'latest');
      if (latest?.digest !== image.digest) {
        problems.push(`${short}:latest is another build`);
      }
    }

    const missing = problems.some((p) => p.endsWith('missing') || p.includes('lacks'));
    rows.add(
      `Docker images (${images.length})`,
      version,
      problems.some((p) => p.endsWith('missing')) ? '' : version,
      problems.length ? (missing ? 'MISSING' : 'BEHIND') : 'OK',
      problems.length ? problems.join('; ') : 'all amd64 + arm64, :latest matches',
    );
  });

  await rows.try('GitHub Release', async () => {
    let release = null;
    try {
      release = ghJson(`repos/${MEMORY_REPO}/releases/tags/${tag}`);
    } catch {
      // 404: no Release for this tag
    }

    if (!release) {
      return rows.add('GitHub Release', version, '', 'MISSING', `no Release for ${tag}`);
    }

    const latest = ghJson(`repos/${MEMORY_REPO}/releases/latest`).tag_name;
    rows.add(
      'GitHub Release',
      version,
      version,
      latest === tag ? 'OK' : 'BEHIND',
      latest === tag ? 'marked Latest' : `Latest is ${latest}`,
    );
  });

  const pins = {};
  for (const [env, branch] of MARKETPLACE_BRANCHES) {
    await rows.try(
      `Hub app store pin (${env})`,
      async () => {
        const config = JSON.parse(ghFileText(MARKETPLACE_REPO, 'apps/ci-memory/config.json', branch));
        pins[env] = normalizeVersion(config.version);
        rows.version(`Hub app store pin (${env})`, version, pins[env], `CI-Marketplace ${branch}`);
      },
      { privateRepo: true },
    );
  }

  for (const [env, host] of STORE_HOSTS) {
    await rows.try(`Hub app store live (${env})`, async () => {
      const listing = await fetchJson(`https://${host}/api/store/ci-memory`);
      const found = maxVersion(
        [listing.version, ...(listing.versions ?? []).map((v) => v.version)].map(normalizeVersion),
      );
      const drift =
        pins[env] && found && compareVersions(found, pins[env]) !== 0
          ? `; pin is ${pins[env]}, the next deploy of ${env} changes it`
          : '';
      rows.version(`Hub app store live (${env})`, version, found, `${host}${drift}`);
    });
  }

  let desktop;
  await rows.try('Desktop release', async () => {
    const release = pickLatestDesktopRelease(ghJson(`repos/${MEMORY_REPO}/releases?per_page=50`));
    if (!release) {
      return rows.add('Desktop release', version, '', 'MISSING', 'no desktop-v* release');
    }

    desktop = normalizeVersion(release.tag_name);
    rows.version('Desktop release', version, desktop, `published ${release.published_at.slice(0, 10)}`);
    const names = release.assets.map((a) => a.name);
    const built = isReleaseVersion(desktop) ? appVersion(desktop) : desktop;
    for (const [label, patterns] of DESKTOP_INSTALLERS) {
      const missing = missingFiles(names, patterns, built);
      rows.add(
        `Desktop: ${label}`,
        desktop,
        missing.length ? '' : desktop,
        missing.length ? 'MISSING' : 'OK',
        missing.length ? `missing ${missing.join(', ')}` : '',
      );
    }

    const deb = release.assets.find((a) => a.name.endsWith('_amd64.deb'));
    if (deb) {
      const buffer = gh(
        ['api', '-H', 'Accept: application/octet-stream', `repos/${MEMORY_REPO}/releases/assets/${deb.id}`],
        { binary: true },
      );
      const pinned = readFileFromDeb(buffer, 'resources/image-tag.txt')?.trim() ?? null;
      rows.version('Desktop: server it runs', version, pinned, `baked into desktop ${desktop}`);
    }
  });
  if (desktop) {
    await rows.try('Desktop: Homebrew', async () => {
      const cask = parseCaskVersion(ghFileText(TAP_REPO, 'Casks/companion-memory.rb', 'HEAD'));
      rows.version('Desktop: Homebrew', desktop, cask, 'homebrew-tap companion-memory, updated by hand');
    });
    await rows.try('Desktop: Scoop', async () => {
      const manifest = JSON.parse(ghFileText(BUCKET_REPO, 'companion-memory.json', 'HEAD'));
      rows.version(
        'Desktop: Scoop',
        desktop,
        manifest.version,
        'scoop-bucket companion-memory, updated by hand',
      );
    });
    await rows.try('Desktop: ci.computer/download', async () => {
      const page = desktopVersionOnDownloadPage(await fetchText('https://ci.computer/download'));
      rows.version('Desktop: ci.computer/download', desktop, page, 'site is deployed by hand');
    });
  }

  const phone = expectedPhoneVersion(version);
  if (!process.env.PLAY_KEY_JSON && !process.env.PLAY_KEY_FILE) {
    rows.add(
      'Android (Google Play)',
      phone.expected,
      '',
      'SKIP',
      'set PLAY_KEY_JSON or PLAY_KEY_FILE to a Play service-account key',
    );
  } else {
    await rows.try('Android (Google Play)', async () => {
      const releases = await playTracks(readPlayKey(), PLAY_PACKAGE);
      const live = livePlayReleases(releases);
      if (!live.length) {
        const drafts = releases.filter((r) => r.status === 'draft').length;
        rows.add(
          'Android (Google Play)',
          phone.expected,
          '',
          'MISSING',
          `nothing live on production, beta, alpha or internal${drafts ? `; ${drafts} draft(s) waiting` : ''}`,
        );

        return;
      }

      for (const release of live) {
        const rollout = release.status === 'inProgress' ? 'staged rollout; ' : '';
        rows.version(
          `Android (Google Play), ${release.track}`,
          phone.expected,
          normalizeVersion(release.name),
          `${rollout}build ${release.codes.join(',')}; ${phone.note}`,
        );
      }
    });
  }

  await rows.try('iPhone (App Store)', async () => {
    const listing = await appStoreListing(IOS_BUNDLE);
    if (!listing) {
      return rows.add(
        'iPhone (App Store)',
        phone.expected,
        '',
        'MISSING',
        `${IOS_BUNDLE} isn't on the App Store`,
      );
    }

    rows.version(
      'iPhone (App Store)',
      phone.expected,
      listing.version,
      `released ${listing.released?.slice(0, 10)}; ${phone.note}`,
    );
  });

  await rows.try('Browser extension', async () => {
    const release = ghJson(`repos/${EXTENSION_REPO}/releases/latest`);
    const ext = normalizeVersion(release.tag_name);
    rows.add(
      'Browser extension: GitHub Release',
      ext,
      ext,
      'OK',
      `published ${release.published_at.slice(0, 10)}`,
    );
    await rows.try('Browser extension: Chrome', async () => {
      const xml = await fetchText(
        `https://clients2.google.com/service/update2/crx?response=updatecheck&acceptformat=crx2,crx3&prodversion=140.0&x=id%3D${CHROME_EXTENSION_ID}%26uc`,
      );
      rows.version(
        'Browser extension: Chrome',
        ext,
        parseChromeUpdateXml(xml, CHROME_EXTENSION_ID),
        'Chrome Web Store',
      );
    });
    await rows.try('Browser extension: Firefox', async () => {
      const addon = await fetchJson(`https://addons.mozilla.org/api/v5/addons/addon/${FIREFOX_ADDON_SLUG}/`);
      rows.version('Browser extension: Firefox', ext, addon.current_version?.version, 'addons.mozilla.org');
    });
    rows.add(
      'Browser extension: Edge',
      ext,
      '',
      'SKIP',
      'no public version lookup without the Edge product ID',
    );
  });

  return rows.list;
}

// ---------------------------------------------------------------------------------------------
// Output

const COLUMNS = [
  ['where', 'Where'],
  ['expected', 'Should have'],
  ['found', 'Has'],
  ['status', 'Status'],
  ['note', 'Note'],
];
const FAILING = new Set(['BEHIND', 'MISSING', 'ERROR']);

export function formatTable(rows) {
  const widths = COLUMNS.map(([key, title]) =>
    Math.max(title.length, ...rows.map((r) => String(r[key]).length)),
  );
  const line = (cells) =>
    cells
      .map((c, i) => String(c).padEnd(widths[i]))
      .join('  ')
      .trimEnd();

  return [
    line(COLUMNS.map(([, t]) => t)),
    line(widths.map((w) => '-'.repeat(w))),
    ...rows.map((r) => line(COLUMNS.map(([k]) => r[k]))),
  ].join('\n');
}

export function formatMarkdown(rows) {
  const esc = (v) => String(v).replaceAll('|', '\\|');

  return [
    `| ${COLUMNS.map(([, t]) => t).join(' | ')} |`,
    `|${COLUMNS.map(() => '---').join('|')}|`,
    ...rows.map(
      (r) =>
        `| ${COLUMNS.map(([k]) => (k === 'status' && FAILING.has(r[k]) ? `**${r[k]}**` : esc(r[k]))).join(' | ')} |`,
    ),
  ].join('\n');
}

const USAGE = 'usage: release-check.mjs [--version <server version>] [--format table|markdown|json]';

async function main(argv) {
  const args = argv.slice(2);
  let format = 'table';
  let version = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--format') {
      format = args[++i];
    } else if (args[i] === '--version') {
      version = args[++i];
    } else if (args[i] === '-h' || args[i] === '--help') {
      console.log(USAGE);

      return 0;
    } else {
      console.error(USAGE);

      return 2;
    }
  }

  if (!['table', 'markdown', 'json'].includes(format) || (version != null && !isReleaseVersion(version))) {
    console.error(USAGE);

    return 2;
  }

  const rows = await checkMemory(version);
  if (format === 'json') {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.log(format === 'markdown' ? formatMarkdown(rows) : formatTable(rows));
  }

  const failing = rows.filter((r) => FAILING.has(r.status)).length;
  if (format !== 'json') {
    console.log(
      `\n${failing ? `${failing} row(s) behind, missing or failed.` : 'Every checked place has this release.'}`,
    );
  }

  return failing ? 1 : 0;
}

// process.argv[1] is empty when another script imports this one through `node -e`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`release-check crashed: ${err?.stack ?? err}`);
      process.exitCode = 3;
    },
  );
}

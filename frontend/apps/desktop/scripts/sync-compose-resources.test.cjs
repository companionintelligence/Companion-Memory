#!/usr/bin/env node
// Tests for sync-compose-resources.cjs's image-tag resolver, and for where the
// bundled compose files come from (the same release as those images).
//
// WHY THIS FILE EXISTS: resolveImageTag() decides which server images a
// SHIPPED desktop app will pull. Its output is baked into
// src-tauri/resources/image-tag.txt, read by stack_manager.rs, and handed to
// `docker compose pull` the first time a user launches the packaged app. A
// wrong answer here does not fail the build — it bricks the app at first
// launch with a 404 the user cannot do anything about. That has already
// happened twice:
//
//   (a) the resolver emitted an unpublished `dev-<sha>` tag and exited 0, and
//   (b) `git describe --tags --exact-match` returned the release's OWN tag, so
//       pushing `desktop-v0.1.0` baked `companion/*:0.1.0` in — an image tag
//       ghcr.io/companionintelligence/companion/* has never had.
//
// Both fixes were guarded by prose comments alone until this file existed.
// Case (b) is the sharpest one and gets the most coverage below.
//
// Deliberately dependency-free, like the script under test: node's built-in
// runner and node:assert only. Run it from the REPO ROOT with:
//   node --test 'frontend/apps/desktop/scripts/*.test.cjs'
//
// Quote the glob (or name this file explicitly). The bare directory form
// `node --test frontend/apps/desktop/scripts` does NOT recurse on this repo's
// pinned Node (22.15.1, see .nvmrc) — it tries to load the directory itself as
// a module and reports one failing test, `ERR_TEST_FAILURE` /
// MODULE_NOT_FOUND, which looks exactly like a broken suite. Verified here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  RELEASE_TAG_RE,
  MAX_ANCESTOR_TAGS_TO_CHECK,
  COMPOSE_FILES,
  defaultIo,
  getRequiredImageNames,
  resolveImageTag,
  resolveComposeRef,
  syncResources,
} = require('./sync-compose-resources.cjs');

// Where the script reads the working tree's compose files from.
const REPO_ROOT = path.resolve(__dirname, '../../../..');

// The images a desktop stack needs; the exact list does not matter to the
// resolver's logic, only that it is non-empty, so keep it short and readable.
const REQUIRED = ['api', 'database', 'gateway'];

// Builds the injectable io the resolver takes (see the test-seam note in
// sync-compose-resources.cjs). Everything defaults to the healthiest possible
// world so each test only states the one thing it is exercising.
//
// `published` is the set of `<image>:<tag>` pairs that exist on GHCR in this
// fake world; anything not listed 404s, which is how a PARTIALLY published
// release (some images pushed, one not) is modelled. `tagCommits` maps a git
// ref (v2026.8.26) to the commit it peels to, `headCommit` is HEAD's, and
// `files` holds `git show` content keyed `<ref>:<file>`.
function makeIo({
  exactTag = '',
  mergedTags = [],
  shortSha = 'abc1234',
  headCommit = 'head000',
  tagCommits = {},
  files = {},
  docker = true,
  requiredImages = REQUIRED,
  published = [],
  env = {},
} = {}) {
  const publishedSet = new Set(published);
  const probedTags = [];
  const gitCalls = [];

  return {
    probedTags,
    gitCalls,
    env,
    git(args) {
      gitCalls.push(args.join(' '));
      if (args[0] === 'describe') return exactTag;
      if (args[0] === 'tag') return mergedTags.join('\n');
      if (args[0] === 'rev-parse' && args[1] === '--short') return shortSha;
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return tagCommits[args[3].replace(/\^\{commit\}$/, '')] ?? '';
      }
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return headCommit;
      throw new Error(`unexpected git invocation in test: git ${args.join(' ')}`);
    },
    gitShow: (ref, file) => files[`${ref}:${file}`] ?? null,
    hasDocker: () => docker,
    getRequiredImageNames: () => requiredImages,
    imagePublished(name, tag) {
      probedTags.push(tag);
      return publishedSet.has(`${name}:${tag}`);
    },
    // The production seam calls process.exit(1) here, which would kill the
    // test runner. Throwing makes the hard failure observable — and asserting
    // on a throw is the only way to prove the resolver REFUSES rather than
    // silently baking a bad tag in.
    fail(message) {
      const err = new Error(message);
      err.isHardFailure = true;
      throw err;
    },
  };
}

// Every image in `images` published at `tag`, for building a fully-published
// release in the fake registry.
function allPublished(tag, images = REQUIRED) {
  return images.map((name) => `${name}:${tag}`);
}

// The resolver logs progress on stdout/stderr; swallow it so a passing run is
// quiet, while still handing the messages back for assertions. `fn` defaults
// to the resolver; its return value lands in `out.tag`.
function run(io, fn = resolveImageTag) {
  const out = { warn: [], error: [], log: [], tag: undefined, failure: undefined };
  const original = { warn: console.warn, error: console.error, log: console.log };
  console.warn = (m) => out.warn.push(String(m));
  console.error = (m) => out.error.push(String(m));
  console.log = (m) => out.log.push(String(m));
  try {
    out.tag = fn(io);
  } catch (err) {
    if (!err.isHardFailure) throw err;
    out.failure = err;
  } finally {
    Object.assign(console, original);
  }
  return out;
}

// --- the exact-tag fast path ------------------------------------------

test('a release-shaped exact tag resolves to the v-stripped tag', () => {
  // NOTE the deliberate asymmetry this pins down: `published` is empty here and
  // the resolve still succeeds, because the exact-tag fast path is the one
  // branch that does NOT run the GHCR completeness check the ancestor walk and
  // the explicit pin both run. That is intentional — publish.yml builds and
  // pushes the images for a tag around the same time a desktop build off that
  // tag runs, so checking here would race the very release being cut. This test
  // records that contract; it does NOT assert that the tag was verified.
  const io = makeIo({ exactTag: 'v2026.9.5' });
  const out = run(io);
  assert.equal(out.tag, '2026.9.5');
  assert.equal(out.failure, undefined);
  assert.deepEqual(io.probedTags, [], 'the exact-tag fast path deliberately skips the GHCR check');
});

test('a four-part release tag is still release-shaped', () => {
  assert.equal(run(makeIo({ exactTag: 'v2026.8.13.1' })).tag, '2026.8.13.1');
});

// THE regression test for shipped bug (b). Every release workflow checks out
// the very tag that triggered it, so these all land on HEAD and `git describe
// --tags --exact-match` happily returns them. None of them names a SERVER
// image. Returning one baked e.g. "0.1.0" in as the image tag and 404'd at
// first launch.
for (const badTag of [
  'desktop-v0.1.0',
  'ios-v1.0.0',
  'mobile-release-v0.1.0',
  '0.0.0-test1',
  'archive/insight-engine-place-math',
  'mobile-v0.1.0-appstoreprep-deadbee',
]) {
  test(`a non-release exact tag (${badTag}) is never used as the image tag`, () => {
    const io = makeIo({
      exactTag: badTag,
      // A real, fully-published server release is reachable from HEAD, so the
      // fall-through has somewhere correct to land.
      mergedTags: ['v2026.8.26'],
      published: allPublished('2026.8.26'),
    });
    const out = run(io);

    assert.equal(out.failure, undefined);
    assert.equal(out.tag, '2026.8.26', 'must fall through to the ancestor walk');
    // Belt and braces: neither the raw tag nor any v-stripped/prefix-stripped
    // form of it may leak out as the image tag.
    assert.notEqual(out.tag, badTag);
    assert.ok(
      !/0\.1\.0|1\.0\.0|0\.0\.0/.test(out.tag),
      `resolved tag "${out.tag}" still looks like the desktop/mobile release version`,
    );
  });
}

test('a non-release exact tag with no published ancestor falls to dev-<sha>, not the tag', () => {
  // The nastiest shape of bug (b): the desktop release tag is the ONLY tag in
  // the checkout. The resolver must still refuse to treat it as a server image
  // tag, even though that leaves it with nothing better than dev-<sha>.
  const io = makeIo({ exactTag: 'desktop-v0.1.0', mergedTags: ['desktop-v0.1.0'], shortSha: 'f00ba12' });
  const out = run(io);
  assert.equal(out.tag, 'dev-f00ba12');
});

test('RELEASE_TAG_RE accepts only v-prefixed dotted release tags', () => {
  for (const good of ['v1.2', 'v2026.8.26', 'v2026.8.13.1']) {
    assert.ok(RELEASE_TAG_RE.test(good), `${good} should be release-shaped`);
  }
  for (const bad of [
    'desktop-v0.1.0',
    'ios-v1.0.0',
    'mobile-release-v0.1.0',
    '2026.8.26', // no leading v — publish.sh strips it, tags carry it
    'v2026.8.26-rc1',
    'v2026',
    '0.0.0-test1',
  ]) {
    assert.ok(!RELEASE_TAG_RE.test(bad), `${bad} should NOT be release-shaped`);
  }
});

// --- the explicit CI_SERVER_IMAGE_TAG pin ------------------------------

test('an explicit pin that is fully published is accepted', () => {
  const io = makeIo({
    env: { CI_SERVER_IMAGE_TAG: '2026.8.26' },
    published: allPublished('2026.8.26'),
  });
  const out = run(io);
  assert.equal(out.tag, '2026.8.26');
  assert.equal(out.failure, undefined);
  assert.deepEqual(io.gitCalls, [], 'an explicit pin must not consult git at all');
});

test('an explicit pin that is NOT published is a hard failure, not a baked-in tag', () => {
  // The realistic version of this typo: someone pins the DESKTOP release
  // version, which is not a server image tag.
  const io = makeIo({
    env: { CI_SERVER_IMAGE_TAG: '0.1.0' },
    published: allPublished('2026.8.26'),
  });
  const out = run(io);
  assert.equal(out.tag, undefined, 'the unpublished pin must never be returned');
  assert.ok(out.failure, 'must fail hard');
  assert.match(out.failure.message, /0\.1\.0/);
});

test('an explicit pin missing just ONE image still fails', () => {
  // A partially-published release is the whole reason the check exists: the
  // tag is real, `api` pulls, and then `gateway` 404s mid-startup.
  const io = makeIo({
    env: { CI_SERVER_IMAGE_TAG: '2026.9.5' },
    published: ['api:2026.9.5', 'database:2026.9.5'],
  });
  const out = run(io);
  assert.ok(out.failure);
  assert.match(out.failure.message, /gateway/);
});

test('an explicit pin is baked in unverified when docker is absent, even under CI', () => {
  // Deliberate: GitHub's macOS runners ship no docker CLI, so failing here
  // would leave the macOS lane of desktop-release.yml with no way to build at
  // all — not even by pinning a tag that really is published.
  const io = makeIo({ env: { CI_SERVER_IMAGE_TAG: '2026.8.26', CI: 'true' }, docker: false });
  const out = run(io);
  assert.equal(out.tag, '2026.8.26');
  assert.equal(out.failure, undefined);
  assert.match(out.warn.join('\n'), /UNVERIFIED/);
});

test('an explicit pin is baked in unverified when the overlay is unreadable', () => {
  const io = makeIo({
    env: { CI_SERVER_IMAGE_TAG: '2026.8.26', CI: 'true' },
    requiredImages: null,
  });
  const out = run(io);
  assert.equal(out.tag, '2026.8.26');
  assert.equal(out.failure, undefined);
  assert.match(out.warn.join('\n'), /UNVERIFIED/);
});

// --- the ancestor walk -------------------------------------------------

test('the ancestor walk skips a partially-published release and takes the next one', () => {
  const io = makeIo({
    mergedTags: ['v2026.9.5', 'v2026.8.26', 'v2026.7.27'],
    // v2026.9.5 was cut but its `gateway` push failed — exactly the failure
    // mode "a git tag exists" cannot rule out.
    published: ['api:2026.9.5', 'database:2026.9.5', ...allPublished('2026.8.26')],
  });
  const out = run(io);
  assert.equal(out.tag, '2026.8.26');
  assert.equal(out.failure, undefined);
  assert.match(out.warn.join('\n'), /skipped tag "2026\.9\.5"/);
  assert.match(out.warn.join('\n'), /gateway/);
});

test('the ancestor walk is bounded by MAX_ANCESTOR_TAGS_TO_CHECK', () => {
  // 25 reachable release tags, none published. The walk must give up after
  // MAX_ANCESTOR_TAGS_TO_CHECK rather than probing GHCR for every tag in the
  // repo's history.
  const mergedTags = Array.from({ length: 25 }, (_, i) => `v2026.1.${25 - i}`);
  const io = makeIo({ mergedTags, shortSha: 'cafe123' });
  const out = run(io);
  assert.equal(out.tag, 'dev-cafe123');
  assert.equal(new Set(io.probedTags).size, MAX_ANCESTOR_TAGS_TO_CHECK);
});

test('non-release tags in the merged list are filtered out of the walk', () => {
  const io = makeIo({
    mergedTags: ['desktop-v0.1.0', 'ios-v1.0.0', '0.0.0-test1', 'v2026.8.26'],
    published: allPublished('2026.8.26'),
  });
  const out = run(io);
  assert.equal(out.tag, '2026.8.26');
  // Only the one release-shaped tag may ever have been probed on GHCR.
  assert.deepEqual([...new Set(io.probedTags)], ['2026.8.26']);
});

// --- the degraded (merely UNVERIFIABLE) paths --------------------------
//
// These deliberately warn-and-continue even under CI: they are UNVERIFIABLE,
// not KNOWN-BAD. The tag is a real release tag out of git; nothing could check
// it. Failing here made every macOS job in desktop-build.yml /
// desktop-release.yml exit 1 on a perfectly good release.

test('no docker: the nearest release tag is used unverified for a local build', () => {
  const io = makeIo({ mergedTags: ['v2026.9.5', 'v2026.8.26'], docker: false });
  const out = run(io);
  assert.equal(out.tag, '2026.9.5');
  assert.equal(out.failure, undefined);
  assert.match(out.warn.join('\n'), /docker is not on PATH/);
});

test('no docker under CI still succeeds — macOS runners have no docker CLI', () => {
  const io = makeIo({
    mergedTags: ['v2026.9.5'],
    docker: false,
    env: { CI: 'true', REQUIRE_PUBLISHED_IMAGE_TAG: '1' },
  });
  const out = run(io);
  assert.equal(out.tag, '2026.9.5');
  assert.equal(out.failure, undefined, 'an unverifiable-but-real release tag must not fail CI');
});

test('unreadable overlay: the nearest release tag is used unverified, under CI too', () => {
  const io = makeIo({
    mergedTags: ['v2026.9.5'],
    requiredImages: null,
    env: { CI: 'true' },
  });
  const out = run(io);
  assert.equal(out.tag, '2026.9.5');
  assert.equal(out.failure, undefined);
  assert.match(out.warn.join('\n'), /Could not read required image names/);
});

// --- the dev-<sha> last resort (shipped bug (a)) -----------------------

test('dev-<sha> is warned about but allowed for a local developer build', () => {
  const io = makeIo({ mergedTags: [], shortSha: 'deadbee' });
  const out = run(io);
  assert.equal(out.tag, 'dev-deadbee');
  assert.equal(out.failure, undefined);
  assert.match(out.warn.join('\n'), /NOT been published/);
});

test('dev-<sha> is a hard failure under CI', () => {
  const io = makeIo({ mergedTags: [], shortSha: 'deadbee', env: { CI: 'true' } });
  const out = run(io);
  assert.ok(out.failure, 'CI must refuse a tag guaranteed to 404 at first launch');
  assert.match(out.failure.message, /dev-deadbee/);
});

test('dev-<sha> is a hard failure under REQUIRE_PUBLISHED_IMAGE_TAG=1', () => {
  const io = makeIo({
    mergedTags: [],
    shortSha: 'deadbee',
    env: { REQUIRE_PUBLISHED_IMAGE_TAG: '1' },
  });
  assert.ok(run(io).failure);
});

test('REQUIRE_PUBLISHED_IMAGE_TAG must be exactly "1" to opt in', () => {
  // The flag is documented as `=1`; anything else keeps the local
  // warn-and-continue behaviour rather than silently hard-failing a dev build.
  const io = makeIo({ mergedTags: [], env: { REQUIRE_PUBLISHED_IMAGE_TAG: '0' } });
  const out = run(io);
  assert.equal(out.tag, 'dev-abc1234');
  assert.equal(out.failure, undefined);
});

test('every reachable release tag partially published falls through to dev-<sha>', () => {
  const io = makeIo({
    mergedTags: ['v2026.9.5', 'v2026.8.26'],
    published: ['api:2026.9.5', 'api:2026.8.26'], // database/gateway never pushed
    shortSha: 'badf00d',
  });
  const out = run(io);
  assert.equal(out.tag, 'dev-badf00d');
  assert.match(out.warn.join('\n'), /none of the 2 most recent ancestor release tag\(s\)/);
});

test('not a git checkout at all is a hard failure', () => {
  // git() returns '' for every invocation when there is no repo; there is
  // nothing left to guess, so the build must stop rather than invent a tag.
  const io = makeIo({ mergedTags: [], shortSha: '' });
  const out = run(io);
  assert.ok(out.failure);
  assert.equal(out.tag, undefined);
  assert.match(out.failure.message, /not a git checkout/);
});

// --- where the compose files come from --------------------------------
//
// The bundle's compose files and the images image-tag.txt names must be ONE
// release. Copying HEAD's compose unconditionally paired it with the previous
// release's images on every untagged commit: when a compose change needed a
// newer image (per-service secrets mounts only the new setup-secrets image
// fills), every service in the desktop stack booted with an empty
// /run/secrets. These run the whole sync against a scratch directory.

// Distinguishable content per release, so an assertion can tell which one
// landed in the bundle.
function releaseFiles(ref) {
  return Object.fromEntries(COMPOSE_FILES.map((name) => [`${ref}:${name}`, `# ${name} at ${ref}\n`]));
}

function syncInto(io) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-compose-resources-'));
  const out = run(io, (i) => syncResources(i, dir));
  const read = (name) => {
    const file = path.join(dir, name);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
  };
  const bundle = Object.fromEntries([...COMPOSE_FILES, 'image-tag.txt'].map((name) => [name, read(name)]));
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...out, bundle };
}

test('an ancestor-walk build bundles the compose files of the release it pins, not HEAD', () => {
  // THE regression test: HEAD is past v2026.9.23.1, its images are the newest
  // published, and HEAD's compose may need images that release lacks.
  const io = makeIo({
    mergedTags: ['v2026.9.23.1'],
    published: allPublished('2026.9.23.1'),
    tagCommits: { 'v2026.9.23.1': 'rel0001' },
    headCommit: 'head999',
    files: releaseFiles('v2026.9.23.1'),
  });
  const out = syncInto(io);
  assert.equal(out.failure, undefined);
  assert.equal(out.bundle['image-tag.txt'], '2026.9.23.1\n');
  for (const name of COMPOSE_FILES) {
    assert.equal(
      out.bundle[name],
      `# ${name} at v2026.9.23.1\n`,
      `${name} must come from the pinned release`,
    );
  }
});

test("an explicit pin bundles that release's compose files too", () => {
  // How desktop-release.yml's platform jobs receive the tag its `version` job
  // resolved — so this is the path the signed release bundles take.
  const io = makeIo({
    env: { CI_SERVER_IMAGE_TAG: '2026.8.26' },
    published: allPublished('2026.8.26'),
    tagCommits: { 'v2026.8.26': 'rel0826' },
    headCommit: 'head999',
    files: releaseFiles('v2026.8.26'),
  });
  const out = syncInto(io);
  assert.equal(out.failure, undefined);
  assert.equal(out.bundle['image-tag.txt'], '2026.8.26\n');
  assert.equal(
    out.bundle['docker-compose.production.yml'],
    '# docker-compose.production.yml at v2026.8.26\n',
  );
});

test('an exact-HEAD release bundles the working tree, which IS that release', () => {
  const io = makeIo({
    exactTag: 'v2026.9.5',
    tagCommits: { 'v2026.9.5': 'head999' },
    headCommit: 'head999',
  });
  assert.equal(run(io, (i) => resolveComposeRef(resolveImageTag(i), i)).tag, null);
  const out = syncInto(io);
  assert.equal(out.bundle['image-tag.txt'], '2026.9.5\n');
  for (const name of COMPOSE_FILES) {
    assert.equal(out.bundle[name], fs.readFileSync(path.join(REPO_ROOT, name), 'utf8'));
  }
});

test('the dev-<sha> last resort bundles the working tree without asking git for a tag', () => {
  const io = makeIo({ mergedTags: [], shortSha: 'deadbee' });
  const out = run(io, (i) => resolveComposeRef('dev-deadbee', i));
  assert.equal(out.tag, null);
  assert.ok(!io.gitCalls.some((c) => c.startsWith('rev-parse --verify')), io.gitCalls.join('; '));
});

test('a pin with no matching tag in the clone bundles the working tree, warned UNPAIRED, even under CI', () => {
  // Unverifiable rather than known-bad (the images are real), so it warns
  // like the other unverifiable paths instead of refusing.
  const io = makeIo({
    env: { CI_SERVER_IMAGE_TAG: '2026.8.26', CI: 'true' },
    published: allPublished('2026.8.26'),
  });
  const out = run(io, (i) => resolveComposeRef(resolveImageTag(i), i));
  assert.equal(out.failure, undefined);
  assert.equal(out.tag, null);
  assert.match(out.warn.join('\n'), /UNPAIRED/);
});

test('a pinned release missing a compose file is a hard failure, not a working-tree fallback', () => {
  const io = makeIo({
    mergedTags: ['v2026.9.23.1'],
    published: allPublished('2026.9.23.1'),
    tagCommits: { 'v2026.9.23.1': 'rel0001' },
    files: { 'v2026.9.23.1:docker-compose.yml': 'services: {}\n' },
  });
  const out = syncInto(io);
  assert.ok(out.failure, "must refuse rather than pair HEAD's compose with that release");
  assert.match(out.failure.message, /docker-compose\.production\.yml at v2026\.9\.23\.1/);
  assert.equal(out.bundle['image-tag.txt'], undefined, 'a failed sync must not write the image tag');
});

// --- the overlay parser ------------------------------------------------
//
// If this ever silently returns null, every GHCR completeness check above
// degrades to "unverified" and the two shipped bugs get their guard removed
// without anyone noticing — so it is tested against both a fixture and the
// real checked-in overlay.

test('getRequiredImageNames parses and de-duplicates the overlay image list', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-compose-resources-'));
  try {
    const fixture = path.join(dir, 'docker-compose.desktop.yml');
    fs.writeFileSync(
      fixture,
      [
        'services:',
        '  api:',
        '    image: ghcr.io/companionintelligence/companion/api:${CI_SERVER_IMAGE_TAG}',
        '  worker:',
        '    image: ghcr.io/companionintelligence/companion/api:${CI_SERVER_IMAGE_TAG}',
        '  db:',
        '    image: ghcr.io/companionintelligence/companion/database:${CI_SERVER_IMAGE_TAG}',
        '  cache:',
        '    image: redis:7-alpine',
        '',
      ].join('\n'),
    );
    assert.deepEqual(getRequiredImageNames(fixture), ['api', 'database']);

    const noMatches = path.join(dir, 'empty.yml');
    fs.writeFileSync(noMatches, 'services:\n  cache:\n    image: redis:7-alpine\n');
    assert.equal(getRequiredImageNames(noMatches), null);

    assert.equal(getRequiredImageNames(path.join(dir, 'does-not-exist.yml')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getRequiredImageNames reads the real docker-compose.desktop.yml', () => {
  // Guards against the overlay being rewritten in a way the regex no longer
  // matches (e.g. moving the tag into an env-file default), which would turn
  // every completeness check into a silent no-op.
  const names = getRequiredImageNames();
  assert.ok(Array.isArray(names) && names.length > 0, 'the real overlay must still parse');
  assert.ok(names.includes('api'), `expected the api image in ${JSON.stringify(names)}`);
});

// --- the test seam itself ----------------------------------------------

// Every `io`-taking function declares `io = defaultIo`, and defaultIo.env IS
// process.env. So a branch that calls degrade(message) and forgets to thread
// `io` through still compiles, and reads the REAL environment instead of the
// injected one. That bug has a uniquely nasty signature: on a laptop (no CI
// var) it is invisible — every test above still passes, because the leaked
// read happens to say "not CI" — and it only bites on a GitHub runner, where
// CI=true is always set, by hard-failing a lane that should merely warn. My
// first attempt at this test used the dev-<sha> path and did NOT catch it,
// because that one path is already pinned by the "hard failure under CI" tests
// above; the leak hides in the branches whose only assertion is "does not
// fail". Those are the ones enumerated here.
//
// Method: make the REAL environment maximally hostile (both hard-failure flags
// set) while handing the resolver an io whose env is empty. Every one of these
// outcomes is a deliberate warn-and-continue, so all of them must still warn.
// Any leak to process.env turns one into a refusal and this test goes red.
//
// Read the failure carefully if it fires: a leaked path calls defaultIo.fail,
// which is a real process.exit(1), so the whole FILE aborts ("# tests 1 /
// # fail 1", exitCode 1) rather than reporting a single assertion. Still red;
// the cause is always the same — an io-taking call site that dropped its `io`.
for (const [name, opts, expected] of [
  ['the dev-<sha> last resort', { mergedTags: [], shortSha: 'seam001' }, 'dev-seam001'],
  ['the no-docker ancestor walk', { mergedTags: ['v2026.9.5'], docker: false }, '2026.9.5'],
  ['the unreadable-overlay ancestor walk', { mergedTags: ['v2026.9.5'], requiredImages: null }, '2026.9.5'],
  ['a no-docker explicit pin', { env: { CI_SERVER_IMAGE_TAG: '2026.8.26' }, docker: false }, '2026.8.26'],
  [
    'an unreadable-overlay explicit pin',
    { env: { CI_SERVER_IMAGE_TAG: '2026.8.26' }, requiredImages: null },
    '2026.8.26',
  ],
]) {
  test(`${name} honours the injected io, never the real process.env`, () => {
    const saved = { CI: process.env.CI, REQUIRE: process.env.REQUIRE_PUBLISHED_IMAGE_TAG };
    process.env.CI = 'true';
    process.env.REQUIRE_PUBLISHED_IMAGE_TAG = '1';
    try {
      const out = run(makeIo(opts));
      assert.equal(out.failure, undefined, 'a leaked process.env read turned a warning into a refusal');
      assert.equal(out.tag, expected);
    } finally {
      // Restore exactly, including "was not set at all" — a stray CI=true left
      // behind would silently change how every later test in this file resolves.
      if (saved.CI === undefined) delete process.env.CI;
      else process.env.CI = saved.CI;
      if (saved.REQUIRE === undefined) delete process.env.REQUIRE_PUBLISHED_IMAGE_TAG;
      else process.env.REQUIRE_PUBLISHED_IMAGE_TAG = saved.REQUIRE;
    }
  });
}

test('defaultIo wires the resolver to the real implementations', () => {
  // A broken seam (e.g. a stub left in defaultIo) would make every test above
  // pass while production resolved nothing. `getRequiredImageNames` and `env`
  // are checked by identity; `git` is checked by actually shelling out, since a
  // stub arrow assigned to the `git:` key would satisfy a typeof check and
  // inherit the name "git" too. `git --version` needs only the binary on PATH,
  // not a repo, so it is safe to run from a tarball or a scratch copy.
  assert.equal(defaultIo.env, process.env);
  assert.equal(defaultIo.getRequiredImageNames, getRequiredImageNames);
  assert.match(defaultIo.git(['--version']), /^git version /);
  // A ref no repository has: null with a repo or without one, so this too is
  // safe from a tarball.
  assert.equal(defaultIo.gitShow('no-such-ref-sync-compose-test', 'docker-compose.yml'), null);
  // hasDocker/imagePublished cannot be probed without a docker daemon or a
  // network round-trip to GHCR, so they only get the shape check.
  for (const key of ['hasDocker', 'imagePublished', 'fail']) {
    assert.equal(typeof defaultIo[key], 'function', `defaultIo.${key} must be a function`);
  }
});

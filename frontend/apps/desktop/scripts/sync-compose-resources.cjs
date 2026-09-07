#!/usr/bin/env node
// Zero-dependency sync step, run before every `tauri dev`/`tauri build`
// (see package.json's dev/build scripts).
//
// 1. Copies the repo root's docker-compose.yml + docker-compose.production.yml
//    into src-tauri/resources/ verbatim, so the bundled resources can never
//    drift from the real compose files (they are gitignored here — see
//    .gitignore — and always regenerated).
// 2. Resolves the CI-Server image tag this build should default to pulling,
//    and writes it to src-tauri/resources/image-tag.txt — a bundled resource
//    stack_manager.rs reads at runtime as the default CI_SERVER_IMAGE_TAG.
//    This deliberately never defaults to "latest": publish.sh's own comments
//    record that a stale companion/*:latest tag previously orphaned
//    (amd64-only, pointing at no real release), so a desktop build instead
//    always pins to a real tag: the exact release this checkout IS (git
//    describe --tags --exact-match, mirroring scripts/publish/publish.sh's
//    own naming), else — deliberately DIVERGING from publish.sh here — the
//    nearest ancestor release tag reached from HEAD that is FULLY published
//    (every image docker-compose.desktop.yml needs actually exists on GHCR
//    at that tag — a real git tag does not imply a complete publish; a
//    release can partially fail, leaving some images pushed and others not),
//    since no `dev-<sha>` image has ever actually been published to the
//    registry and baking one in just fails the pull silently at first launch
//    (see README.md). A dev-<sha> tag is used only as the very last resort,
//    when no fully-published release tag is reachable from HEAD at all (e.g.
//    a shallow clone, or every reachable release tag is partial).
//
// Environment variables:
//   CI_SERVER_IMAGE_TAG          Explicit pin, always wins (the documented
//                                local-dev / deliberate-pin escape hatch —
//                                see README.md's "export one explicitly").
//                                It is still GHCR-verified when docker is
//                                available: a pin to a tag that was never
//                                published is a hard failure here rather
//                                than a silent pull failure at first launch.
//   REQUIRE_PUBLISHED_IMAGE_TAG  Set to 1 to make the dev-<sha> last resort —
//                                the one outcome that is KNOWN never to have
//                                been published — a hard failure instead of a
//                                warning. Implied whenever CI is set, so every
//                                GitHub Actions run gets it: a bundle handed to
//                                someone else must not carry a tag guaranteed
//                                to 404, because the only place that surfaces
//                                is the user's first launch. An ordinary local
//                                developer build keeps the warn-and-continue
//                                behaviour. Deliberately scoped to that one
//                                case and NOT to the merely-UNVERIFIABLE ones
//                                (docker missing, docker-compose.desktop.yml
//                                unreadable): GitHub's macOS runners ship no
//                                docker CLI at all, so failing there would make
//                                the macOS lanes of desktop-build.yml and
//                                desktop-release.yml unbuildable even for a
//                                perfectly good release — see degrade().
//
// Deliberately plain Node (no deps) — this runs on a bare `node` before
// anything has been installed, mirroring bin/check-migration-versions.js's
// reasoning for staying dependency-free.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const RESOURCES_DIR = path.join(PACKAGE_ROOT, 'src-tauri', 'resources');
const DESKTOP_COMPOSE_OVERLAY = path.join(RESOURCES_DIR, 'docker-compose.desktop.yml');

const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.production.yml'];

// A release tag looks like v2026.8.26 or v2026.8.13.1. This repo's tag
// history also has non-release tags mixed in (e.g.
// archive/insight-engine-place-math, mobile-v0.1.0-appstoreprep-<sha>,
// 0.0.0-test1) that a plain --sort=-creatordate listing would include, so
// filter deliberately. Same `v` shape publish.sh's own VERSION="${VERSION#v}"
// stripping implies.
const RELEASE_TAG_RE = /^v\d+(?:\.\d+)+$/;

// How many ancestor release tags to walk back through looking for a fully
// published one before giving up — bounds the walk on a corrupted or
// entirely-unpublished tag history instead of looping forever.
const MAX_ANCESTOR_TAGS_TO_CHECK = 20;

function copyComposeFiles() {
  fs.mkdirSync(RESOURCES_DIR, { recursive: true });
  for (const name of COMPOSE_FILES) {
    const src = path.join(REPO_ROOT, name);
    const dest = path.join(RESOURCES_DIR, name);
    fs.copyFileSync(src, dest);
    console.log(`  synced ${name}`);
  }
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

// The exact set of ghcr.io/companionintelligence/companion/<name> images a
// desktop stack needs to pull, read directly from
// docker-compose.desktop.yml — the authoritative source (see that file's own
// header comment) — rather than hand-maintaining a second copy of the list
// here that could drift from it. Returns null if the file can't be read.
function getRequiredImageNames() {
  let overlay;
  try {
    overlay = fs.readFileSync(DESKTOP_COMPOSE_OVERLAY, 'utf8');
  } catch {
    return null;
  }
  const names = new Set();
  const re = /ghcr\.io\/companionintelligence\/companion\/([a-zA-Z0-9_-]+):\$\{CI_SERVER_IMAGE_TAG\}/g;
  let match;
  while ((match = re.exec(overlay))) {
    names.add(match[1]);
  }
  return names.size > 0 ? [...names] : null;
}

function hasDocker() {
  try {
    execFileSync('docker', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// A registry query (not a pull) — cheap, and `docker` is already a hard
// dependency of everything this script's domain does at runtime, so this
// isn't a new category of dependency the way a live GHCR HTTP call would be.
function imagePublished(name, tag) {
  try {
    execFileSync(
      'docker',
      ['manifest', 'inspect', `ghcr.io/companionintelligence/companion/${name}:${tag}`],
      { stdio: 'ignore' },
    );
    return true;
  } catch {
    return false;
  }
}

// Returns the name of the first required image missing at `tag` on GHCR, or
// null if every required image is present there.
function findMissingImage(tag, requiredImages) {
  for (const name of requiredImages) {
    if (!imagePublished(name, tag)) {
      return name;
    }
  }
  return null;
}

// True when this build must not ship an image tag whose existence on GHCR
// nobody confirmed. Every GitHub Actions runner sets CI, and
// REQUIRE_PUBLISHED_IMAGE_TAG=1 opts a local build into the same rule.
function requiresPublishedTag() {
  return Boolean(process.env.CI) || process.env.REQUIRE_PUBLISHED_IMAGE_TAG === '1';
}

// A KNOWN-BAD resolution: a tag nothing has ever published (the dev-<sha>
// last resort). Warning and exiting 0 here converts a build-time problem into
// a first-launch `docker compose pull` failure inside the packaged app — the
// worst possible place to discover it, since stack_manager.rs can only report
// that the pull 404'd. So warn for an ordinary local developer build, where
// the developer is standing right there and can re-run with an explicit pin,
// but FAIL wherever the bundle could be handed to someone else (see
// requiresPublishedTag).
//
// Reserved for KNOWN-bad, never for merely UNVERIFIABLE: the callers that
// cannot run `docker manifest inspect` (no docker CLI, unreadable overlay)
// deliberately console.warn instead. GitHub's macOS runners ship no docker at
// all, so routing those through here made every macOS job in
// desktop-build.yml/desktop-release.yml exit 1 on a real, fully-published tag
// the Linux job in the same workflow had just verified — and an explicit
// CI_SERVER_IMAGE_TAG pin could not rescue it either, which made this
// message's own "pass CI_SERVER_IMAGE_TAG" advice circular there.
function degrade(message) {
  if (requiresPublishedTag()) {
    console.error(`  ✗ ${message}`);
    console.error(
      '    Refusing to continue because CI or REQUIRE_PUBLISHED_IMAGE_TAG=1 is set. Pass ' +
        'CI_SERVER_IMAGE_TAG=<a tag published under ' +
        'ghcr.io/companionintelligence/companion/*> explicitly, or cut and publish a real ' +
        'release, so the bundled image-tag.txt names an image that actually exists.',
    );
    process.exit(1);
  }
  console.warn(`  ⚠ ${message}`);
}

function resolveImageTag() {
  // An explicit override always wins (advanced/CI use — e.g. pinning to a
  // specific prior release without checking it out; README.md documents it as
  // the escape hatch for developing off a non-release commit).
  if (process.env.CI_SERVER_IMAGE_TAG) {
    const pinned = process.env.CI_SERVER_IMAGE_TAG;

    // ...but "wins" used to mean "returns unchecked": this was the one branch
    // that skipped the `docker manifest inspect` completeness check every
    // other branch below runs, so a pin to a tag that was never published
    // (a typo, or a version string that isn't a SERVER image tag at all)
    // built cleanly and only failed at the user's first launch. Verify it the
    // same way. A deliberate pin to a real published release is unaffected.
    // Warn rather than degrade() on both unverifiable paths below: a human
    // deliberately chose this tag, and the macOS release runners have no
    // docker CLI to check it with, so failing here would leave the macOS lane
    // of desktop-release.yml with no way to build at all — not even by pinning
    // a tag that really is published.
    if (!hasDocker()) {
      console.warn(
        `  ⚠ docker is not on PATH; the explicit CI_SERVER_IMAGE_TAG="${pinned}" pin is being ` +
          `baked in UNVERIFIED — nothing has confirmed that every image ` +
          `docker-compose.desktop.yml needs exists on GHCR at that tag.`,
      );
      return pinned;
    }

    const requiredImages = getRequiredImageNames();
    if (!requiredImages) {
      console.warn(
        `  ⚠ Could not read required image names from ${DESKTOP_COMPOSE_OVERLAY}; the explicit ` +
          `CI_SERVER_IMAGE_TAG="${pinned}" pin is being baked in UNVERIFIED.`,
      );
      return pinned;
    }

    const missing = findMissingImage(pinned, requiredImages);
    if (missing) {
      console.error(
        `  ✗ CI_SERVER_IMAGE_TAG="${pinned}" is pinned explicitly, but ` +
          `ghcr.io/companionintelligence/companion/${missing}:${pinned} does not exist on ` +
          `GHCR. Baking it in would produce a bundle that builds fine and then fails to pull ` +
          `at first launch. Pin a fully-published release tag instead (the tags publish.yml ` +
          `has pushed, e.g. 2026.8.26 — note a desktop/mobile release version like 0.1.0 is ` +
          `NOT a server image tag), or unset CI_SERVER_IMAGE_TAG to resolve one from git.`,
      );
      process.exit(1);
    }

    return pinned;
  }

  const exactTag = git(['describe', '--tags', '--exact-match']);
  // Only a RELEASE-shaped tag (v2026.8.26 — RELEASE_TAG_RE, the same filter
  // the ancestor walk below applies) names a published SERVER image. HEAD
  // routinely carries tags that are not server releases at all: every release
  // workflow checks out the very tag that triggered it, so `desktop-v0.1.0`
  // (desktop-release.yml), `ios-v1.0.0` / `mobile-release-v1.0.0`
  // (mobile-release.yml) and hand-cut tags like `0.0.0-test1` all land on
  // HEAD. Returning one of those verbatim baked e.g. "desktop-v0.1.0" in as
  // the SERVER image tag, an image ghcr.io/companionintelligence/companion/*
  // can never have — so the desktop app built fine and then 404'd on its
  // first pull. Anything not release-shaped (including the case where --exact-match
  // picks a non-release tag while a release tag also sits on HEAD) falls
  // through to the ancestor walk below, which is both RELEASE_TAG_RE-filtered
  // and GHCR-verified, and which still sees tags on HEAD itself because
  // `git tag --merged HEAD` includes them.
  if (exactTag && RELEASE_TAG_RE.test(exactTag)) {
    // Same stripping publish.sh does — a local `v2026.7.27` tag and a CI-published
    // `2026.7.27` image tag must resolve to the identical string.
    return exactTag.replace(/^v/, '');
  }

  // No `dev-<sha>` image has ever been published to
  // ghcr.io/companionintelligence/companion/api, so falling straight back to
  // `dev-<sha>` here would bake in a tag Docker can never pull — the desktop
  // app would build fine and then fail silently at first launch. Fall back to
  // the nearest ancestor release tag instead: it's not exact, but it's real —
  // except "a tag exists in git" does not imply "every image for that tag was
  // published to GHCR" (a release can partially fail: some images push, one
  // doesn't, and the tag still gets cut). So walk ancestor release tags
  // newest-first and use the first one where every required image is
  // actually present, rather than trusting the nearest tag blindly.
  const ancestorTags = git(['tag', '--merged', 'HEAD', '--sort=-v:refname'])
    .split('\n')
    .filter((t) => RELEASE_TAG_RE.test(t))
    .slice(0, MAX_ANCESTOR_TAGS_TO_CHECK);

  if (ancestorTags.length > 0) {
    const requiredImages = hasDocker() ? getRequiredImageNames() : null;

    if (!hasDocker()) {
      // Can't shell out to `docker manifest inspect` to check completeness —
      // a missing Docker binary during this SYNC step is plausible even
      // though the RUNTIME app requires Docker (e.g. a build machine with no
      // Docker installed, and GitHub's macOS runners ship no docker CLI at
      // all). Degrade to the old, unverified behavior instead of crashing the
      // whole build: this tag is a real release tag out of git, only
      // unconfirmed, so it is NOT a degrade() case — failing here would make
      // every macOS job in desktop-build.yml/desktop-release.yml impossible.
      const resolved = ancestorTags[0].replace(/^v/, '');
      console.warn(
        `  ⚠ docker is not on PATH; skipping the GHCR completeness check and falling back to ` +
          `the nearest release tag "${resolved}" UNVERIFIED. This is NOT the exact code in ` +
          `this checkout, and it has not been confirmed that every image for this tag was ` +
          `actually published — cut and publish a real release for an exact match.`,
      );
      return resolved;
    }

    if (!requiredImages) {
      // Couldn't read/parse docker-compose.desktop.yml to know what to check
      // — same degrade-gracefully rule as the no-docker case above.
      const resolved = ancestorTags[0].replace(/^v/, '');
      console.warn(
        `  ⚠ Could not read required image names from ${DESKTOP_COMPOSE_OVERLAY}; skipping ` +
          `the GHCR completeness check and falling back to the nearest release tag ` +
          `"${resolved}" UNVERIFIED. This is NOT the exact code in this checkout — cut and ` +
          `publish a real release for an exact match.`,
      );
      return resolved;
    }

    for (const candidateTag of ancestorTags) {
      const resolved = candidateTag.replace(/^v/, '');
      const missing = findMissingImage(resolved, requiredImages);
      if (!missing) {
        console.warn(
          `  ⚠ HEAD is not an exact release tag; falling back to the nearest fully-published ` +
            `release "${resolved}" instead. This is NOT the exact code in this checkout — cut ` +
            `and publish a real release for an exact match.`,
        );
        return resolved;
      }
      console.warn(
        `  ⚠ skipped tag "${resolved}", it's missing the "${missing}" image on GHCR ` +
          `(ghcr.io/companionintelligence/companion/${missing}:${resolved} not found) — this ` +
          `release only partially published; trying the next older release tag.`,
      );
    }

    console.warn(
      `  ⚠ none of the ${ancestorTags.length} most recent ancestor release tag(s) reachable ` +
        `from HEAD have every required image published to GHCR; falling through to the ` +
        `dev-<sha> last resort.`,
    );
  }

  // No fully-published release tag reachable from HEAD at all (e.g. a
  // shallow clone with no tags, or every reachable release tag is partial) —
  // there's no better option left, so fall back to dev-<sha> as a last
  // resort even though it almost certainly hasn't been published. This is the
  // most degraded outcome of all, so degrade() turns it into a hard failure
  // under CI/REQUIRE_PUBLISHED_IMAGE_TAG rather than shipping a bundle whose
  // very first `docker compose pull` is guaranteed to 404.
  const shortSha = git(['rev-parse', '--short', 'HEAD']);
  if (shortSha) {
    degrade(
      `No release tag reachable from HEAD (shallow clone?); falling back to ` +
        `"dev-${shortSha}", which has almost certainly NOT been published to GHCR and will ` +
        `fail to pull at first launch.`,
    );
    return `dev-${shortSha}`;
  }

  console.error(
    '  ✗ Could not resolve a CI_SERVER_IMAGE_TAG: not a git checkout and CI_SERVER_IMAGE_TAG ' +
      'is not set. Pass CI_SERVER_IMAGE_TAG=<a tag published under ' +
      'ghcr.io/companionintelligence/companion/*> explicitly.',
  );
  process.exit(1);
}

function writeImageTag(tag) {
  fs.mkdirSync(RESOURCES_DIR, { recursive: true });
  fs.writeFileSync(path.join(RESOURCES_DIR, 'image-tag.txt'), `${tag}\n`);
  console.log(`  image tag: ${tag}`);
}

console.log('Syncing desktop compose resources...');
copyComposeFiles();
writeImageTag(resolveImageTag());
console.log('Done.');

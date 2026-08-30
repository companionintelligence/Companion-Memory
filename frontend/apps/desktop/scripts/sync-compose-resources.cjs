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
//    nearest ancestor release tag reached from HEAD, since no `dev-<sha>`
//    image has ever actually been published to the registry and baking one
//    in just fails the pull silently at first launch (see README.md). A
//    dev-<sha> tag is used only as the very last resort, when no release tag
//    is reachable from HEAD at all (e.g. a shallow clone).
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

const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.production.yml'];

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

function resolveImageTag() {
  // An explicit override always wins (advanced/CI use — e.g. pinning to a
  // specific prior release without checking it out).
  if (process.env.CI_SERVER_IMAGE_TAG) {
    return process.env.CI_SERVER_IMAGE_TAG;
  }

  const exactTag = git(['describe', '--tags', '--exact-match']);
  if (exactTag) {
    // Same stripping publish.sh does — a local `v2026.7.27` tag and a CI-published
    // `2026.7.27` image tag must resolve to the identical string.
    return exactTag.replace(/^v/, '');
  }

  // No `dev-<sha>` image has ever been published to
  // ghcr.io/companionintelligence/companion/api, so falling straight back to
  // `dev-<sha>` here would bake in a tag Docker can never pull — the desktop
  // app would build fine and then fail silently at first launch. Fall back to
  // the nearest ancestor release tag instead: it's not exact, but it's real.
  const nearestTag = git(['describe', '--tags', '--abbrev=0']);
  if (nearestTag) {
    const resolved = nearestTag.replace(/^v/, '');
    console.warn(
      `  ⚠ HEAD is not an exact release tag; falling back to the nearest published release ` +
        `"${resolved}" instead. This is NOT the exact code in this checkout — cut and publish ` +
        `a real release for an exact match.`,
    );
    return resolved;
  }

  // No tag reachable from HEAD at all (e.g. a shallow clone) — there's no
  // better option left, so fall back to dev-<sha> as a last resort even
  // though it almost certainly hasn't been published.
  const shortSha = git(['rev-parse', '--short', 'HEAD']);
  if (shortSha) {
    console.warn(
      `  ⚠ No release tag reachable from HEAD (shallow clone?); falling back to ` +
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

#!/usr/bin/env node
// Zero-dependency sync step, run before every `tauri dev`/`tauri build`
// (see package.json's dev/build scripts).
//
// 1. Copies the repo root's docker-compose.yml + docker-compose.production.yml
//    into src-tauri/resources/ verbatim, so the bundled resources can never
//    drift from the real compose files (they are gitignored here — see
//    .gitignore — and always regenerated).
// 2. Resolves the CI-Server image tag this build should default to pulling,
//    using the SAME algorithm scripts/publish/publish.sh uses to name the
//    images it pushes (git describe --tags --exact-match, else a
//    dev-<short-sha> tag), and writes it to src-tauri/resources/image-tag.txt
//    — a bundled resource stack_manager.rs reads at runtime as the default
//    CI_SERVER_IMAGE_TAG. This deliberately never defaults to "latest":
//    publish.sh's own comments record that a stale companion/*:latest tag
//    previously orphaned (amd64-only, pointing at no real release), so a
//    desktop build instead always pins to the exact version it was built
//    from (or, for a dev build, a dev-<sha> tag — which only exists in the
//    registry if that commit was actually published; see README.md).
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

  const shortSha = git(['rev-parse', '--short', 'HEAD']);
  if (shortSha) {
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

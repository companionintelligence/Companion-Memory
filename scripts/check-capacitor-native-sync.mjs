#!/usr/bin/env node
/**
 * Verify the checked-in Android/iOS native projects declare every Capacitor
 * plugin that frontend/apps/{android,ios}/package.json depends on.
 *
 * `npx cap sync` regenerates capacitor.settings.gradle / app/capacitor.build.gradle
 * (Android) and ios/App/Podfile (iOS) from package.json — but nothing runs that
 * command automatically, and the mobile CI workflow that would catch a stale sync
 * is workflow_dispatch-only (see docs/CI.md). If a plugin is added to package.json
 * and `cap sync` is never re-run (or runs against a stale node_modules), the
 * plugin's native code silently never lands in the generated files: the app still
 * builds, the JS API exists, and only a runtime `undefined` on
 * window.Capacitor.Plugins.* would show the gap. Five Android plugins — camera,
 * push notifications, background geolocation, sqlite, powersync — sat in exactly
 * this state for over a week before anyone noticed.
 *
 * This is a static, dependency-free approximation of what `cap sync` computes
 * (Capacitor's own name → gradle-project / pod-name rule), not a substitute for
 * actually running it — it catches a plugin being entirely absent from the
 * generated files, not a stale version or a subtler config drift.
 *
 * Called two ways, matching scripts/check-ci-namespace.sh: lint-staged passes the
 * staged offending files (ignored — this check is inherently cross-file, so it
 * always re-derives the full comparison), and `make lint` / a bare run call it
 * with no arguments to scan the whole tree.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Packages that ship no native plugin code of their own — the Capacitor
// runtime/core/tooling, not a plugin with a gradle project or a pod.
const NOT_A_PLUGIN = new Set(['@capacitor/core', '@capacitor/cli', '@capacitor/android', '@capacitor/ios']);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Capacitor's own naming rule: strip the leading '@', turn '/' into '-'. */
function gradleProjectName(pkgName) {
  return pkgName.replace(/^@/, '').replace(/\//g, '-');
}

/** iOS pod names PascalCase each '-'-separated segment of the gradle-style name. */
function podName(pkgName) {
  return gradleProjectName(pkgName)
    .split('-')
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join('');
}

/**
 * For an in-repo @ci/* plugin, does its own manifest declare support for `platform`?
 * Third-party plugins can't be inspected without node_modules — assume yes (true for
 * everything currently in these dependency lists) rather than risk a false negative.
 */
function supportsPlatform(pkgName, platform) {
  if (!pkgName.startsWith('@ci/')) {
    return true;
  }

  const manifestPath = join('frontend/packages', pkgName.slice('@ci/'.length), 'package.json');
  if (!existsSync(manifestPath)) {
    return true;
  }

  const capacitor = readJson(manifestPath).capacitor;
  if (!capacitor) {
    return true;
  }

  return Boolean(capacitor[platform]);
}

function pluginDeps(pkgJsonPath) {
  const manifest = readJson(pkgJsonPath);

  return Object.keys(manifest.dependencies ?? {}).filter((name) => !NOT_A_PLUGIN.has(name));
}

const problems = [];

// --- Android ---
const androidPkgPath = 'frontend/apps/android/package.json';
const settingsGradlePath = 'frontend/apps/android/android/capacitor.settings.gradle';
const buildGradlePath = 'frontend/apps/android/android/app/capacitor.build.gradle';

if (existsSync(androidPkgPath) && existsSync(settingsGradlePath) && existsSync(buildGradlePath)) {
  const settingsGradle = readFileSync(settingsGradlePath, 'utf8');
  const buildGradle = readFileSync(buildGradlePath, 'utf8');
  for (const pkg of pluginDeps(androidPkgPath)) {
    if (!supportsPlatform(pkg, 'android')) {
      continue;
    }

    const name = gradleProjectName(pkg);
    const missingInclude = !settingsGradle.includes(`include ':${name}'`);
    const missingImpl = !buildGradle.includes(`implementation project(':${name}')`);
    if (missingInclude || missingImpl) {
      problems.push(
        `Android: '${pkg}' is a dependency in ${androidPkgPath} but ':${name}' is missing from ` +
          `${missingInclude ? settingsGradlePath : buildGradlePath}. Run ` +
          `'cd frontend/apps/android && yarn install && npx cap sync android' and commit the result.`,
      );
    }
  }
}

// --- iOS ---
const iosPkgPath = 'frontend/apps/ios/package.json';
const podfilePath = 'frontend/apps/ios/ios/App/Podfile';

if (existsSync(iosPkgPath) && existsSync(podfilePath)) {
  const podfile = readFileSync(podfilePath, 'utf8');
  for (const pkg of pluginDeps(iosPkgPath)) {
    if (!supportsPlatform(pkg, 'ios')) {
      continue;
    }

    const name = podName(pkg);
    if (!podfile.includes(`pod '${name}'`)) {
      problems.push(
        `iOS: '${pkg}' is a dependency in ${iosPkgPath} but pod '${name}' is missing from ` +
          `${podfilePath}. Run 'cd frontend/apps/ios && yarn install && LANG=en_US.UTF-8 npx cap sync ios' ` +
          `and commit the result.`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error('capacitor native plugin drift detected — a package.json dependency never made it');
  console.error('into the generated native project (see frontend/apps/{android,ios}/README for cap sync):\n');
  for (const p of problems) {
    console.error(`  - ${p}`);
  }

  console.error('');
  process.exit(1);
}

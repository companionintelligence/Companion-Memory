#!/usr/bin/env node
/**
 * `yarn android` — build the shell, install it on a device and launch it
 * (`cap run android`), with two things the bare Capacitor CLI gets wrong for
 * local development done for it first.
 *
 * 1. Where the Android SDK is. The CLI's device runner (native-run) reads
 *    ANDROID_HOME / ANDROID_SDK_ROOT only, then a fixed `~/Android/sdk` that
 *    does not even match Android Studio's `~/Android/Sdk` on Linux. It never
 *    reads `android/local.properties`, which Gradle needs anyway and Android
 *    Studio writes on first open. This resolves the SDK exactly as the
 *    Makefile's `android_sdk_dir` does — ANDROID_HOME, then ANDROID_SDK_ROOT,
 *    then `sdk.dir` from local.properties — and NEVER guesses a path: an unset
 *    SDK is an error with the fix in it, not a default that silently points
 *    somewhere wrong on the next machine.
 *
 * 2. The USB tunnel for live reload. When CAP_SERVER_URL names the device's
 *    own `localhost`, the dev server has to be reachable there, which is
 *    `adb reverse`. The rule lives in the adb server and is gone after every
 *    phone reboot (a blank app afterwards is the symptom), so it is re-applied
 *    on every run. A LAN / tailnet URL needs no tunnel, and a bundled build
 *    (no CAP_SERVER_URL) needs none either; both skip it. The same goes for
 *    the dev PowerSync service: the api hands the phone the POWERSYNC_URL from
 *    the root .env verbatim, so when that is a loopback URL its port is
 *    tunnelled too, or the phone's working set never syncs and nothing says why.
 *
 * Plain CommonJS with no dependencies: the Capacitor shells are outside the
 * Yarn workspaces (see the root package.json) and this must run before
 * anything else is resolved.
 *
 * Every argument is passed through to `cap run android` (`--target <id>`,
 * `--list`, `--no-sync`, …). `--target` is also honoured by the tunnel step.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
const ROOT_ENV = path.resolve(APP_DIR, '..', '..', '..', '.env');
const LOCAL_PROPERTIES = path.join(APP_DIR, 'android', 'local.properties');
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function fail(message) {
  process.stderr.write(`\n✗ ${message}\n\n`);
  process.exit(1);
}

/**
 * `sdk.dir` as Android Studio writes it into local.properties. The file is in
 * Java .properties format, so Windows paths come escaped
 * (`C\:\\Users\\me\\AppData\\Local\\Android\\Sdk`); unescape them.
 */
function sdkDirFromLocalProperties() {
  let text;
  try {
    text = fs.readFileSync(LOCAL_PROPERTIES, 'utf8');
  } catch {
    return '';
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*sdk\.dir\s*=\s*(.*)$/.exec(line);
    if (match) {
      return match[1].trim().replace(/\\(.)/g, '$1');
    }
  }
  return '';
}

/** The Makefile's `android_sdk_dir`, verbatim in precedence and in what it refuses to do. */
function resolveSdkDir(env) {
  const sdk = (env.ANDROID_HOME || env.ANDROID_SDK_ROOT || sdkDirFromLocalProperties()).trim();
  if (!sdk) {
    fail(
      'No Android SDK found. Set ANDROID_HOME (or ANDROID_SDK_ROOT) to your SDK root, ' +
        `or put sdk.dir=/path/to/sdk in ${path.relative(process.cwd(), LOCAL_PROPERTIES)} ` +
        '(Android Studio writes it when it opens the project).',
    );
  }
  if (!fs.existsSync(sdk) || !fs.statSync(sdk).isDirectory()) {
    fail(`Android SDK path '${sdk}' is not a directory. Fix ANDROID_HOME / ANDROID_SDK_ROOT.`);
  }
  return sdk;
}

/** The `--target <id>` / `--target=<id>` the caller is giving `cap run`, if any. */
function targetFromArgs(args) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--target') {
      return args[i + 1] || '';
    }
    if (args[i].startsWith('--target=')) {
      return args[i].slice('--target='.length);
    }
  }
  return '';
}

/**
 * One `KEY=value` out of the root .env, unquoted, or '' — the three lines of
 * dotenv this script needs, kept dependency-free like the rest of it. A
 * value already in the environment wins, as it does for the api.
 */
function rootEnvValue(key, env) {
  if (env[key]) {
    return env[key];
  }
  let text;
  try {
    text = fs.readFileSync(ROOT_ENV, 'utf8');
  } catch {
    return '';
  }
  let value = '';
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match && match[1] === key) {
      value = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return value;
}

/** The port to tunnel when `serverUrl` is the device's own loopback, else null. */
function reversePort(serverUrl, name = 'CAP_SERVER_URL') {
  if (!serverUrl) {
    return null;
  }
  let url;
  try {
    url = new URL(serverUrl);
  } catch {
    fail(`${name} '${serverUrl}' is not a URL.`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname === '::1' ? '[::1]' : url.hostname)) {
    return null;
  }
  return url.port || (url.protocol === 'https:' ? '443' : '80');
}

function adbReverse(sdk, port, target, env) {
  const bundled = path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
  const adb = fs.existsSync(bundled) ? bundled : 'adb';
  const serial = target || env.ANDROID_SERIAL || '';
  const args = [...(serial ? ['-s', serial] : []), 'reverse', `tcp:${port}`, `tcp:${port}`];
  // adb echoes the bound port on stdout; it adds nothing to the line printed below.
  const result = spawnSync(adb, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
  if (result.error) {
    fail(`Could not run adb (${result.error.message}). Install platform-tools into the SDK at ${sdk}.`);
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim();
    const hint = /more than one/.test(stderr)
      ? ' Several devices are attached: pass --target <serial> (see `adb devices -l`) or set ANDROID_SERIAL.'
      : '';
    fail(`adb reverse tcp:${port} failed: ${stderr || `exit ${result.status}`}.${hint}`);
  }
  process.stdout.write(`✓ adb reverse tcp:${port} → host :${port}${serial ? ` on ${serial}` : ''}\n`);
}

function main() {
  const args = process.argv.slice(2);
  const sdk = resolveSdkDir(process.env);
  // Both names, so native-run and Gradle agree with each other and with the Makefile.
  const env = { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT || sdk };
  process.stdout.write(`✓ Android SDK at ${sdk}\n`);

  if (!args.includes('--list')) {
    const ports = new Set(
      [
        reversePort(env.CAP_SERVER_URL),
        reversePort(rootEnvValue('POWERSYNC_URL', env), 'POWERSYNC_URL'),
      ].filter(Boolean),
    );
    for (const port of ports) {
      adbReverse(sdk, port, targetFromArgs(args), env);
    }
  }

  const cap = require.resolve('@capacitor/cli/bin/capacitor', { paths: [APP_DIR] });
  const result = spawnSync(process.execPath, [cap, 'run', 'android', ...args], {
    cwd: APP_DIR,
    env,
    stdio: 'inherit',
  });
  if (result.error) {
    fail(result.error.message);
  }
  process.exit(result.status === null ? 1 : result.status);
}

main();

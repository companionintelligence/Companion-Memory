#!/usr/bin/env node
/**
 * Fail when the app can no longer be pinch-zoomed (WCAG 1.4.4 Resize Text).
 *
 * Three places can switch zoom off, and each one is enough on its own:
 *
 *   1. A viewport meta with `user-scalable=no` (or 0), or a `maximum-scale` below 5.
 *      `frontend/apps/web/index.html` carried `maximum-scale=1.0`, so the web app could not be
 *      zoomed in a browser and, because both shells load that same page, not in the apps either.
 *      Five is axe's `meta-viewport-large` threshold; WCAG itself only needs 2 (200%).
 *   2. The iOS shell. Capacitor's `zoomEnabled` defaults to false, and CAPBridgeViewController then
 *      gives the web view's scroll view a delegate whose `scrollViewWillBeginZooming` switches the
 *      pinch recogniser off, whatever the page says.
 *   3. The Android shell. Same default; Bridge.java then calls
 *      `WebSettings.setBuiltInZoomControls(false)`, which disables the pinch gesture.
 *
 * Neither shell turns zoom on unless a config says so, so a rewrite that quietly drops
 * `zoomEnabled: true` puts the lock back with no error anywhere.
 *
 * Static and dependency-free like its siblings (check-capacitor-native-sync.mjs): `make lint` and
 * lint-staged run it with plain `node`, and a capacitor.config.ts cannot be imported without a
 * TypeScript loader, so the shells' configs are read as text. check-viewport-zoom.test.ts holds
 * that reading to the evaluated configs.
 *
 * Called two ways: lint-staged passes the staged files (ignored: the check is cheap and always
 * covers the whole tree), and `make lint` or a bare run calls it with no arguments.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** axe's `meta-viewport-large` threshold. WCAG 1.4.4 only needs 2. */
export const MIN_MAXIMUM_SCALE = 5;

export const CAPACITOR_CONFIGS = {
  ios: 'frontend/apps/ios/capacitor.config.ts',
  android: 'frontend/apps/android/capacitor.config.ts',
};

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Where a viewport meta can live: HTML files, and the TS/JS template strings that serve a page
// (connectConsentPage.ts, signupConfirmPage.ts, graphiql.html.ts). Fixtures and tests carry
// third-party exports and deliberate bad examples.
const VIEWPORT_PATHSPEC = [
  '*.html',
  '*.htm',
  '*.ts',
  '*.tsx',
  '*.js',
  '*.mjs',
  ':(exclude,glob)**/node_modules/**',
  ':(exclude,glob)**/dist/**',
  ':(exclude,glob)**/fixtures/**',
  ':(exclude,glob)**/__tests__/**',
  ':(exclude,glob)**/*.test.*',
];

/** Every `<meta name="viewport" content="…">` in a source file, as { content, line }. */
export function viewportMetas(source) {
  const metas = [];
  for (const tag of source.matchAll(/<meta\b[^>]*>/gi)) {
    if (!/\bname\s*=\s*["']?viewport\b/i.test(tag[0])) {
      continue;
    }

    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag[0]);
    if (content) {
      metas.push({ content: content[1] ?? content[2], line: source.slice(0, tag.index).split('\n').length });
    }
  }

  return metas;
}

/** `width=device-width, initial-scale=1` as a Map. Browsers split on commas, semicolons and spaces. */
export function parseViewport(content) {
  const settings = new Map();
  for (const part of content
    .toLowerCase()
    .replace(/\s*=\s*/g, '=')
    .split(/[\s,;]+/)) {
    const [key, ...value] = part.split('=');
    if (key) {
      settings.set(key, value.join('='));
    }
  }

  return settings;
}

/** @returns {string[]} one message per viewport meta setting in `source` that blocks zoom */
export function viewportProblems(source, file) {
  const problems = [];
  for (const { content, line } of viewportMetas(source)) {
    const settings = parseViewport(content);

    const scalable = settings.get('user-scalable');
    if (scalable !== undefined && scalable !== 'yes' && !(Math.abs(Number(scalable)) >= 1)) {
      problems.push(
        `${file}:${line}: viewport meta has user-scalable=${scalable}, which blocks pinch-zoom. Remove it.`,
      );
    }

    const max = settings.get('maximum-scale');
    if (max !== undefined && !(Number(max) >= MIN_MAXIMUM_SCALE)) {
      problems.push(
        `${file}:${line}: viewport meta has maximum-scale=${max}, which blocks or caps pinch-zoom. ` +
          `Remove it, or set it to ${MIN_MAXIMUM_SCALE} or more.`,
      );
    }
  }

  return problems;
}

/**
 * Comments removed and string contents flattened, with the structural characters inside strings
 * defused, so braces and keys can be read without a comment or a URL fooling the scan. Letters
 * stay, because a key can be quoted.
 */
function codeOnly(source) {
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') {
        i++;
      }

      out += '\n';
    } else if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop - 1;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== c) {
        j += source[j] === '\\' ? 2 : 1;
      }

      out += c + source.slice(i + 1, j).replace(/[{}[\]():,;/\\]/g, '_') + c;
      i = j;
    } else {
      out += c;
    }
  }

  return out;
}

// `key: {` (opens), `key: value`, or a bare brace. A key is a name or a quoted string.
const PROPERTY_OR_BRACE =
  /(?<key>[A-Za-z_$][\w$]*|"[^"]*"|'[^']*')\s*:(?:\s*(?<opens>\{)|\s*(?<value>[^\s,{}]*))|[{}]/g;

/**
 * Every `zoomEnabled: <value>` that sits where Capacitor reads it: directly in the config object
 * (scope 'top') or directly in its `ios` / `android` block. Anything deeper, such as a plugin's
 * options or an object spread in, is not read as the shell's zoom setting and is left out.
 *
 * @returns {Array<{ scope: string, value: string }>}
 */
function zoomSettings(source) {
  const found = [];
  const stack = []; // the key that opened each open `{`; null when nothing named it

  for (const m of codeOnly(source).matchAll(PROPERTY_OR_BRACE)) {
    const { opens, value } = m.groups;
    const key = m.groups.key?.replace(/^["']|["']$/g, '');
    if (m[0] === '{') {
      stack.push(null);
    } else if (m[0] === '}') {
      stack.pop();
    } else if (opens) {
      stack.push(key);
    } else if (key === 'zoomEnabled' && stack[0] === null && stack.length <= 2) {
      const scope = stack.length === 1 ? 'top' : stack[1];
      if (scope === 'top' || scope === 'ios' || scope === 'android') {
        found.push({ scope, value });
      }
    }
  }

  return found;
}

/**
 * Whether the shell for `platform` ends up with zoom on, resolved the way Capacitor resolves it:
 * the platform's own boolean wins, then the top-level boolean, then false.
 */
export function effectiveCapacitorZoom(source, platform) {
  const found = zoomSettings(source);
  for (const scope of [platform, 'top']) {
    const value = found.findLast((setting) => setting.scope === scope)?.value;
    if (value === 'true' || value === 'false') {
      return value === 'true';
    }
  }

  return false;
}

/** @returns {string[]} a message when the shell for `platform` does not enable zoom, else none */
export function capacitorZoomProblems(source, platform, file) {
  if (effectiveCapacitorZoom(source, platform)) {
    return [];
  }

  const [name, effect] =
    platform === 'ios'
      ? ['iOS', 'CAPBridgeViewController then switches the web view pinch recogniser off']
      : ['Android', 'Bridge.java then calls WebSettings.setBuiltInZoomControls(false)'];

  return [
    `${file}: pinch-zoom is off in the ${name} shell. \`${platform}.zoomEnabled\` is not literally true and ` +
      `Capacitor defaults it to false; ${effect}. Set \`${platform}: { zoomEnabled: true }\`.`,
  ];
}

/** Tracked files that carry a viewport meta. `git grep` exits 1 when there are none. */
function viewportFiles(rootDir) {
  try {
    return execFileSync(
      'git',
      ['grep', '-l', '-I', '-i', '-E', `name=['"]?viewport`, '--', ...VIEWPORT_PATHSPEC],
      { cwd: rootDir, encoding: 'utf8' },
    )
      .split('\n')
      .filter((file) => file && file !== 'scripts/check-viewport-zoom.mjs');
  } catch (error) {
    if (error.status === 1) {
      return [];
    }

    throw error;
  }
}

/** @returns {string[]} every problem in the tree at `rootDir` */
export function collectViewportZoomProblems(rootDir = REPO_ROOT) {
  const problems = [];

  for (const file of viewportFiles(rootDir)) {
    problems.push(...viewportProblems(readFileSync(join(rootDir, file), 'utf8'), file));
  }

  for (const [platform, file] of Object.entries(CAPACITOR_CONFIGS)) {
    if (existsSync(join(rootDir, file))) {
      problems.push(...capacitorZoomProblems(readFileSync(join(rootDir, file), 'utf8'), platform, file));
    } else {
      problems.push(`${file}: not found, so the ${platform} shell's zoom setting cannot be checked.`);
    }
  }

  return problems;
}

export function runViewportZoomCli(rootDir = REPO_ROOT) {
  const problems = collectViewportZoomProblems(rootDir);
  if (problems.length === 0) {
    return 0;
  }

  console.error('pinch-zoom is blocked (WCAG 1.4.4 Resize Text); low-vision users cannot enlarge the app:\n');
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }

  console.error('');

  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(runViewportZoomCli());
}

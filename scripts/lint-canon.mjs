#!/usr/bin/env node
/*
 * lint-canon.mjs — Companion Intelligence design-canon guard
 * ============================================================================
 * ZERO-DEPENDENCY Node ESM CLI (Node built-ins only). Copy this file into any
 * CI repo and run it to guard the shared design system against drift.
 *
 * USAGE:
 *   node scripts/lint-canon.mjs [targetDir]
 *
 *   targetDir  Directory to scan (default: process.cwd()).
 *
 * WHAT IT CHECKS:
 *   (a) FAIL (exit 1) — every `--primary:` declared in any *.css file must
 *       resolve to the canonical CI teal:
 *         - light  #0f717a  or  oklch(50.2043% 0.0822 204.9225)  (L~0.50 h~205)
 *         - dark   #abd4d8  or  oklch(84.195% 0.043 203.701)     (L~0.84 h~204)
 *       Hex is matched case-insensitively. A `--primary` that is present but
 *       does NOT resolve to teal (e.g. a navy `#0f172b`) fails the build.
 *   (b) WARN (no fail) — hardcoded hex colors in *.tsx / *.jsx component source:
 *         - Tailwind arbitrary values:  bg-[#..], text-[#..], border-[#..], etc.
 *         - inline styles:              color/background(-color): #..
 *       Reference a semantic token instead (bg-primary, text-muted-foreground …).
 *
 * Skips node_modules / dist / .git / out. Prints a file:line report.
 *
 * Exit codes: 0 = canon OK (warnings allowed), 1 = a non-canon --primary found.
 * ============================================================================
 */

import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'out']);

// ---- Canon reference -------------------------------------------------------
const CANON_HEX = new Set(['#0f717a', '#abd4d8']);
// Known canonical oklch strings (whitespace-normalized, lowercased).
const CANON_OKLCH = new Set([
  'oklch(50.2043% 0.0822 204.9225)',
  'oklch(84.195% 0.043 203.701)',
]);
// Numeric oklch acceptance window (belt-and-suspenders around the known strings):
//   light  L ~ 0.50 (50%),  h ~ 205
//   dark   L ~ 0.84 (84%),  h ~ 204
const OKLCH_CANON_RANGES = [
  { lMin: 48, lMax: 52, hMin: 203, hMax: 207 }, // light teal
  { lMin: 82, lMax: 86, hMin: 202, hMax: 206 }, // dark teal
];

// ---- ANSI (skipped when not a TTY) -----------------------------------------
const useColor = process.stdout.isTTY;
const c = (code, s) => (useColor ? `[${code}m${s}[0m` : s);
const red = (s) => c('31', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const dim = (s) => c('2', s);
const bold = (s) => c('1', s);

// ---- Helpers ---------------------------------------------------------------

/** Recursively collect files under `dir`, skipping SKIP_DIRS. */
async function collectFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...(await collectFiles(join(dir, entry.name))));
    } else if (entry.isFile()) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** Turn a byte index into a 1-based line number for reporting. */
function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

/** Normalize an oklch() string: lowercase, collapse internal whitespace. */
function normalizeOklch(raw) {
  return raw
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim();
}

/**
 * Decide whether a `--primary` value string is canonical teal.
 * Accepts a hex (#0f717a / #abd4d8, case-insensitive) or a canon oklch (by
 * known string OR by numeric L/h window). Returns { ok, kind }.
 */
function isCanonPrimary(value) {
  const v = value.trim();

  // Hex form (#rgb or #rrggbb, case-insensitive)
  const hexMatch = v.match(/#[0-9a-fA-F]{3,8}\b/);
  if (hexMatch) {
    if (CANON_HEX.has(hexMatch[0].toLowerCase())) return { ok: true, kind: 'hex' };
    return { ok: false, kind: 'hex' };
  }

  // oklch form
  const oklchMatch = v.match(/oklch\([^)]*\)/i);
  if (oklchMatch) {
    const norm = normalizeOklch(oklchMatch[0]);
    if (CANON_OKLCH.has(norm)) return { ok: true, kind: 'oklch' };
    // Numeric window fallback: oklch(L[%] C H ...)
    const nums = norm
      .replace(/^oklch\(/, '')
      .replace(/\)$/, '')
      .replace(/\/.*/, '') // drop any alpha component
      .trim()
      .split(/[\s,]+/);
    if (nums.length >= 3) {
      // Lightness may be written as a percentage ("50.2043%" -> 50.2043) or as a
      // bare 0–1 fraction ("0.502" -> 50.2). The acceptance window below is in
      // percentage units, so normalize a fraction-form L (no '%', value ≤ 1) ×100.
      let L = parseFloat(nums[0]);
      if (!nums[0].includes('%') && Number.isFinite(L) && L <= 1) L *= 100;
      const H = parseFloat(nums[2]);
      if (Number.isFinite(L) && Number.isFinite(H)) {
        for (const r of OKLCH_CANON_RANGES) {
          if (L >= r.lMin && L <= r.lMax && H >= r.hMin && H <= r.hMax) {
            return { ok: true, kind: 'oklch' };
          }
        }
      }
    }
    return { ok: false, kind: 'oklch' };
  }

  // References like var(...) or a named color — cannot resolve statically.
  // Treat as unknown (do NOT fail): only concrete hex/oklch values are gated.
  return { ok: true, kind: 'unresolved' };
}

// ---- Checks ----------------------------------------------------------------

const PRIMARY_RE = /(^|[^-\w])--primary\s*:\s*([^;}\n]+)/g;

/** Check a CSS file's `--primary` declarations. Returns array of failures. */
function checkCssPrimary(text, relPath) {
  const failures = [];
  let m;
  PRIMARY_RE.lastIndex = 0;
  while ((m = PRIMARY_RE.exec(text)) !== null) {
    const rawValue = m[2].trim();
    const valueIndex = m.index + m[0].indexOf(rawValue);
    const verdict = isCanonPrimary(rawValue);
    if (!verdict.ok) {
      failures.push({
        file: relPath,
        line: lineAt(text, valueIndex),
        value: rawValue,
        kind: verdict.kind,
      });
    }
  }
  return failures;
}

// Arbitrary Tailwind hex utilities: bg-[#fff], text-[#0a222e], border-[#abc123], etc.
const TW_ARBITRARY_HEX_RE = /\b(?:bg|text|border|fill|stroke|ring|from|via|to|shadow|outline|decoration|caret|accent|divide|placeholder)-\[#[0-9a-fA-F]{3,8}\]/g;
// Inline-style hex: color: #.., background: #.., backgroundColor: '#..'
const INLINE_STYLE_HEX_RE = /(?:background(?:-?color)?|color)\s*:\s*['"]?#[0-9a-fA-F]{3,8}\b/gi;

/** Scan a component file for hardcoded hex. Returns array of warnings. */
function checkComponentHex(text, relPath) {
  const warnings = [];
  for (const re of [TW_ARBITRARY_HEX_RE, INLINE_STYLE_HEX_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      warnings.push({
        file: relPath,
        line: lineAt(text, m.index),
        snippet: m[0],
      });
    }
  }
  return warnings;
}

// ---- Main ------------------------------------------------------------------

async function main() {
  const targetDir = process.argv[2] ? process.argv[2] : process.cwd();

  const files = await collectFiles(targetDir);
  if (files.length === 0) {
    console.error(red(`lint-canon: no files found under ${targetDir}`));
    process.exit(1);
  }

  const failures = [];
  const warnings = [];
  let cssScanned = 0;
  let componentScanned = 0;

  for (const file of files) {
    const ext = extname(file).toLowerCase();
    const rel = relative(targetDir, file) || file;

    if (ext === '.css') {
      let text;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      cssScanned++;
      failures.push(...checkCssPrimary(text, rel));
    } else if (ext === '.tsx' || ext === '.jsx') {
      let text;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      componentScanned++;
      warnings.push(...checkComponentHex(text, rel));
    }
  }

  // ---- Report --------------------------------------------------------------
  console.log(bold('\nCI design-canon lint'));
  console.log(dim(`  target: ${targetDir}`));
  console.log(
    dim(`  scanned: ${cssScanned} css file(s), ${componentScanned} component file(s)\n`),
  );

  if (warnings.length > 0) {
    console.log(yellow(bold(`⚠ ${warnings.length} hardcoded-hex warning(s):`)));
    for (const w of warnings) {
      console.log(`  ${yellow('warn')} ${w.file}:${w.line}  ${dim(w.snippet)}`);
    }
    console.log(dim('  → prefer a semantic token (bg-primary, text-muted-foreground, …)\n'));
  }

  if (failures.length > 0) {
    console.log(red(bold(`✖ ${failures.length} non-canon --primary value(s):`)));
    for (const f of failures) {
      console.log(
        `  ${red('FAIL')} ${f.file}:${f.line}  --primary: ${bold(f.value)}  ${dim('(' + f.kind + ')')}`,
      );
    }
    console.log(
      red(
        '\n  --primary must be CI teal: #0f717a / #abd4d8 ' +
          '(or oklch light L~0.50 h~205 / dark L~0.84 h~204).',
      ),
    );
    console.log(red(bold('\nlint-canon: FAILED\n')));
    process.exit(1);
  }

  console.log(green(bold('✔ lint-canon: canon OK')) + dim(' (all --primary values are CI teal)\n'));
  process.exit(0);
}

main().catch((err) => {
  console.error(red('lint-canon: unexpected error'), err);
  process.exit(1);
});

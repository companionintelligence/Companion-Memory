#!/usr/bin/env node
// CI design-canon lint gate — fails if any `--primary` CSS custom property is not the Companion
// Intelligence teal (light #0f717a / dark #abd4d8), in ANY notation (hex, rgb, hsl, bare hsl-triplet,
// oklch with % or 0–1 lightness, oklab). Warns (non-fatal) on hardcoded hex in component source.
// Zero dependencies (Node built-ins only). Usage: node scripts/lint-canon.mjs [targetDir]
//
// Canon source of truth: @companionintelligence/tokens (CI-Common) / CI-Hub globals.css.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

const TARGET = process.argv[2] || '.';
const CANON = [
  { name: 'teal-light', rgb: [15, 113, 122] }, // #0f717a
  { name: 'teal-dark', rgb: [171, 212, 216] }, // #abd4d8
];
const TOLERANCE = 14; // euclidean sRGB distance; exact canon = 0, off-brand navy/mint >> 14
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.turbo', 'coverage', 'vendor', '.cache', 'target', '.output', '.vercel']);

// ---------- color parsing -> sRGB [0..255] or null ----------
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const srgbGamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

function oklchToRgb(L, C, H) {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const rl = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const gl = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return [rl, gl, bl].map((v) => Math.round(clamp(srgbGamma(v), 0, 1) * 255));
}
function oklabToRgb(L, a, b) { return oklchToRgb(L, Math.hypot(a, b), (Math.atan2(b, a) * 180) / Math.PI); }
function hslToRgb(H, S, L) {
  H = ((H % 360) + 360) % 360; S /= 100; L /= 100;
  const c = (1 - Math.abs(2 * L - 1)) * S, x = c * (1 - Math.abs(((H / 60) % 2) - 1)), m = L - c / 2;
  let r = 0, g = 0, b = 0;
  if (H < 60) [r, g, b] = [c, x, 0]; else if (H < 120) [r, g, b] = [x, c, 0];
  else if (H < 180) [r, g, b] = [0, c, x]; else if (H < 240) [r, g, b] = [0, x, c];
  else if (H < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
  return [r, g, b].map((v) => Math.round((v + m) * 255));
}
const num = (s) => parseFloat(s);
// lightness token: "50.2%" -> 50.2 ; "0.502" -> 50.2 ; "50" -> 50
const lPct = (s) => { s = s.trim(); if (s.endsWith('%')) return num(s); const n = num(s); return n <= 1 ? n * 100 : n; };
const lFrac = (s) => lPct(s) / 100;

function parseColor(raw) {
  let v = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/!important/i, '').trim();
  if (/var\(/i.test(v)) return null; // unresolvable reference — skip
  let m = v.match(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  m = v.match(/^rgba?\(([^)]+)\)$/i);
  if (m) { const p = m[1].split(/[,\s/]+/).filter(Boolean); return [num(p[0]), num(p[1]), num(p[2])].map((x) => Math.round(x)); }
  m = v.match(/^hsla?\(([^)]+)\)$/i);
  if (m) { const p = m[1].split(/[,\s/]+/).filter(Boolean); return hslToRgb(num(p[0]), num(p[1]), num(p[2])); }
  m = v.match(/^oklch\(([^)]+)\)$/i);
  if (m) { const p = m[1].split(/[\s/]+/).filter(Boolean); return oklchToRgb(lFrac(p[0]), num(p[1]), num(p[2])); }
  m = v.match(/^oklab\(([^)]+)\)$/i);
  if (m) { const p = m[1].split(/[\s/]+/).filter(Boolean); return oklabToRgb(lFrac(p[0]), num(p[1]), num(p[2])); }
  // bare shadcn hsl triplet: "185 78.1% 26.9%" (H S% L%)
  m = v.match(/^(-?\d*\.?\d+)\s+(-?\d*\.?\d+)%\s+(-?\d*\.?\d+)%$/);
  if (m) return hslToRgb(num(m[1]), num(m[2]), num(m[3]));
  return null;
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const isCanonTeal = (rgb) => CANON.some((c) => dist(rgb, c.rgb) <= TOLERANCE);

// ---------- file walking ----------
function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (!IGNORE_DIRS.has(e)) walk(p, out); }
    else out.push(p);
  }
  return out;
}
const cssText = (file, ext) => {
  const raw = readFileSync(file, 'utf8');
  if (['.html', '.htm', '.vue', '.svelte', '.astro'].includes(ext)) {
    return [...raw.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
  }
  return raw;
};
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

// ---------- scan ----------
const CSS_EXT = new Set(['.css', '.scss', '.sass', '.less', '.html', '.htm', '.vue', '.svelte', '.astro']);
const COMP_EXT = new Set(['.tsx', '.jsx', '.ts', '.js', '.vue', '.svelte', '.astro', '.html', '.htm']);
const PRIMARY_RE = /(?:^|[^\w-])--primary\s*:\s*([^;}\n]+)/g;
const HARDHEX_RE = /(?:bg-\[|text-\[|border-\[|from-\[|to-\[|fill=["']?|stroke=["']?|(?:background|color|fill|stroke)\s*[:=]\s*["']?)#([0-9a-fA-F]{3,8})\b/g;

const files = statSync(TARGET).isDirectory() ? walk(TARGET) : [TARGET];
const fails = [];
const warns = [];
let cssScanned = 0, compScanned = 0;

for (const f of files) {
  const ext = extname(f).toLowerCase();
  const rel = relative(process.cwd(), f) || f;
  if (CSS_EXT.has(ext)) {
    cssScanned++;
    const text = cssText(f, ext);
    for (const m of text.matchAll(PRIMARY_RE)) {
      const val = m[1].trim();
      const rgb = parseColor(val);
      if (rgb === null) continue;
      if (!isCanonTeal(rgb)) fails.push({ rel, line: lineOf(text, m.index), val, rgb });
    }
  }
  if (COMP_EXT.has(ext)) {
    compScanned++;
    const raw = readFileSync(f, 'utf8');
    for (const m of raw.matchAll(HARDHEX_RE)) warns.push({ rel, line: lineOf(raw, m.index), hex: '#' + m[1] });
  }
}

// ---------- report ----------
console.log('CI design-canon lint');
console.log(`  target: ${TARGET}`);
console.log(`  scanned: ${cssScanned} css/markup file(s), ${compScanned} component file(s)`);
console.log('');
if (warns.length) {
  console.log(`⚠ ${warns.length} hardcoded-hex warning(s) (non-blocking):`);
  for (const w of warns.slice(0, 40)) console.log(`  warn ${w.rel}:${w.line}  ${w.hex}`);
  if (warns.length > 40) console.log(`  … and ${warns.length - 40} more`);
  console.log('');
}
if (fails.length) {
  console.log(`✖ ${fails.length} non-canon --primary value(s):`);
  for (const x of fails) console.log(`  FAIL ${x.rel}:${x.line}  --primary: ${x.val}  -> rgb(${x.rgb.join(',')})`);
  console.log('');
  console.log('  --primary must be CI teal: #0f717a (light) / #abd4d8 (dark), in any notation.');
  console.log('lint-canon: FAILED');
  process.exit(1);
}
console.log('✔ lint-canon: canon OK (all resolvable --primary values are CI teal)');
process.exit(0);

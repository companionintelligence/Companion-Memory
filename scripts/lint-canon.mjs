#!/usr/bin/env node
// CI design-canon lint gate (v3). Zero deps. Usage: node scripts/lint-canon.mjs [targetDir]
//  FAIL: any `--primary` custom property that is not CI phthalo (#0a6358 / #c5e8dc), any notation.
//  WARN (non-blocking): CI-token `var(--X)` used but never defined (partial-swap bug);
//        enriched token used as a Tailwind utility but not mapped in `@theme` (v4 fallback-to-default bug);
//        hardcoded hex in component source.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

const TARGET = process.argv[2] || '.';
const CANON = [{ rgb: [10, 99, 88] }, { rgb: [197, 232, 220] }]; // #0a6358 / #c5e8dc
const TOL = 14;
const IGNORE = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  'coverage',
  'vendor',
  '.cache',
  'target',
  '.output',
  '.vercel',
]);
// CI design-token namespace the transition manages — undefined uses of these are real bugs.
const CI_TOKENS =
  /^--(primary|secondary|muted|accent|destructive|success|warning|info|border|input|ring|card|popover|background|foreground|sidebar|chart-\d|teal-\d{2,3}|aqua|aqua-light|mint|teal-accent|teal-mid|gradient-\w+|shadow-(sm|md|lg)|radius-\w+)(-foreground)?$/;
// standard/framework vars that are legitimately defined elsewhere (never flag as undefined)
const FRAMEWORK_VAR = /^--(tw-|radix-|swiper-|leaflet-|vp-|shiki|nextra|fd-|chakra-|mantine-|ck-)/;

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const srgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
function oklch(L, C, H) {
  const h = (H * Math.PI) / 180,
    a = C * Math.cos(h),
    b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((v) => Math.round(clamp(srgb(v), 0, 1) * 255));
}

function hsl(H, S, L) {
  H = ((H % 360) + 360) % 360;
  S /= 100;
  L /= 100;
  const c = (1 - Math.abs(2 * L - 1)) * S,
    x = c * (1 - Math.abs(((H / 60) % 2) - 1)),
    m = L - c / 2;
  let r, g, b;
  if (H < 60) {
    [r, g, b] = [c, x, 0];
  } else if (H < 120) {
    [r, g, b] = [x, c, 0];
  } else if (H < 180) {
    [r, g, b] = [0, c, x];
  } else if (H < 240) {
    [r, g, b] = [0, x, c];
  } else if (H < 300) {
    [r, g, b] = [x, 0, c];
  } else {
    [r, g, b] = [c, 0, x];
  }

  return [r, g, b].map((v) => Math.round((v + m) * 255));
}

const num = (s) => parseFloat(s);
const lFrac = (s) => {
  s = s.trim();
  const n = num(s);

  return (s.endsWith('%') ? n : n <= 1 ? n * 100 : n) / 100;
};

function parseColor(raw) {
  let v = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/!important/i, '')
    .trim();
  if (/var\(/i.test(v)) {
    return null;
  }

  let m;
  if ((m = v.match(/^#([0-9a-f]{3,8})$/i))) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) {
      h = h
        .split('')
        .map((c) => c + c)
        .join('');
    }

    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  if ((m = v.match(/^rgba?\(([^)]+)\)$/i))) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean);

    return [num(p[0]), num(p[1]), num(p[2])].map(Math.round);
  }

  if ((m = v.match(/^hsla?\(([^)]+)\)$/i))) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean);

    return hsl(num(p[0]), num(p[1]), num(p[2]));
  }

  if ((m = v.match(/^oklch\(([^)]+)\)$/i))) {
    const p = m[1].split(/[\s/]+/).filter(Boolean);

    return oklch(lFrac(p[0]), num(p[1]), num(p[2]));
  }

  if ((m = v.match(/^(-?\d*\.?\d+)\s+(-?\d*\.?\d+)%\s+(-?\d*\.?\d+)%$/))) {
    return hsl(num(m[1]), num(m[2]), num(m[3]));
  }

  return null;
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const isTeal = (rgb) => CANON.some((c) => dist(rgb, c.rgb) <= TOL);

function walk(d, o = []) {
  let e;
  try {
    e = readdirSync(d);
  } catch {
    return o;
  }

  for (const n of e) {
    const p = join(d, n);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }

    if (st.isDirectory()) {
      if (!IGNORE.has(n)) {
        walk(p, o);
      }
    } else {
      o.push(p);
    }
  }

  return o;
}

const CSS_EXT = new Set(['.css', '.scss', '.sass', '.less', '.html', '.htm', '.vue', '.svelte', '.astro']);
const COMP_EXT = new Set(['.tsx', '.jsx', '.ts', '.js', '.vue', '.svelte', '.astro', '.html', '.htm']);
const cssText = (f, x) => {
  const raw = readFileSync(f, 'utf8');

  return ['.html', '.htm', '.vue', '.svelte', '.astro'].includes(x)
    ? [...raw.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n')
    : raw;
};

const lineOf = (t, i) => t.slice(0, i).split('\n').length;

const files = statSync(TARGET).isDirectory() ? walk(TARGET) : [TARGET];
const fails = [],
  warns = [];
const defined = new Set();
const themeMapped = new Set();
const uses = []; // {name,rel,line}
const utilUse = new Map(); // enriched utility token -> [rel:line]
let cssN = 0,
  compN = 0;

const PRIMARY = /(?:^|[^\w-])--primary\s*:\s*([^;}\n]+)/g;
const DEFRE = /(?:^|[^\w-])(--[a-z0-9-]+)\s*:/gi;
const VARRE = /var\(\s*(--[a-z0-9-]+)/gi;
const THEME = /@theme[^{]*\{([\s\S]*?)\}/gi;
const HEX =
  /(?:bg-\[|text-\[|border-\[|from-\[|to-\[|fill=["']?|stroke=["']?|(?:background|color|fill|stroke)\s*[:=]\s*["']?)#([0-9a-fA-F]{3,8})\b/g;
// enriched Tailwind utilities whose token must be in @theme (else v4 falls back to default)
const UTIL =
  /\b(?:bg|text|border|ring|from|to|fill|stroke)-(teal-(?:50|100|200|300|400|500|600|700|800|900|950)|success|warning|info|aqua|mint)\b|\b(shadow-(?:sm|md|lg))\b/g;

for (const f of files) {
  const x = extname(f).toLowerCase();
  const rel = relative(process.cwd(), f) || f;
  if (CSS_EXT.has(x)) {
    cssN++;
    const t = cssText(f, x);
    for (const m of t.matchAll(PRIMARY)) {
      const rgb = parseColor(m[1].trim());
      if (rgb && !isTeal(rgb)) {
        fails.push({ rel, line: lineOf(t, m.index), val: m[1].trim(), rgb });
      }
    }

    for (const m of t.matchAll(DEFRE)) {
      defined.add(m[1].toLowerCase());
    }

    for (const m of t.matchAll(VARRE)) {
      uses.push({ name: m[1].toLowerCase(), rel, line: lineOf(t, m.index) });
    }

    for (const th of t.matchAll(THEME)) {
      for (const dm of th[1].matchAll(DEFRE)) {
        themeMapped.add(dm[1].toLowerCase());
      }
    }
  }

  if (COMP_EXT.has(x)) {
    compN++;
    const raw = readFileSync(f, 'utf8');
    for (const m of raw.matchAll(HEX)) {
      warns.push({ type: 'hex', rel, line: lineOf(raw, m.index), msg: '#' + m[1] });
    }

    for (const m of raw.matchAll(UTIL)) {
      const tok = m[1] || m[2];
      if (!utilUse.has(tok)) {
        utilUse.set(tok, `${rel}:${lineOf(raw, m.index)}`);
      }
    }
  }
}

// undefined CI-token var uses (partial-swap bug)
const seenUndef = new Set();
for (const u of uses) {
  if (!CI_TOKENS.test(u.name) || defined.has(u.name) || FRAMEWORK_VAR.test(u.name)) {
    continue;
  }

  if (seenUndef.has(u.name)) {
    continue;
  }

  seenUndef.add(u.name);
  warns.push({
    type: 'undef',
    rel: u.rel,
    line: u.line,
    msg: `var(${u.name}) used but --${u.name.slice(2)} is never defined`,
  });
}

// @theme completeness (v4 fallback-to-default bug) — only if the repo uses @theme
const hasTheme = themeMapped.size > 0;
if (hasTheme) {
  for (const [tok, at] of utilUse) {
    const cssName = '--' + tok;
    const colorName = '--color-' + tok;
    const isShadow = tok.startsWith('shadow-');
    const defd = defined.has(cssName);
    const mapped = isShadow
      ? themeMapped.has(cssName)
      : themeMapped.has(colorName) || themeMapped.has(cssName);
    if (defd && !mapped) {
      warns.push({
        type: 'theme',
        rel: at.split(':')[0],
        line: Number(at.split(':')[1]),
        msg: `utility uses ${tok} but ${isShadow ? cssName : colorName} is not in @theme (Tailwind v4 will use its default, not the CI token)`,
      });
    }
  }
}

// report
console.log('CI design-canon lint (v3)');
console.log(`  target: ${TARGET}\n  scanned: ${cssN} css/markup, ${compN} component file(s)\n`);
const grp = (t) => warns.filter((w) => w.type === t);
for (const [t, label] of [
  ['undef', 'undefined CI-token var (likely a partial token swap)'],
  ['theme', 'missing @theme mapping (Tailwind v4 falls back to its default)'],
  ['hex', 'hardcoded hex in component source'],
]) {
  const g = grp(t);
  if (!g.length) {
    continue;
  }

  console.log(`⚠ ${g.length} ${label}:`);
  for (const w of g.slice(0, 30)) {
    console.log(`  warn ${w.rel}:${w.line}  ${w.msg}`);
  }

  if (g.length > 30) {
    console.log(`  … and ${g.length - 30} more`);
  }

  console.log('');
}

if (fails.length) {
  console.log(`✖ ${fails.length} non-canon --primary value(s):`);
  for (const x of fails) {
    console.log(`  FAIL ${x.rel}:${x.line}  --primary: ${x.val} -> rgb(${x.rgb.join(',')})`);
  }

  console.log('\n  --primary must be CI phthalo #0a6358 / #c5e8dc (any notation).\nlint-canon: FAILED');
  process.exit(1);
}

console.log(
  '✔ lint-canon: canon OK (all --primary are CI phthalo)' +
    (warns.length ? ` — ${warns.length} non-blocking warning(s) above` : ''),
);
process.exit(0);

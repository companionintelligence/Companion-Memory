import { readFileSync } from 'node:fs';
import path from 'node:path';

import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Guards the canonical design-system token change from PR #1644: the web app's
// `--primary` must resolve to Companion Intelligence teal (#0f717a light,
// #abd4d8 dark) in every theme. We assert this two ways:
//   1. Against the real source CSS (`styles/index.css`) — the single source of
//      truth the app ships — so a token edit that drifts off-brand fails here.
//   2. In jsdom after mounting a component under those same tokens, proving the
//      custom property actually cascades/resolves at runtime (light and .dark).

// import.meta.dirname is the filesystem dir of this test file (Node 20.11+/22).
const INDEX_CSS = path.resolve(import.meta.dirname, '../../styles/index.css');

// Companion Intelligence canonical teal, mirroring scripts/lint-canon.mjs.
const CANON = {
  light: [15, 113, 122], // #0f717a
  dark: [171, 212, 216], // #abd4d8
};
const TOLERANCE = 14; // euclidean sRGB distance, same budget as the canon lint gate

// --- oklch -> sRGB[0..255], identical math to scripts/lint-canon.mjs ---
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const srgbGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

function oklchToRgb(L: number, C: number, H: number): [number, number, number] {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const rl = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const gl = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  return [rl, gl, bl].map((v) => Math.round(clamp(srgbGamma(v), 0, 1) * 255)) as [number, number, number];
}

function parseOklch(value: string): [number, number, number] {
  const match = value.match(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/i);
  if (!match) {
    throw new Error(`not an oklch() value: ${value}`);
  }

  const [, L, C, H] = match;

  return oklchToRgb(Number(L), Number(C), Number(H));
}

function dist(a: number[], b: number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Pull the `--primary` declaration out of a specific CSS selector block. */
function primaryIn(css: string, selector: string): string {
  const block = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([\\s\\S]*?)\\}`).exec(
    css,
  );
  if (!block) {
    throw new Error(`selector ${selector} not found in index.css`);
  }

  const decl = /--primary\s*:\s*([^;]+);/.exec(block[1]);
  if (!decl) {
    throw new Error(`--primary not found in ${selector} block`);
  }

  return decl[1].trim();
}

describe('canonical --primary token (source of truth)', () => {
  const css = readFileSync(INDEX_CSS, 'utf8');

  it(':root --primary resolves to CI teal #0f717a', () => {
    const rgb = parseOklch(primaryIn(css, ':root'));
    expect(dist(rgb, CANON.light)).toBeLessThanOrEqual(TOLERANCE);
  });

  it('.dark --primary resolves to CI teal #abd4d8', () => {
    const rgb = parseOklch(primaryIn(css, '.dark'));
    expect(dist(rgb, CANON.dark)).toBeLessThanOrEqual(TOLERANCE);
  });
});

describe('--primary resolves to CI teal with the app token styles applied', () => {
  // Mirror the shipped tokens into a <style> block so getComputedStyle can
  // resolve them in jsdom (Vitest is configured with css:false, so the real
  // stylesheet import is a no-op under test).
  const css = readFileSync(INDEX_CSS, 'utf8');
  const rootPrimary = primaryIn(css, ':root');
  const darkPrimary = primaryIn(css, '.dark');

  let style: HTMLStyleElement;

  beforeEach(() => {
    document.documentElement.classList.remove('light', 'dark');
    style = document.createElement('style');
    style.textContent = `:root{--primary:${rootPrimary};} .dark{--primary:${darkPrimary};}`;
    document.head.appendChild(style);
  });

  afterEach(() => {
    document.head.removeChild(style);
    document.documentElement.classList.remove('light', 'dark');
  });

  it('--primary resolves to CI teal on the document root in light mode', () => {
    render(<div data-testid="themed">hi</div>);
    // The :root custom property is declared on document.documentElement; read it
    // there (jsdom resolves declared custom props via getComputedStyle).
    const resolved = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();
    expect(dist(parseOklch(resolved), CANON.light)).toBeLessThanOrEqual(TOLERANCE);
  });

  it('--primary resolves to CI teal on the document root under .dark', () => {
    document.documentElement.classList.add('dark');
    render(<div data-testid="themed">hi</div>);
    const resolved = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();
    expect(dist(parseOklch(resolved), CANON.dark)).toBeLessThanOrEqual(TOLERANCE);
  });
});

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Guards the canonical design-system token from @companionintelligence/tokens v0.3:
// `--primary` must resolve to phthalo-mist (#0a6358 light, #c5e8dc dark).
// We assert against the shared token CSS and in jsdom after mounting under those tokens.

const TOKENS_CSS = path.resolve(
  import.meta.dirname,
  '../../../../../../../ci-common/packages/tokens/src/globals.css',
);

const CANON = {
  light: [10, 99, 88], // #0a6358
  dark: [197, 232, 220], // #c5e8dc
};
const TOLERANCE = 14;

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

function parseHex(value: string): [number, number, number] {
  let hex = value.trim().replace(/^#/, '');
  if (hex.length === 3) {
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('');
  }

  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

function parseColor(value: string): [number, number, number] {
  const trimmed = value.trim();
  if (trimmed.startsWith('#')) {
    return parseHex(trimmed);
  }

  const match = trimmed.match(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/i);
  if (match) {
    return oklchToRgb(Number(match[1]), Number(match[2]), Number(match[3]));
  }

  throw new Error(`unsupported color notation: ${value}`);
}

function dist(a: number[], b: number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function primaryIn(css: string, selector: string): string {
  const cleaned = stripCssComments(css);
  const blocks = [
    ...cleaned.matchAll(
      new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([\\s\\S]*?)\\}`, 'g'),
    ),
  ];
  if (blocks.length === 0) {
    throw new Error(`selector ${selector} not found in token CSS`);
  }

  for (const block of blocks) {
    const decl = /--primary\s*:\s*([^;]+);/.exec(block[1]);
    if (decl) {
      return decl[1].trim();
    }
  }

  throw new Error(`--primary not found in ${selector} block`);
}

describe('canonical --primary token (source of truth)', () => {
  const css = readFileSync(TOKENS_CSS, 'utf8');

  it(':root --primary resolves to phthalo #0a6358', () => {
    const rgb = parseColor(primaryIn(css, ':root'));
    expect(dist(rgb, CANON.light)).toBeLessThanOrEqual(TOLERANCE);
  });

  it('.dark --primary resolves to sage #c5e8dc', () => {
    const rgb = parseColor(primaryIn(css, '.dark'));
    expect(dist(rgb, CANON.dark)).toBeLessThanOrEqual(TOLERANCE);
  });
});

describe('--primary resolves with the app token styles applied', () => {
  const css = readFileSync(TOKENS_CSS, 'utf8');
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

  it('--primary resolves on the document root in light mode', () => {
    render(<div data-testid="themed">hi</div>);
    const resolved = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();
    expect(dist(parseColor(resolved), CANON.light)).toBeLessThanOrEqual(TOLERANCE);
  });

  it('--primary resolves on the document root under .dark', () => {
    document.documentElement.classList.add('dark');
    render(<div data-testid="themed">hi</div>);
    const resolved = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();
    expect(dist(parseColor(resolved), CANON.dark)).toBeLessThanOrEqual(TOLERANCE);
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Tailwind 4's preflight gives buttons the arrow cursor. Nothing in jsdom
// computes stylesheet cursors, so this reads the rule that restores the hand
// straight out of the app's stylesheet. Without it the rail toggle, the rail's
// section chevrons and every other <button> showed an arrow beside links that
// showed a hand.
const INDEX_CSS = fileURLToPath(new URL('../styles/index.css', import.meta.url));

function baseLayer(): string {
  const css = readFileSync(INDEX_CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const start = css.indexOf('@layer base {');
  const end = css.indexOf('@layer utilities {');

  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);

  return css.slice(start, end);
}

function ruleFor(selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}[^{]*\\{([^}]*)\\}`).exec(baseLayer());

  return match ? match[1] : null;
}

describe('button cursor', () => {
  it.each([
    'button:not(:disabled):not([aria-disabled="true"])',
    '[role="button"]:not(:disabled):not([aria-disabled="true"])',
  ])('gives %s the pointer in the base layer', (selector) => {
    expect(ruleFor(selector)).toMatch(/cursor:\s*pointer/);
  });
});

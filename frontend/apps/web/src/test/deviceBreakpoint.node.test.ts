import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { MOBILE_BREAKPOINT as commonBreakpoint } from '@ci/common/src/hooks/useDeviceLayout';
import { MOBILE_BREAKPOINT as shadcnBreakpoint } from '@ci/shadcn/src/hooks/use-mobile';
import { describe, expect, it } from 'vitest';

// The phone/desktop switch is decided in three places — two JS hooks and the
// `device:` Tailwind variant — and nothing but this test makes them agree. When
// they drifted before, the window between the two values rendered mixed chrome:
// PromptsPage gated its view-mode toggle on `lg:` (1024) while useDeviceLayout
// called 896–1024 desktop, so tablet widths got the mobile-only refresh button
// and no card/table toggle.
const CSS_FILES = {
  'apps/web/src/styles/index.css': fileURLToPath(new URL('../styles/index.css', import.meta.url)),
  'packages/shadcn/src/styles/globals.css': fileURLToPath(
    new URL('../../../../packages/shadcn/src/styles/globals.css', import.meta.url),
  ),
};

function readDeviceBreakpoint(file: string): string | null {
  const match = /--breakpoint-device:\s*([^;]+);/.exec(readFileSync(file, 'utf8'));

  return match ? match[1].trim() : null;
}

describe('the phone/desktop breakpoint is single-valued', () => {
  it('agrees between the two JS hooks', () => {
    expect(shadcnBreakpoint).toBe(commonBreakpoint);
  });

  it.each(Object.entries(CSS_FILES))('declares --breakpoint-device in %s', (_label, file) => {
    // px, not rem: the hooks match on `(max-width: ${MOBILE_BREAKPOINT - 1}px)`,
    // and a media-query rem follows the browser's default font size.
    expect(readDeviceBreakpoint(file)).toBe(`${commonBreakpoint}px`);
  });
});

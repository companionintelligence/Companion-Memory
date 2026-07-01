// Extend Vitest's `expect` with jest-dom matchers via the `/matchers` subpath
// rather than the `/vitest` entrypoint: under Yarn PnP the latter does an
// undeclared `require('vitest')` that fails strict resolution. Extending
// manually is equivalent and portable (works the same in CI).
import * as matchers from '@testing-library/jest-dom/matchers';
import { cleanup } from '@testing-library/react';
import { afterEach, expect, vi } from 'vitest';

expect.extend(matchers);

// Unmount React trees between tests so queries don't leak across cases.
afterEach(() => {
  cleanup();
});

// jsdom does not implement matchMedia — needed by useDeviceLayout (@ci/common)
// and theme-aware components. Default everything to "does not match".
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(), // deprecated, kept for older consumers
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

// jsdom lacks ResizeObserver / IntersectionObserver — required by Radix
// (ScrollArea in SearchBox), embla-carousel, and lazy media tiles.
class MockObserver {
  observe() {}

  unobserve() {}

  disconnect() {}

  takeRecords() {
    return [];
  }
}

vi.stubGlobal('ResizeObserver', MockObserver);
vi.stubGlobal('IntersectionObserver', MockObserver);

// jsdom does not implement element scroll APIs — Chat autoscroll
// (Chat.tsx / useConditionalAutoscroll.ts) calls scrollTo / scrollIntoView.
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {};
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

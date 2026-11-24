import { prefersReducedMotion, useReducedMotion } from '@ci/common';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** A `matchMedia` whose reduced-motion answer a test can flip, with its change listeners. */
function stubMatchMedia(initial: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: initial,
    addEventListener: (_: 'change', listener: () => void) => listeners.add(listener),
    removeEventListener: (_: 'change', listener: () => void) => listeners.delete(listener),
  };

  vi.stubGlobal('matchMedia', (media: string) => {
    if (media !== '(prefers-reduced-motion: reduce)') {
      throw new Error(`unexpected media query ${media}`);
    }

    return query;
  });

  return {
    set(matches: boolean) {
      query.matches = matches;
      listeners.forEach((listener) => listener());
    },
    listeners,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('prefersReducedMotion', () => {
  it('reads the preference once, and is false where there is no matchMedia', () => {
    stubMatchMedia(true);
    expect(prefersReducedMotion()).toBe(true);

    vi.stubGlobal('matchMedia', undefined);
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe('useReducedMotion', () => {
  it('follows the preference as it changes, and stops listening on unmount', () => {
    const media = stubMatchMedia(false);
    const { result, unmount } = renderHook(() => useReducedMotion());

    expect(result.current).toBe(false);

    act(() => media.set(true));
    expect(result.current).toBe(true);

    unmount();
    expect(media.listeners.size).toBe(0);
  });
});

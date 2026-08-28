import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BackgroundProvider, GLOW_STORAGE_KEY, useBackground } from './useBackground';

function wrapper({ children }: { children: React.ReactNode }) {
  return <BackgroundProvider>{children}</BackgroundProvider>;
}

describe('BackgroundProvider pointer glow', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('defaults the pointer glow on', () => {
    const { result } = renderHook(() => useBackground(), { wrapper });

    expect(result.current.glowEnabled).toBe(true);
  });

  it('persists the glow toggle under ci-ui-glow', () => {
    const { result } = renderHook(() => useBackground(), { wrapper });

    act(() => result.current.setGlowEnabled(false));
    expect(localStorage.getItem(GLOW_STORAGE_KEY)).toBe('false');
    expect(result.current.glowEnabled).toBe(false);

    act(() => result.current.setGlowEnabled(true));
    expect(localStorage.getItem(GLOW_STORAGE_KEY)).toBe('true');
    expect(result.current.glowEnabled).toBe(true);
  });

  it('rehydrates the glow toggle from localStorage on mount', () => {
    localStorage.setItem(GLOW_STORAGE_KEY, 'false');

    const { result } = renderHook(() => useBackground(), { wrapper });

    expect(result.current.glowEnabled).toBe(false);
  });
});

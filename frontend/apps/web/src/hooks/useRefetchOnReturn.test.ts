import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useRefetchOnReturn } from './useRefetchOnReturn';

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility('visible');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useRefetchOnReturn', () => {
  it('refetches when the tab becomes visible again, not on mount', () => {
    const refetch = vi.fn();
    renderHook(() => useRefetchOnReturn(refetch));
    expect(refetch).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2_000);
    document.dispatchEvent(new Event('visibilitychange'));

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('counts focus and visibility arriving together as one return', () => {
    const refetch = vi.fn();
    renderHook(() => useRefetchOnReturn(refetch));
    vi.advanceTimersByTime(2_000);

    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('ignores a focus that arrives while the tab is hidden', () => {
    const refetch = vi.fn();
    renderHook(() => useRefetchOnReturn(refetch));
    vi.advanceTimersByTime(2_000);
    setVisibility('hidden');

    window.dispatchEvent(new Event('focus'));

    expect(refetch).not.toHaveBeenCalled();
  });

  it('calls the latest refetch and stops after unmount', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = renderHook(({ fn }) => useRefetchOnReturn(fn), {
      initialProps: { fn: first },
    });
    rerender({ fn: second });
    vi.advanceTimersByTime(2_000);

    document.dispatchEvent(new Event('visibilitychange'));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    unmount();
    vi.advanceTimersByTime(2_000);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(second).toHaveBeenCalledTimes(1);
  });
});

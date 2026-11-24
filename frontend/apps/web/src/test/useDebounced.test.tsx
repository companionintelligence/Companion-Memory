import { useDebounced } from '@ci/common';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('useDebounced', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the value once it has held still for the delay, and not before', () => {
    const { result, rerender } = renderHook(({ value }) => useDebounced(value, 300), {
      initialProps: { value: 'a' },
    });

    expect(result.current).toBe('a');

    rerender({ value: 'ab' });
    act(() => vi.advanceTimersByTime(200));
    expect(result.current).toBe('a');

    rerender({ value: 'abc' });
    act(() => vi.advanceTimersByTime(200));
    // 400ms since the first keystroke, 200ms since the last: still quiet-waiting.
    expect(result.current).toBe('a');

    act(() => vi.advanceTimersByTime(100));
    expect(result.current).toBe('abc');
  });
});

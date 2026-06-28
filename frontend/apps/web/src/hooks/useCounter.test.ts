import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useCounter } from './useCounter';

describe('useCounter', () => {
  it('starts at zero', () => {
    const { result } = renderHook(() => useCounter());
    expect(result.current[0].count).toBe(0);
  });

  it('increments', () => {
    const { result } = renderHook(() => useCounter());

    act(() => result.current[1].increment());
    act(() => result.current[1].increment());

    expect(result.current[0].count).toBe(2);
  });
});

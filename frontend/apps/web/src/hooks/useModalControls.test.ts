import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useModalControls } from './useModalControls';

describe('useModalControls', () => {
  it('defaults to closed', () => {
    const { result } = renderHook(() => useModalControls());
    expect(result.current[0].isOpen).toBe(false);
  });

  it('honours an initial open option', () => {
    const { result } = renderHook(() => useModalControls({ open: true }));
    expect(result.current[0].isOpen).toBe(true);
  });

  it('opens, closes and toggles', () => {
    const { result } = renderHook(() => useModalControls());

    act(() => result.current[1].open());
    expect(result.current[0].isOpen).toBe(true);

    act(() => result.current[1].close());
    expect(result.current[0].isOpen).toBe(false);

    act(() => result.current[1].toggle());
    expect(result.current[0].isOpen).toBe(true);
  });
});

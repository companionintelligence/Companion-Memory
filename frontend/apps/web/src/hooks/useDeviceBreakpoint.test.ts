import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { classifyDeviceBreakpoint, useDeviceBreakpoint } from './useDeviceBreakpoint';

describe('useDeviceBreakpoint', () => {
  it('classifies compact (< 768px), medium (768px–1024px), and expanded (> 1024px) tiers', () => {
    expect(classifyDeviceBreakpoint(390, true)).toEqual({
      tier: 'compact',
      isCompact: true,
      isTablet: false,
      isExpanded: false,
      isTouch: true,
      shouldShowPersistentRailLabels: false,
    });

    expect(classifyDeviceBreakpoint(834, true)).toEqual({
      tier: 'medium',
      isCompact: false,
      isTablet: true,
      isExpanded: false,
      isTouch: true,
      shouldShowPersistentRailLabels: true,
    });

    expect(classifyDeviceBreakpoint(1024, false)).toEqual({
      tier: 'medium',
      isCompact: false,
      isTablet: true,
      isExpanded: false,
      isTouch: false,
      shouldShowPersistentRailLabels: true,
    });

    expect(classifyDeviceBreakpoint(1366, true)).toEqual({
      tier: 'expanded',
      isCompact: false,
      isTablet: false,
      isExpanded: true,
      isTouch: true,
      shouldShowPersistentRailLabels: true,
    });

    expect(classifyDeviceBreakpoint(1440, false)).toEqual({
      tier: 'expanded',
      isCompact: false,
      isTablet: false,
      isExpanded: true,
      isTouch: false,
      shouldShowPersistentRailLabels: false,
    });
  });

  it('reacts to viewport resize across compact, medium, and expanded tiers', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 820,
    });

    const { result } = renderHook(() => useDeviceBreakpoint());
    expect(result.current.tier).toBe('medium');
    expect(result.current.isTablet).toBe(true);

    act(() => {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        writable: true,
        value: 375,
      });
      window.dispatchEvent(new Event('resize'));
    });

    expect(result.current.tier).toBe('compact');
    expect(result.current.isCompact).toBe(true);

    act(() => {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        writable: true,
        value: 1280,
      });
      window.dispatchEvent(new Event('resize'));
    });

    expect(result.current.tier).toBe('expanded');
    expect(result.current.isExpanded).toBe(true);
  });
});

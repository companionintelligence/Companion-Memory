import { useEffect, useState } from 'react';

import {
  type DeviceSizeClass,
  TABLET_MAX_BREAKPOINT,
  TABLET_MIN_BREAKPOINT,
  resolveDeviceSizeClass,
} from '@ci/common';

export interface DeviceBreakpointState {
  /** 3-tier viewport class: `compact` (< 768px), `medium` (768px–1024px), `expanded` (> 1024px). */
  tier: DeviceSizeClass;
  /** True when viewport width < 768px (phone / narrow Split View). */
  isCompact: boolean;
  /** True when viewport width is between 768px and 1024px inclusive (iPad / tablet). */
  isTablet: boolean;
  /** True when viewport width > 1024px (desktop / large landscape tablet). */
  isExpanded: boolean;
  /** True when the primary input device is touch/coarse pointer (no hover). */
  isTouch: boolean;
  /**
   * True when the left navigation rail should render persistent labels instead of
   * relying on hover-only tooltips (tablet tier or touch-first expanded viewport such
   * as iPad Pro 13" landscape).
   */
  shouldShowPersistentRailLabels: boolean;
}

/**
 * Pure classifier for unit testing and SSR/initial hydration.
 */
export function classifyDeviceBreakpoint(width: number, isTouch = false): DeviceBreakpointState {
  const tier = resolveDeviceSizeClass(width);
  const isCompact = tier === 'compact';
  const isTablet = tier === 'medium';
  const isExpanded = tier === 'expanded';

  return {
    tier,
    isCompact,
    isTablet,
    isExpanded,
    isTouch,
    shouldShowPersistentRailLabels: isTablet || (isExpanded && isTouch),
  };
}

/** A phone or tablet: the primary pointer is a finger and nothing hovers. */
export const TOUCH_PRIMARY_QUERY = '(hover: none) and (pointer: coarse)';

/**
 * Whether the primary pointer is a finger, read now. Narrower than `isTouch`, which also counts a
 * touch-screen laptop (`maxTouchPoints`). That laptop has a keyboard, so focusing a text box there
 * opens nothing over the page.
 */
export function isPrimaryPointerTouch(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(TOUCH_PRIMARY_QUERY).matches
  );
}

function readViewportState(): DeviceBreakpointState {
  if (typeof window === 'undefined') {
    return classifyDeviceBreakpoint(1280, false);
  }

  const width = window.innerWidth || 1280;
  const coarseQuery = typeof window.matchMedia === 'function' ? window.matchMedia(TOUCH_PRIMARY_QUERY) : null;
  const isTouch = Boolean(
    coarseQuery?.matches || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0),
  );

  return classifyDeviceBreakpoint(width, isTouch);
}

/**
 * Reactive 3-tier device breakpoint hook supporting phone (`compact` < 768px),
 * tablet/iPad (`medium` 768px–1024px), and desktop (`expanded` > 1024px) layouts.
 */
export function useDeviceBreakpoint(): DeviceBreakpointState {
  const [state, setState] = useState<DeviceBreakpointState>(readViewportState);

  useEffect(() => {
    const update = () => {
      setState(readViewportState());
    };

    const compactQuery = window.matchMedia(`(max-width: ${TABLET_MIN_BREAKPOINT - 1}px)`);
    const tabletQuery = window.matchMedia(
      `(min-width: ${TABLET_MIN_BREAKPOINT}px) and (max-width: ${TABLET_MAX_BREAKPOINT}px)`,
    );
    const coarseQuery = window.matchMedia(TOUCH_PRIMARY_QUERY);

    update();

    compactQuery.addEventListener('change', update);
    tabletQuery.addEventListener('change', update);
    coarseQuery.addEventListener('change', update);
    window.addEventListener('resize', update);

    return () => {
      compactQuery.removeEventListener('change', update);
      tabletQuery.removeEventListener('change', update);
      coarseQuery.removeEventListener('change', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  return state;
}

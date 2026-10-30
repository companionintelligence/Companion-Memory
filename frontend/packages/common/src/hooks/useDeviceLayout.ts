import { useState, useEffect } from 'react';

import { createHookContext } from '../utils/createHookContext';

/**
 * The width at which the app switches between phone and desktop chrome.
 * Slightly above Tailwind md (768) — mobile layout through tablet widths.
 *
 * The CSS half of this switch is the `device:` variant
 * (`--breakpoint-device` in frontend/apps/web/src/styles/index.css). Gate
 * chrome in markup with `device:`, never with `lg:`/`md:`, or the two halves
 * disagree at tablet widths.
 */
export const MOBILE_BREAKPOINT = 896;

/**
 * 3-tier adaptive viewport boundaries for phone (`compact`), tablet/iPad (`medium`),
 * and desktop (`expanded`) layouts.
 */
export const TABLET_MIN_BREAKPOINT = 768;
export const TABLET_MAX_BREAKPOINT = 1024;

export type DeviceSizeClass = 'compact' | 'medium' | 'expanded';

export function resolveDeviceSizeClass(width: number): DeviceSizeClass {
  if (width < TABLET_MIN_BREAKPOINT) {
    return 'compact';
  }

  if (width <= TABLET_MAX_BREAKPOINT) {
    return 'medium';
  }

  return 'expanded';
}

/**
 * A comprehensive React hook to determine device state, including
 * mobile/tablet status, size class, and screen orientation. It's SSR-safe.
 *
 * @returns An object with `isMobile`, `isTablet`, `sizeClass`, `isLandscape`, and `isPortrait`.
 * Values will be `undefined` on the initial server-side render.
 */
const MOBILE_BROWSER_REGEX = /Mobi|Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i;

function useDeviceLayout() {
  const [deviceState, setDeviceState] = useState<{
    isMobile: boolean | undefined;
    isTablet: boolean | undefined;
    sizeClass: DeviceSizeClass | undefined;
    isLandscape: boolean | undefined;
    isPortrait: boolean | undefined;
    isMobileBrowser: boolean | undefined;
  }>({
    isMobile: undefined,
    isTablet: undefined,
    sizeClass: undefined,
    isLandscape: undefined,
    isPortrait: undefined,
    isMobileBrowser: undefined,
  });

  useEffect(() => {
    // Media query for mobile breakpoint
    const mobileQuery = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    // Media query for tablet range (768px - 1024px)
    const tabletQuery = window.matchMedia(
      `(min-width: ${TABLET_MIN_BREAKPOINT}px) and (max-width: ${TABLET_MAX_BREAKPOINT}px)`,
    );
    // Media query for compact (< 768px)
    const compactQuery = window.matchMedia(`(max-width: ${TABLET_MIN_BREAKPOINT - 1}px)`);
    // Media query for landscape orientation
    const orientationQuery = window.matchMedia('(orientation: landscape)');

    // A single handler to update the state based on all queries
    const updateDeviceState = () => {
      const isTablet = tabletQuery.matches;
      const sizeClass: DeviceSizeClass = compactQuery.matches ? 'compact' : isTablet ? 'medium' : 'expanded';

      setDeviceState({
        isMobile: mobileQuery.matches,
        isTablet,
        sizeClass,
        isLandscape: orientationQuery.matches,
        isPortrait: !orientationQuery.matches,
        isMobileBrowser: MOBILE_BROWSER_REGEX.test(navigator.userAgent),
      });
    };

    // Set the initial state on component mount (client-side)
    updateDeviceState();

    // Add listeners to update the state when the media queries change
    // Using `addEventListener` is the modern, recommended approach
    mobileQuery.addEventListener('change', updateDeviceState);
    tabletQuery.addEventListener('change', updateDeviceState);
    compactQuery.addEventListener('change', updateDeviceState);
    orientationQuery.addEventListener('change', updateDeviceState);

    // Cleanup function to remove the listeners when the component unmounts
    return () => {
      mobileQuery.removeEventListener('change', updateDeviceState);
      tabletQuery.removeEventListener('change', updateDeviceState);
      compactQuery.removeEventListener('change', updateDeviceState);
      orientationQuery.removeEventListener('change', updateDeviceState);
    };
  }, []); // Empty dependency array ensures this effect runs only once on mount

  return deviceState;
}

const { Provider, useHookContext } = createHookContext(useDeviceLayout);

export { Provider as DeviceLayoutProvider, useHookContext as useDeviceLayout };

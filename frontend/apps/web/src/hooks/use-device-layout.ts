import { useState, useEffect } from 'react';

import { createHookContext } from '@ci/common';

// Define the breakpoint for mobile devices
const MOBILE_BREAKPOINT = 768; // Corresponds to md in Tailwind CSS

/**
 * A comprehensive React hook to determine device state, including
 * mobile status and screen orientation. It's SSR-safe.
 *
 * @returns An object with `isMobile`, `isLandscape`, and `isPortrait` booleans.
 * Values will be `undefined` on the initial server-side render.
 */
function useDeviceLayout() {
  const [deviceState, setDeviceState] = useState<{
    isMobile: boolean | undefined;
    isLandscape: boolean | undefined;
    isPortrait: boolean | undefined;
  }>({
    isMobile: undefined,
    isLandscape: undefined,
    isPortrait: undefined,
  });

  useEffect(() => {
    // Media query for mobile breakpoint
    const mobileQuery = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    // Media query for landscape orientation
    const orientationQuery = window.matchMedia('(orientation: landscape)');

    // A single handler to update the state based on both queries
    const updateDeviceState = () => {
      setDeviceState({
        isMobile: mobileQuery.matches,
        isLandscape: orientationQuery.matches,
        isPortrait: !orientationQuery.matches,
      });
    };

    // Set the initial state on component mount (client-side)
    updateDeviceState();

    // Add listeners to update the state when the media queries change
    // Using `addEventListener` is the modern, recommended approach
    mobileQuery.addEventListener('change', updateDeviceState);
    orientationQuery.addEventListener('change', updateDeviceState);

    // Cleanup function to remove the listeners when the component unmounts
    return () => {
      mobileQuery.removeEventListener('change', updateDeviceState);
      orientationQuery.removeEventListener('change', updateDeviceState);
    };
  }, []); // Empty dependency array ensures this effect runs only once on mount

  return deviceState;
}

const { Provider, useHookContext } = createHookContext(useDeviceLayout);

export { Provider as DeviceLayoutProvider, useHookContext as useDeviceLayout };

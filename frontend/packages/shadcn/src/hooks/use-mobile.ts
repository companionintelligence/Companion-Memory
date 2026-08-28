import * as React from 'react';

/**
 * Raised from upstream shadcn's 768 so this agrees with `useDeviceLayout` in
 * @ci/common and with the `device:` Tailwind variant. Duplicated rather than
 * imported because @ci/shadcn does not depend on @ci/common;
 * frontend/apps/web/src/test/deviceBreakpoint.node.test.ts pins them together.
 */
export const MOBILE_BREAKPOINT = 896;

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined);

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };

    mql.addEventListener('change', onChange);
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);

    return () => mql.removeEventListener('change', onChange);
  }, []);

  return !!isMobile;
}

import { isNativePlatform, useDeviceLayout } from '@ci/common';
import { Link } from 'react-router-dom';

import { useLocationTracking } from '@/hooks';

/**
 * Native map hint for App Review guideline 2.5.4 and for anyone who has not
 * yet turned on Always. Hidden once Always is selected.
 */
export function LocationAlwaysBanner() {
  const { isMobile } = useDeviceLayout();
  const { mode } = useLocationTracking({ watch: false });

  if (!isNativePlatform() || mode === 'always' || isMobile == null) {
    return null;
  }

  const href = isMobile ? '/self/settings/location' : '/settings/location';

  return (
    <p className="border-b border-border bg-card px-3 py-2 text-xs text-muted-foreground">
      You can record your location for better placement of memories, even while the app is closed and your
      device is locked.{' '}
      <Link to={href} className="font-medium text-foreground underline">
        Turn on Location Sync
      </Link>
    </p>
  );
}

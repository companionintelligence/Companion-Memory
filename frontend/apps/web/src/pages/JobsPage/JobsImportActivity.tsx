import { useDeviceLayout } from '@ci/common';

import { ImportActivity } from '@/components/ImportActivity';

/**
 * The live-import pin, as this page hosts it.
 *
 * The same component the import surface uses — two implementations of a
 * progress card drift. The host is what differs: the import wizard is a
 * bounded column and caps the region, while this page scrolls, so desktop
 * leaves it uncapped. A phone has a bottom nav and a fold of its own, so an
 * uncapped 13-source card would push Jobs off-screen; the cap is a jobs-page
 * className only. Import / Sources do not pass through here.
 */
export function JobsImportActivity() {
  const { isMobile } = useDeviceLayout();

  return <ImportActivity className={isMobile === true ? 'max-h-[36vh] overflow-y-auto' : undefined} />;
}

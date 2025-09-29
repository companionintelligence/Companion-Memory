import { lazy } from 'react';

import { ResponsiveLoader } from '@/components/ResponsiveLoader';

const DesktopPage = lazy(() => import('./DesktopMemoryPage'));
const MobilePage = lazy(() => import('./MobileMemoryPage'));

export default function MemoryPage() {
  return <ResponsiveLoader desktop={DesktopPage} mobile={MobilePage} />;
}

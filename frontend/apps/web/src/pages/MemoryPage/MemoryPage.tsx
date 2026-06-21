import { lazy } from 'react';

import { usePageTitle } from '@ci/common';
import { useSearchParams } from 'react-router-dom';

import { ResponsiveLoader } from '@/components/ResponsiveLoader';

import { EntityServiceProvider } from '../MemoryPage/useEntityService';

const DesktopPage = lazy(() => import('./DesktopMemoryPage'));
const MobilePage = lazy(() => import('./MobileMemoryPage'));

export function MemoryPage() {
  usePageTitle('Memory - Companion Intelligence');
  const [searchParams] = useSearchParams();

  return (
    <EntityServiceProvider
      args={[
        {
          searchQuery: searchParams.get('search') || '',
          includeTypes: searchParams.get('includedEntityTypes')?.split(',').filter(Boolean) || undefined,
          excludeTypes: searchParams.get('excludedEntityTypes')?.split(',').filter(Boolean) || undefined,
          eventTypes: searchParams.get('eventTypes')?.split(',').filter(Boolean) || undefined,
        },
      ]}
    >
      <ResponsiveLoader desktop={DesktopPage} mobile={MobilePage} />
    </EntityServiceProvider>
  );
}

import { lazy } from 'react';

import { usePageTitle } from '@ci/common';
import { useSearchParams } from 'react-router-dom';

import { ResponsiveLoader } from '@/components/ResponsiveLoader';

import { EntityServiceProvider } from '../MemoryPage/useEntityService';

import { parseBbox } from './bbox';

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
          tags: searchParams.get('tags')?.split(',').filter(Boolean) || undefined,
          startTime: searchParams.get('from') || undefined,
          endTime: searchParams.get('to') || undefined,
          sortBy: searchParams.get('sortBy') || undefined,
          sortOrder: searchParams.get('sortOrder') || undefined,
          // LifeScope-parity dimensions (who / where / connector / semantic).
          connectors: searchParams.get('connectors')?.split(',').filter(Boolean) || undefined,
          people: searchParams.get('people')?.split(',').filter(Boolean) || undefined,
          places: searchParams.get('places')?.split(',').filter(Boolean) || undefined,
          // The map (`?view=map`) is a located-events surface, so it derives
          // hasLocation here rather than the map writing its own `?hasLocation`
          // param (whose unmount cleanup reverted navigation away from /memory).
          // A user-set Located filter still works via the explicit param.
          hasLocation:
            searchParams.get('hasLocation') === '1' || searchParams.get('view') === 'map' || undefined,
          bbox: parseBbox(searchParams.get('bbox')),
          semantic: searchParams.get('semantic') === '1' || undefined,
        },
      ]}
    >
      <ResponsiveLoader desktop={DesktopPage} mobile={MobilePage} />
    </EntityServiceProvider>
  );
}

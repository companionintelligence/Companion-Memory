import { useEffect, useState } from 'react';

import { useQuery } from '@apollo/client';
import { EmptyState, LoadingPage, Portal, useDeviceLayout, usePageTitle } from '@ci/common';
import { Sheet, Tabs } from '@ci/shadcn';
import { Images, List, Map as MapIcon, Share2, type LucideIcon } from '@ci/shadcn/icons';
import { useParams } from 'react-router-dom';

import { PageContent } from '@/components/layout';
import { gql } from '@/graphql';

import { ErrorState } from '../MemoryPage/Components';
import { EntityDetails } from '../MemoryPage/Components/EntityDetails';
import { GalleryView } from '../MemoryPage/GalleryView';
import { ListView } from '../MemoryPage/ListView';
import { DesktopMapView, MobileMapView } from '../MemoryPage/MapView';
import { EntityServiceProvider, useEntityService } from '../MemoryPage/useEntityService';

// The viewer only sees what `useEntityService` returns for the share token (the
// owner's results), so the Graph tab — which pulls from the viewer's own graph
// endpoints — is intentionally omitted here.
const VIEW_TABS: Array<{ value: string; label: string; title: string; Icon: LucideIcon }> = [
  { value: 'list', label: 'List', title: 'List view', Icon: List },
  { value: 'gallery', label: 'Gallery', title: 'Gallery view', Icon: Images },
  { value: 'map', label: 'Map', title: 'Map view', Icon: MapIcon },
];

const GET_SHARED_SAVED_SEARCH = gql(`
  query GetSharedSavedSearch($token: String!) {
    sharedSavedSearch(token: $token) {
      id
      name
      description
    }
  }
`);

function ViewTabs({ activeTab, setActiveTab }: { activeTab: string; setActiveTab: (v: string) => void }) {
  return (
    <Tabs defaultValue="list" onValueChange={setActiveTab} value={activeTab}>
      <Tabs.List className="flex h-9 items-center border">
        {VIEW_TABS.map(({ value, label, title, Icon }) => {
          const active = activeTab === value;

          return (
            <Tabs.Trigger
              key={value}
              value={value}
              title={title}
              aria-label={title}
              className="flex h-7 w-8 flex-none items-center justify-center px-0 data-[state=active]:w-auto data-[state=active]:px-2.5"
            >
              <Icon className="h-4 w-4" />
              {active && <span>{label}</span>}
            </Tabs.Trigger>
          );
        })}
      </Tabs.List>
    </Tabs>
  );
}

/** Read-only explorer body for a shared search; relies on the surrounding
 *  EntityServiceProvider (seeded with the share token) for its results. */
function SharedSearchBody({ name, description }: { name: string; description: string | null }) {
  const { isMobile } = useDeviceLayout();
  const [activeTab, setActiveTab] = useState('list');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [{ activeEntity, totalCount, loading, error, refetch }, { setActiveEntity }] = useEntityService();

  const toggleActiveEntity = (open: boolean) => {
    setDetailsOpen(open);
    if (!open) {
      setActiveEntity(null);
    }
  };

  // Open the details sheet whenever a result is selected.
  useEffect(() => {
    if (activeEntity != null) {
      setDetailsOpen(true);
    }
  }, [activeEntity]);

  const tabs = <ViewTabs activeTab={activeTab} setActiveTab={setActiveTab} />;
  // A results-fetch error must not masquerade as "no results" — show a retry
  // affordance instead (the empty state asserts a definite "no memories" cause).
  const hasError = !loading && error != null;
  const hasNoResults = !loading && !hasError && totalCount === 0;

  return (
    <>
      {/* Desktop hosts the view tabs in the global header slot; the mobile layout
          has no such slot, so render them inline in the page body instead. */}
      {!isMobile && <Portal.Slot id="nav-views">{tabs}</Portal.Slot>}

      <PageContent className="p-0 gap-0">
        {isMobile && <div className="px-2 pt-2">{tabs}</div>}

        {/* The share names itself here now. It used to be named only by the
            breadcrumb, and this page — unlike every page behind the rail — has
            no menu naming it: a viewer arrives from a link with no idea whose
            search this is or what it is called. */}
        <div className="px-4 pt-3">
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <Share2 aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
            {name}
          </h1>
          {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
        </div>
        {!loading && activeTab !== 'map' && (
          <div className="px-4 pt-1 text-xs text-muted-foreground">
            {totalCount.toLocaleString()} result{totalCount === 1 ? '' : 's'}
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col">
          {hasError ? (
            <ErrorState onRetry={refetch} />
          ) : hasNoResults ? (
            <EmptyState
              icon={<Share2 size={48} />}
              message={
                <>
                  <div>This shared search has no results right now.</div>
                  <div className="text-muted-foreground">The owner may not have any matching memories.</div>
                </>
              }
            />
          ) : (
            <>
              {activeTab === 'list' && <ListView />}
              {activeTab === 'gallery' && <GalleryView />}
              {activeTab === 'map' && (isMobile ? <MobileMapView readOnly /> : <DesktopMapView readOnly />)}
            </>
          )}
        </div>
      </PageContent>

      {activeEntity && (
        <Sheet open={detailsOpen} onOpenChange={toggleActiveEntity}>
          <EntityDetails entity={activeEntity} readOnly />
        </Sheet>
      )}
    </>
  );
}

export function SharedSearchPage() {
  const { token } = useParams<{ token: string }>();

  const { data, loading } = useQuery(GET_SHARED_SAVED_SEARCH, {
    variables: { token: token ?? '' },
    skip: !token,
  });

  const shared = data?.sharedSavedSearch;

  usePageTitle(
    shared?.name
      ? `${shared.name} (Shared) - Companion Intelligence`
      : 'Shared Search - Companion Intelligence',
  );

  if (loading) {
    return <LoadingPage />;
  }

  if (!shared) {
    return (
      <>
        {/* Cause-agnostic: the backend cannot distinguish a revoked token from a
            typo'd/never-valid one, so don't assert a specific reason. */}
        <EmptyState
          icon={<Share2 size={48} />}
          message={
            <>
              <div>This shared search isn’t available.</div>
              <div className="text-muted-foreground">
                The link may be invalid or sharing may have been turned off.
              </div>
            </>
          }
        />
      </>
    );
  }

  return (
    <EntityServiceProvider args={[{ searchQuery: '', shareToken: token ?? '' }]}>
      <SharedSearchBody
        name={shared.name || 'Untitled Saved Search'}
        description={shared.description ?? null}
      />
    </EntityServiceProvider>
  );
}

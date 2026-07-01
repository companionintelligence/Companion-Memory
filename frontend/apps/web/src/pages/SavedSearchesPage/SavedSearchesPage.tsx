import { type ReactNode, useState } from 'react';

import { useQuery } from '@apollo/client';
import { EmptyState, LoadingPage, Portal, usePageTitle } from '@ci/common';
import { Breadcrumb } from '@ci/shadcn';
import { Link } from 'react-router-dom';

import { SavedSearchIcon } from '@/components/icons';
import { PageContent } from '@/components/layout';
import { DropdownProvider } from '@/components/SearchBox/useDropdown';
import { gql } from '@/graphql';
import { type FragmentType, useFragment } from '@/graphql/fragment-masking';

import { DeleteSavedSearchModal } from './DeleteSavedSearchModal';
import { EditSavedSearchModal } from './EditSavedSearchModal';
import { SavedSearchGridItemFragment, SavedSearch } from './SavedSearch';
import { ShareSavedSearchModal } from './ShareSavedSearchModal';

const GET_SAVED_SEARCHES = gql(`
  query GetSavedSearches($first: Int, $after: String) {
    savedSearches(first: $first, after: $after) {
      edges {
        node {
          id
          ...SavedSearchGridItemFragment
        }
      }
    }
  }
`);

export function SavedSearchesPage() {
  usePageTitle('Saved Searches - Companion Intelligence');

  const { data, loading } = useQuery(GET_SAVED_SEARCHES, {
    variables: { first: 50 },
  });

  const [savedSearchToDelete, setSavedSearchToDelete] = useState<FragmentType<
    typeof SavedSearchGridItemFragment
  > | null>(null);
  const [savedSearchToEdit, setSavedSearchToEdit] = useState<FragmentType<
    typeof SavedSearchGridItemFragment
  > | null>(null);
  const [savedSearchToShare, setSavedSearchToShare] = useState<FragmentType<
    typeof SavedSearchGridItemFragment
  > | null>(null);

  const openSavedSearchEditModal = (
    e: React.MouseEvent,
    savedSearch: FragmentType<typeof SavedSearchGridItemFragment>,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setSavedSearchToEdit(savedSearch);
  };

  const openSavedSearchShareModal = (
    e: React.MouseEvent,
    savedSearch: FragmentType<typeof SavedSearchGridItemFragment>,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setSavedSearchToShare(savedSearch);
  };

  const openSavedSearchDeleteModal = (
    e: React.MouseEvent,
    savedSearch: FragmentType<typeof SavedSearchGridItemFragment>,
  ) => {
    e.preventDefault();
    e.stopPropagation();

    setSavedSearchToDelete(savedSearch);
  };

  const savedSearches = data?.savedSearches?.edges.map((edge) => edge.node) || [];

  let content: ReactNode;

  if (loading) {
    content = <LoadingPage />;
  } else if (savedSearches.length === 0) {
    content = (
      <EmptyState
        icon={<SavedSearchIcon size={48} colorized={false} />}
        message={
          <>
            <div>You don't have any Saved Searches yet.</div>
          </>
        }
      />
    );
  } else {
    content = (
      <PageContent>
        <div className="grid w-full gap-4 justify-center grid-cols-[repeat(auto-fill,400px)] auto-rows-[300px]">
          {savedSearches.map((savedSearch) => (
            <SavedSearch
              key={savedSearch.id}
              savedSearch={savedSearch}
              openSavedSearchDeleteModal={(e) => openSavedSearchDeleteModal(e, savedSearch)}
              openSavedSearchEditModal={(e) => openSavedSearchEditModal(e, savedSearch)}
              openSavedSearchShareModal={(e) => openSavedSearchShareModal(e, savedSearch)}
            />
          ))}
        </div>
      </PageContent>
    );
  }

  return (
    <>
      <Portal.Slot id="breadcrumbs">
        <Breadcrumb>
          <Breadcrumb.List>
            <Breadcrumb.Item className="hidden md:block">
              <Breadcrumb.Link asChild>
                <Link to="/feed">Companion</Link>
              </Breadcrumb.Link>
            </Breadcrumb.Item>

            <Breadcrumb.Separator className="hidden md:block" />

            <Breadcrumb.Item>
              <Breadcrumb.Page>Saved Searches</Breadcrumb.Page>
            </Breadcrumb.Item>
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      {content}

      {savedSearchToDelete && (
        <DeleteSavedSearchModal
          savedSearchId={useFragment(SavedSearchGridItemFragment, savedSearchToDelete).id}
          onClose={() => setSavedSearchToDelete(null)}
        />
      )}

      {savedSearchToEdit && (
        <DropdownProvider args={[{ changeSearchParams: false }]}>
          <EditSavedSearchModal savedSearch={savedSearchToEdit} onClose={() => setSavedSearchToEdit(null)} />
        </DropdownProvider>
      )}

      {savedSearchToShare && (
        <ShareSavedSearchModal savedSearch={savedSearchToShare} onClose={() => setSavedSearchToShare(null)} />
      )}
    </>
  );
}

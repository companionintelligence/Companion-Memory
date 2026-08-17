import { type ReactNode, useState } from 'react';

import { useQuery } from '@apollo/client';
import { EmptyState, LoadingPage, usePageTitle } from '@ci/common';
import { Button } from '@ci/shadcn';
import { Plus, Search } from '@ci/shadcn/icons';
import { Link } from 'react-router-dom';

import { SavedSearchIcon } from '@/components/icons';
import { PageContent } from '@/components/layout';
import { DropdownProvider } from '@/components/SearchBox/useDropdown';
import { gql } from '@/graphql';
import { type FragmentType, useFragment } from '@/graphql/fragment-masking';

import { CreateSavedSearchModal } from './CreateSavedSearchModal';
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
    variables: { first: 300 },
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
  const [creating, setCreating] = useState(false);

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
          <div className="flex max-w-md flex-col items-center gap-4 text-center">
            <div>
              <div className="font-medium">You don't have any Saved Searches yet.</div>
              <div className="mt-1 text-sm text-muted-foreground">
                Save a search you are running from Memory's advanced filters, or define one from scratch right
                here.
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button onClick={() => setCreating(true)}>
                <Plus className="mr-2 h-4 w-4" />
                New saved search
              </Button>
              <Button variant="outline" asChild>
                <Link to="/memory">
                  <Search className="mr-2 h-4 w-4" />
                  Search Memory
                </Link>
              </Button>
            </div>
          </div>
        }
      />
    );
  } else {
    content = (
      <PageContent>
        <div className="flex w-full justify-end">
          <Button onClick={() => setCreating(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New saved search
          </Button>
        </div>
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

      {creating && (
        <DropdownProvider args={[{ changeSearchParams: false }]}>
          <CreateSavedSearchModal onClose={() => setCreating(false)} />
        </DropdownProvider>
      )}
    </>
  );
}

import { useState } from 'react';

import { useLazyQuery, useQuery } from '@apollo/client';
import { Button, Input, Popover } from '@ci/shadcn';
import { ChevronDown, FolderSearch2 } from '@ci/shadcn/icons';
import { Link, useSearchParams } from 'react-router-dom';

import { gql } from '@/graphql';

import { applySavedSearchToParams, GET_SAVED_SEARCH } from '../../useSavedSearchResolution';

const PICKER_PAGE_SIZE = 8;

const GET_SAVED_SEARCHES_FOR_PICKER = gql(`
  query GetSavedSearchesForPicker($first: Int, $query: String) {
    savedSearches(first: $first, query: $query, isSeed: false) {
      totalCount
      edges {
        node {
          id
          name
          description
        }
      }
    }
  }
`);

/**
 * Quick "load one of my saved searches" control beside the explorer's own
 * Save button — lets a saved search be applied without a trip to the Saved
 * Searches page and back. Scoped to the user's own searches (isSeed: false);
 * the starter library is for browsing on the Saved Searches page, not for
 * this always-visible convenience control.
 */
export function SavedSearchPicker() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [open, setOpen] = useState(false);
  const [filterText, setFilterText] = useState('');

  const { data, loading } = useQuery(GET_SAVED_SEARCHES_FOR_PICKER, {
    variables: { first: PICKER_PAGE_SIZE, query: filterText.trim() || undefined },
    skip: !open,
  });

  const [loadSavedSearch] = useLazyQuery(GET_SAVED_SEARCH);

  const results = data?.savedSearches.edges.map((edge) => edge.node) ?? [];

  const applySearch = async (id: string) => {
    const result = await loadSavedSearch({ variables: { id } });
    const savedSearch = result.data?.savedSearch;

    if (savedSearch) {
      setSearchParams(applySavedSearchToParams(searchParams, savedSearch));
    }

    setOpen(false);
    setFilterText('');
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button variant="outline" size="sm" className="group h-9">
          <FolderSearch2 className="mr-2 h-4 w-4 text-muted-foreground" />
          Load search
          <ChevronDown className="ml-2 h-4 w-4 opacity-50 transition-transform group-data-[state=open]:rotate-180" />
        </Button>
      </Popover.Trigger>
      <Popover.Content className="w-72 p-0" align="end">
        <div className="border-b p-2">
          <Input
            autoFocus
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="Filter your saved searches..."
            className="h-8"
          />
        </div>

        <div className="max-h-72 overflow-y-auto p-1">
          {loading && results.length === 0 ? (
            <div className="px-2 py-4 text-center text-xs text-muted-foreground">Loading…</div>
          ) : results.length === 0 ? (
            <div className="px-2 py-4 text-center text-xs text-muted-foreground">
              {filterText.trim()
                ? `No saved searches match "${filterText.trim()}".`
                : 'No saved searches yet.'}
            </div>
          ) : (
            results.map((result) => (
              <button
                key={result.id}
                type="button"
                className="block w-full truncate rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                onClick={() => void applySearch(result.id)}
              >
                <div className="truncate font-medium">{result.name || 'Untitled saved search'}</div>
                {result.description?.trim() && (
                  <div className="truncate text-xs text-muted-foreground">{result.description}</div>
                )}
              </button>
            ))
          )}
        </div>

        <div className="border-t p-1">
          <Button variant="ghost" size="sm" className="h-8 w-full justify-start text-xs" asChild>
            <Link to="/saved-searches" onClick={() => setOpen(false)}>
              See all saved searches
            </Link>
          </Button>
        </div>
      </Popover.Content>
    </Popover>
  );
}

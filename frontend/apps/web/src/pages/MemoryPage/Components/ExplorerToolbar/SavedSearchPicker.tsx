import { useState } from 'react';

import { useLazyQuery, useQuery } from '@apollo/client';
import { Button, Input, Popover, cn } from '@ci/shadcn';
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
 * How many saved searches the user has of their own — the phone panel's
 * "Saved searches" row shows it. The same query (and variables) the list below
 * opens with, so opening the list after reading the count costs no request.
 */
export function useOwnSavedSearchCount(): number | undefined {
  const { data } = useQuery(GET_SAVED_SEARCHES_FOR_PICKER, {
    variables: { first: PICKER_PAGE_SIZE, query: undefined },
  });

  return data?.savedSearches.totalCount;
}

interface SavedSearchListProps {
  /** The filter box's text; owned by the caller so it survives the list closing. */
  filterText: string;
  onFilterTextChange: (text: string) => void;
  /** The list is done: a search was applied, or the user is off to the Saved Searches page. */
  onClose: () => void;
  /** Focus the filter box on open — right for a desktop popover, not for a phone, where it raises the keyboard over the list. */
  autoFocus?: boolean;
  /** Touch-sized rows, for the phone sheet. */
  touch?: boolean;
  /**
   * Hand the picked search's params to the caller instead of applying them to
   * this page's URL. The header search panel only shows its footer off the
   * explorer, where nothing reads `?search=`, so it opens the search there.
   */
  onOpen?: (params: URLSearchParams) => void;
}

/**
 * The "load one of my saved searches" list: a filter box, the user's own
 * saved searches (isSeed: false), and a way to the full Saved Searches page.
 * Picking one applies it to the URL in place, or hands it to `onOpen` (the
 * header search panel, which opens it in the explorer). Rendered by the desktop picker's popover and
 * by the phone search panel's sheet, so both load a search the same way.
 */
export function SavedSearchList({
  filterText,
  onFilterTextChange,
  onClose,
  autoFocus = true,
  touch = false,
  onOpen,
}: SavedSearchListProps) {
  const [searchParams, setSearchParams] = useSearchParams();

  const { data, loading } = useQuery(GET_SAVED_SEARCHES_FOR_PICKER, {
    variables: { first: PICKER_PAGE_SIZE, query: filterText.trim() || undefined },
  });

  const [loadSavedSearch] = useLazyQuery(GET_SAVED_SEARCH);

  const results = data?.savedSearches.edges.map((edge) => edge.node) ?? [];

  const applySearch = async (id: string) => {
    const result = await loadSavedSearch({ variables: { id } });
    const savedSearch = result.data?.savedSearch;

    if (savedSearch) {
      if (onOpen) {
        // From empty params, so nothing of the page the panel was opened on
        // rides along with the search.
        onOpen(applySavedSearchToParams(new URLSearchParams(), savedSearch));
      } else {
        setSearchParams(applySavedSearchToParams(searchParams, savedSearch));
      }
    }

    onFilterTextChange('');
    onClose();
  };

  return (
    <>
      <div className="border-b p-2">
        <Input
          autoFocus={autoFocus}
          value={filterText}
          onChange={(e) => onFilterTextChange(e.target.value)}
          placeholder="Filter your saved searches..."
          className={touch ? 'h-10' : 'h-8'}
        />
      </div>

      <div className={cn('p-1', !touch && 'max-h-72 overflow-y-auto')}>
        {loading && results.length === 0 ? (
          <div className="px-2 py-4 text-center text-xs text-muted-foreground">Loading…</div>
        ) : results.length === 0 ? (
          <div className="px-2 py-4 text-center text-xs text-muted-foreground">
            {filterText.trim() ? `No saved searches match "${filterText.trim()}".` : 'No saved searches yet.'}
          </div>
        ) : (
          results.map((result) => (
            <button
              key={result.id}
              type="button"
              className={cn(
                'block w-full truncate rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent',
                touch && 'flex min-h-12 flex-col justify-center',
              )}
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
        <Button
          variant="ghost"
          size="sm"
          className={cn('w-full justify-start text-xs', touch ? 'h-11' : 'h-8')}
          asChild
        >
          <Link to="/saved-searches" onClick={onClose}>
            See all saved searches
          </Link>
        </Button>
      </div>
    </>
  );
}

/**
 * Quick "load one of my saved searches" control beside the explorer's own
 * Save button — lets a saved search be applied without a trip to the Saved
 * Searches page and back. Scoped to the user's own searches (isSeed: false);
 * the starter library is for browsing on the Saved Searches page, not for
 * this always-visible convenience control. `onOpen` as on {@link SavedSearchList}.
 */
export function SavedSearchPicker({ onOpen }: { onOpen?: (params: URLSearchParams) => void } = {}) {
  const [open, setOpen] = useState(false);
  const [filterText, setFilterText] = useState('');

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
        <SavedSearchList
          filterText={filterText}
          onFilterTextChange={setFilterText}
          onClose={() => setOpen(false)}
          onOpen={onOpen}
        />
      </Popover.Content>
    </Popover>
  );
}

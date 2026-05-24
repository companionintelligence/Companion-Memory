import { GlobalUID } from '@ci/common';
import { Button } from '@ci/shadcn';
import { Pencil, Trash } from '@ci/shadcn/icons';
import { Link } from 'react-router-dom';

import { gql } from '@/graphql';
import { type FragmentType, useFragment } from '@/graphql/fragment-masking';

interface Props {
  savedSearch: FragmentType<typeof SavedSearchGridItemFragment>;
  openSavedSearchEditModal: (e: React.MouseEvent) => void;
  openSavedSearchDeleteModal: (e: React.MouseEvent) => void;
}

export const SavedSearchGridItemFragment = gql(`
  fragment SavedSearchGridItemFragment on SavedSearchType {
    id
    name
    description
    query
    entityTypes
    tags
  }
`);

export function SavedSearch({
  savedSearch: savedSearchMasked,
  openSavedSearchEditModal,
  openSavedSearchDeleteModal,
}: Props) {
  const savedSearch = useFragment(SavedSearchGridItemFragment, savedSearchMasked);

  return (
    <Link to={`/memory?saved_search=${GlobalUID.parse('saved-search', savedSearch.id)}`} key={savedSearch.id}>
      <div className="h-full w-full flex flex-col border border-border bg-card text-card-foreground shadow-md rounded-lg cursor-pointer select-none p-3 gap-3 hover:shadow-lg transition-shadow duration-75">
        <div className="flex items-center gap-2">
          <div className="text-md font-semibold truncate">{savedSearch.name || 'Untitled Saved Search'}</div>
        </div>
        <div className="flex-1 flex flex-col gap-1 min-h-0">
          <div className="line-clamp-3 leading-tight">{savedSearch.description || '<no description>'}</div>
        </div>
        <div className="flex-1 flex flex-col gap-1">
          <div className="font-bold">Query</div>
          <div className="line-clamp-3 leading-tight">{savedSearch.query || '<no query>'}</div>
        </div>
        <div key="filters" className="flex-1 flex flex-col gap-1">
          <div className="font-bold">Entity Filters</div>
          <div className="line-clamp-3 leading-tight">
            {!savedSearch.entityTypes || savedSearch.entityTypes.length === 0 ? (
              <span className="text-muted-foreground">0 Entity Filters</span>
            ) : (
              <div className="flex flex-wrap gap-1">
                {savedSearch.entityTypes.map((entityType, index) => (
                  <span
                    key={index}
                    className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-primary/10 text-primary border border-primary/20"
                  >
                    {entityType}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center justify-between">
          <Button
            onClick={openSavedSearchEditModal}
            size="icon"
            variant="ghost"
            aria-label="Edit Saved Search"
          >
            <Pencil className="w-4 h-4" />
          </Button>
          <Button
            onClick={openSavedSearchDeleteModal}
            size="icon"
            variant="ghost"
            aria-label="Delete Saved Search"
          >
            <Trash className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </Link>
  );
}

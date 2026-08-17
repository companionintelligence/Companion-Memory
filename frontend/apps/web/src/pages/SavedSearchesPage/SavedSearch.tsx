import { GlobalUID } from '@ci/common';
import { IconButton, Tooltip } from '@ci/shadcn';
import { Pencil, Share2, SlidersHorizontal, Trash } from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { useFeatures } from '@/common/feature';
import { gql } from '@/graphql';
import { type FragmentType, useFragment } from '@/graphql/fragment-masking';

/** Human-readable labels for the secondary filter dimensions a saved search carries. */
function activeFilterDimensions(
  filters?: {
    people?: string[] | null;
    connectors?: string[] | null;
    places?: string[] | null;
    hasLocation?: boolean | null;
    startTime?: string | null;
    endTime?: string | null;
    datePreset?: string | null;
    eventTypes?: string[] | null;
    semantic?: boolean | null;
  } | null,
): string[] {
  if (!filters) {
    return [];
  }

  // Array-of-pairs avoids single-statement `if`s, which the oxlint pre-commit
  // fixer collapses to inline `{ … }` that the Prettier CI check then rejects.
  const dimensions: Array<[boolean, string]> = [
    [Boolean(filters.people?.length), 'Who'],
    [Boolean(filters.places?.length || filters.hasLocation), 'Where'],
    [Boolean(filters.startTime || filters.endTime || filters.datePreset), 'When'],
    [Boolean(filters.eventTypes?.length), 'How'],
    [Boolean(filters.connectors?.length), 'Source'],
    [Boolean(filters.semantic), 'Semantic'],
  ];

  return dimensions.filter(([active]) => active).map(([, label]) => label);
}

interface Props {
  savedSearch: FragmentType<typeof SavedSearchGridItemFragment>;
  openSavedSearchEditModal: (e: React.MouseEvent) => void;
  openSavedSearchShareModal: (e: React.MouseEvent) => void;
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
    filters {
      eventTypes
      startTime
      endTime
      datePreset
      sortBy
      sortOrder
      connectors
      people
      places
      hasLocation
      semantic
    }
    isPublic
    shareToken
  }
`);

export function SavedSearch({
  savedSearch: savedSearchMasked,
  openSavedSearchEditModal,
  openSavedSearchShareModal,
  openSavedSearchDeleteModal,
}: Props) {
  const { t } = useTranslation();
  const savedSearch = useFragment(SavedSearchGridItemFragment, savedSearchMasked);
  const filterDims = activeFilterDimensions(savedSearch.filters);
  // Sharing (the "make public" control) is gated while the access model is hardened.
  const { isFeatureEnabled } = useFeatures();
  const sharingEnabled = isFeatureEnabled('shared.search');

  return (
    <Link to={`/memory?saved_search=${GlobalUID.parse('saved-search', savedSearch.id)}`} key={savedSearch.id}>
      <div className="h-full w-full flex flex-col border border-border bg-card text-card-foreground shadow-md rounded-lg cursor-pointer select-none p-3 gap-3 hover:shadow-lg transition-shadow duration-75">
        <div className="flex items-center gap-2">
          <div className="text-md font-semibold truncate">{savedSearch.name || 'Untitled Saved Search'}</div>
          {sharingEnabled && savedSearch.isPublic && (
            <Tooltip delayDuration={600}>
              <Tooltip.Content>{t('SAVED_SEARCH_SHARED_BADGE')}</Tooltip.Content>
              <Tooltip.Trigger asChild>
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-primary/10 text-primary border border-primary/20">
                  <Share2 className="w-3 h-3" />
                  Shared
                </span>
              </Tooltip.Trigger>
            </Tooltip>
          )}
          {filterDims.length > 0 && (
            <Tooltip delayDuration={600}>
              <Tooltip.Content>
                {t('SAVED_SEARCH_FILTERS_BADGE', { filters: filterDims.join(', ') })}
              </Tooltip.Content>
              <Tooltip.Trigger asChild>
                <span className="inline-flex shrink-0 items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-muted text-muted-foreground border border-border">
                  <SlidersHorizontal className="w-3 h-3" />
                  {filterDims.length}
                </span>
              </Tooltip.Trigger>
            </Tooltip>
          )}
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
          <IconButton onClick={openSavedSearchEditModal} variant="ghost" label={t('SAVED_SEARCH_EDIT')}>
            <Pencil className="w-4 h-4" />
          </IconButton>
          {sharingEnabled && (
            <IconButton onClick={openSavedSearchShareModal} variant="ghost" label={t('SAVED_SEARCH_SHARE')}>
              <Share2 className="w-4 h-4" />
            </IconButton>
          )}
          <IconButton onClick={openSavedSearchDeleteModal} variant="ghost" label={t('SAVED_SEARCH_DELETE')}>
            <Trash className="w-4 h-4" />
          </IconButton>
        </div>
      </div>
    </Link>
  );
}

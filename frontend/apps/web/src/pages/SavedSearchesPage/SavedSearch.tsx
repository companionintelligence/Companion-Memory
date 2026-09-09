import { GlobalUID } from '@ci/common';
import { IconButton, Tooltip } from '@ci/shadcn';
import { Pencil, Share2, Trash } from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { useFeatures } from '@/common/feature';
import { visualForRawType } from '@/components/entities/entityVisuals';
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
    direction?: string | null;
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
    [Boolean(filters.eventTypes?.length), 'Activity'],
    [Boolean(filters.connectors?.length), 'How'],
    [Boolean(filters.direction), 'Direction'],
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
      direction
    }
    isPublic
    shareToken
    isSeed
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
  const entityTypes = savedSearch.entityTypes ?? [];
  const query = savedSearch.query?.trim() || '';
  const description = savedSearch.description?.trim() || '';

  return (
    <Link to={`/memory?saved_search=${GlobalUID.parse('saved-search', savedSearch.id)}`} className="block">
      <div className="flex items-center gap-3 border-b border-border/50 px-2 py-2.5 hover:bg-muted/50 sm:gap-4 sm:px-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium">{savedSearch.name || 'Untitled saved search'}</span>
            {savedSearch.isSeed && (
              <span className="inline-flex shrink-0 items-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Starter
              </span>
            )}
            {sharingEnabled && savedSearch.isPublic && (
              <Tooltip delayDuration={600}>
                <Tooltip.Content>{t('SAVED_SEARCH_SHARED_BADGE')}</Tooltip.Content>
                <Tooltip.Trigger asChild>
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                    <Share2 className="h-3 w-3" />
                    Shared
                  </span>
                </Tooltip.Trigger>
              </Tooltip>
            )}
          </div>
          {description ? (
            <p className="mt-0.5 truncate text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>

        {query ? (
          <span
            className="hidden max-w-[12rem] truncate font-mono text-xs text-muted-foreground sm:inline md:max-w-[16rem]"
            title={query}
          >
            {query}
          </span>
        ) : null}

        {entityTypes.length > 0 ? (
          <div className="hidden min-w-0 items-center gap-1 md:flex">
            {entityTypes.map((entityType) => {
              const visual = visualForRawType(entityType);

              return (
                <span
                  key={entityType}
                  className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: visual.color }}
                  />
                  {visual.label}
                </span>
              );
            })}
          </div>
        ) : null}

        {filterDims.length > 0 ? (
          <span className="hidden shrink-0 text-xs text-muted-foreground lg:inline">
            {filterDims.join(' · ')}
          </span>
        ) : null}

        <div
          className="ml-auto flex shrink-0 items-center"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <IconButton onClick={openSavedSearchEditModal} variant="ghost" label={t('SAVED_SEARCH_EDIT')}>
            <Pencil className="h-4 w-4" />
          </IconButton>
          {sharingEnabled && (
            <IconButton onClick={openSavedSearchShareModal} variant="ghost" label={t('SAVED_SEARCH_SHARE')}>
              <Share2 className="h-4 w-4" />
            </IconButton>
          )}
          <IconButton onClick={openSavedSearchDeleteModal} variant="ghost" label={t('SAVED_SEARCH_DELETE')}>
            <Trash className="h-4 w-4" />
          </IconButton>
        </div>
      </div>
    </Link>
  );
}

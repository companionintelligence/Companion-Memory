import { useCallback, useEffect, useState } from 'react';

import { createHookContext } from '@ci/common';
import { ENTITY_TYPE_MAP } from '@ci/common/src/constants';
import { useSearchParams } from 'react-router-dom';

import {
  type DatePreset,
  type DatePresetSelection,
  resolveDatePreset,
} from '@/pages/MemoryPage/Components/ExplorerToolbar/datePresets';

type ReturnType = [
  {
    isDropdownPanelVisible: boolean;
    selectedEntityTypes: string[];
    tags: string[];
    whenPreset: string;
    dateFrom: string;
    dateTo: string;
    sortBy: string;
    sortOrder: string;
  },
  {
    toggleDropdownPanel: () => void;
    selectAllEntityTypes: () => void;
    clearEntityTypes: () => void;
    toggleEntityType: (type: string) => void;
    /** Tab-style filter: show only this type, or clear back to all when already sole selection. */
    selectOnlyEntityType: (type: string) => void;
    setSelectedEntityTypes: (type: string[]) => void;
    setTags: (tags: string[]) => void;
    setDateRange: (from?: string, to?: string) => void;
    setDatePreset: (preset: DatePresetSelection | null) => void;
    setSort: (sortBy?: string, sortOrder?: string) => void;
  },
];

export const AVAILABLE_ENTITY_TYPES = [
  'Browser',
  'Communication',
  'Content',
  'Event',
  'File',
  'Note',
  'Person',
  'Place',
  'Product',
  'Receipt',
  'Thing',
];

/**
 * Types that come back in search results but have no What picker of their own —
 * Answers come from the Q&A flow and Concepts are derived, so nothing in the UI
 * can select either. Without them here, narrowing to (say) People built an
 * exclude-list out of AVAILABLE_ENTITY_TYPES only, which left answers and
 * concepts in the results alongside the one type the user asked for. They ride
 * along on every exclude-list write.
 */
export const HIDDEN_ENTITY_TYPES = ['Answer', 'Concept'];

/**
 * The `excludedEntityTypes` value for a selection: every available type the user
 * dropped, plus the hidden types. Empty when nothing is narrowed, so callers
 * delete the param and fall back to the unfiltered default.
 */
export function excludedEntityTypesFor(selected: string[]): string[] {
  const excluded = AVAILABLE_ENTITY_TYPES.filter((type) => !selected.includes(type));

  return excluded.length === 0 ? [] : [...excluded, ...HIDDEN_ENTITY_TYPES];
}

/**
 * The entity types a saved search STORES for a selection: the raw names of
 * the chosen types when the selection is narrower than the full pickable set,
 * and nothing at all when it is not. "Every type" is the picker's resting
 * state, not a choice, and writing all eleven names into the row made a
 * search saved with no What filter look narrowed on its card (eleven type
 * dots against a seed's none) and, run as a shared search, drop the hidden
 * kinds the picker never offers. Restore already reads an empty list as "no
 * narrowing", so this changes only what is written.
 */
export function savedEntityTypesFor(selected: string[]): string[] {
  const narrowed = AVAILABLE_ENTITY_TYPES.some((type) => !selected.includes(type));

  return narrowed ? selected.map((type) => ENTITY_TYPE_MAP[type as keyof typeof ENTITY_TYPE_MAP]) : [];
}

function sameEntityTypes(a: string[], b: string[]) {
  return a.length === b.length && a.every((type, index) => type === b[index]);
}

function useDropdown({ changeSearchParams = true }: { changeSearchParams: boolean }): ReturnType {
  const [searchParams, setSearchParams] = useSearchParams();

  const [isDropdownPanelVisible, setDropdownPanelVisible] = useState(false);
  const [selectedEntityTypes, setSelectedEntityTypes] = useState<string[]>(AVAILABLE_ENTITY_TYPES);
  const excludedEntityTypesParam = searchParams.get('excludedEntityTypes') ?? '';
  const includedEntityTypesParam = searchParams.get('includedEntityTypes') ?? '';

  // Sync entity types with URL parameters
  useEffect(() => {
    const excludedEntityTypes = excludedEntityTypesParam.split(',').filter(Boolean);
    const selectedTypes = AVAILABLE_ENTITY_TYPES.filter((type) => !excludedEntityTypes.includes(type));

    if (changeSearchParams) {
      setSelectedEntityTypes((prev) => (sameEntityTypes(prev, selectedTypes) ? prev : selectedTypes));
    }
  }, [changeSearchParams, excludedEntityTypesParam]);

  // Sync entity types with URL parameters
  useEffect(() => {
    const includedEntityTypes = includedEntityTypesParam.split(',').filter(Boolean);
    if (includedEntityTypes.length > 0) {
      const selectedTypes = AVAILABLE_ENTITY_TYPES.filter((type) => includedEntityTypes.includes(type));

      if (changeSearchParams) {
        setSelectedEntityTypes((prev) => (sameEntityTypes(prev, selectedTypes) ? prev : selectedTypes));
      }
    }
  }, [changeSearchParams, includedEntityTypesParam]);

  // Both callbacks must re-capture `setSearchParams` whenever it changes:
  // react-router's setter closes over the params of the render it was created
  // in, so a stale instance navigates to a URL rebuilt from those old params,
  // resurrecting filters (e.g. ?bbox) removed since.
  const clearEntityTypes = useCallback(() => {
    setSelectedEntityTypes(AVAILABLE_ENTITY_TYPES);

    if (changeSearchParams) {
      setSearchParams((searchParams) => {
        searchParams.delete('excludedEntityTypes');

        return searchParams;
      });
    }
  }, [changeSearchParams, setSearchParams]);

  const selectAllEntityTypes = useCallback(() => {
    setSelectedEntityTypes([]);

    if (changeSearchParams) {
      setSearchParams((searchParams) => {
        searchParams.set(
          'excludedEntityTypes',
          [...AVAILABLE_ENTITY_TYPES, ...HIDDEN_ENTITY_TYPES].join(','),
        );

        return searchParams;
      });
    }
  }, [changeSearchParams, setSearchParams]);

  const toggleEntityType = useCallback(
    (entityType: string) => {
      setSelectedEntityTypes((prev) => {
        // Included -> exclude it, excluded -> include it back.
        const next = prev.includes(entityType)
          ? prev.filter((type) => type !== entityType)
          : [...prev, entityType];
        const excludedTypes = excludedEntityTypesFor(next);

        if (changeSearchParams) {
          setSearchParams((searchParams) => {
            if (excludedTypes.length === 0) {
              searchParams.delete('excludedEntityTypes');
            } else {
              searchParams.set('excludedEntityTypes', excludedTypes.join(','));
            }

            return searchParams;
          });
        }

        return next;
      });
    },
    [setSearchParams],
  );

  const selectOnlyEntityType = useCallback(
    (entityType: string) => {
      setSelectedEntityTypes((prev) => {
        const isOnlySelected = prev.length === 1 && prev[0] === entityType;

        if (isOnlySelected) {
          if (changeSearchParams) {
            setSearchParams((searchParams) => {
              searchParams.delete('excludedEntityTypes');
              searchParams.delete('includedEntityTypes');

              return searchParams;
            });
          }

          return AVAILABLE_ENTITY_TYPES;
        }

        const next = [entityType];
        const excludedTypes = excludedEntityTypesFor(next);

        if (changeSearchParams) {
          setSearchParams((searchParams) => {
            searchParams.delete('includedEntityTypes');

            if (excludedTypes.length === 0) {
              searchParams.delete('excludedEntityTypes');
            } else {
              searchParams.set('excludedEntityTypes', excludedTypes.join(','));
            }

            return searchParams;
          });
        }

        return next;
      });
    },
    [changeSearchParams, setSearchParams],
  );

  const toggleDropdownPanel = useCallback(() => {
    setDropdownPanelVisible((prev) => !prev);
  }, []);

  // Date range, tags, and sort are read straight from the URL (no inversion logic like entity
  // types), so derive them per-render and write through setters that update the search params.
  // One `tags` occurrence per label (`?tags=a&tags=b`), like `people` / `places`.
  const tags = searchParams
    .getAll('tags')
    .map((tag) => tag.trim())
    .filter(Boolean);
  const whenPreset = searchParams.get('when') || '';
  const dateFrom = searchParams.get('from') || '';
  const dateTo = searchParams.get('to') || '';
  const sortBy = searchParams.get('sortBy') || '';
  const sortOrder = searchParams.get('sortOrder') || '';

  const setTags = useCallback(
    (next: string[]) => {
      if (!changeSearchParams) {
        return;
      }

      setSearchParams((params) => {
        params.delete('tags');

        for (const tag of next) {
          params.append('tags', tag);
        }

        return params;
      });
    },
    [changeSearchParams, setSearchParams],
  );

  const setDateRange = useCallback(
    (from?: string, to?: string) => {
      if (!changeSearchParams) {
        return;
      }

      setSearchParams((params) => {
        if (from) {
          params.set('from', from);
        } else {
          params.delete('from');
        }

        if (to) {
          params.set('to', to);
        } else {
          params.delete('to');
        }

        if (!from && !to) {
          params.delete('when');
        } else {
          params.set('when', 'custom');
        }

        return params;
      });
    },
    [changeSearchParams, setSearchParams],
  );

  const setDatePreset = useCallback(
    (preset: DatePresetSelection | null) => {
      if (!changeSearchParams) {
        return;
      }

      setSearchParams((params) => {
        if (!preset) {
          params.delete('when');
          params.delete('from');
          params.delete('to');

          return params;
        }

        if (preset === 'custom') {
          params.set('when', 'custom');

          return params;
        }

        const { from, to } = resolveDatePreset(preset as DatePreset);
        params.set('when', preset);
        params.set('from', from);
        params.set('to', to);

        return params;
      });
    },
    [changeSearchParams, setSearchParams],
  );

  const setSort = useCallback(
    (nextSortBy?: string, nextSortOrder?: string) => {
      if (!changeSearchParams) {
        return;
      }

      setSearchParams((params) => {
        if (nextSortBy) {
          params.set('sortBy', nextSortBy);
        } else {
          params.delete('sortBy');
        }

        if (nextSortOrder) {
          params.set('sortOrder', nextSortOrder);
        } else {
          params.delete('sortOrder');
        }

        return params;
      });
    },
    [changeSearchParams, setSearchParams],
  );

  return [
    {
      isDropdownPanelVisible,
      selectedEntityTypes,
      tags,
      whenPreset,
      dateFrom,
      dateTo,
      sortBy,
      sortOrder,
    },
    {
      toggleDropdownPanel,
      selectAllEntityTypes,
      clearEntityTypes,
      toggleEntityType,
      selectOnlyEntityType,
      setSelectedEntityTypes,
      setTags,
      setDateRange,
      setDatePreset,
      setSort,
    },
  ];
}

const { Provider: DropdownProvider, useHookContext: useDropdownContext } = createHookContext(useDropdown);

export { DropdownProvider, useDropdownContext as useDropdown };

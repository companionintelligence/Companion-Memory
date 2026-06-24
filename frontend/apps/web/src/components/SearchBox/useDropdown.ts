import { useCallback, useEffect, useState } from 'react';

import { createHookContext } from '@ci/common';
import { useSearchParams } from 'react-router-dom';

type ReturnType = [
  {
    isDropdownPanelVisible: boolean;
    selectedEntityTypes: string[];
    tags: string[];
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
    setSelectedEntityTypes: (type: string[]) => void;
    setTags: (tags: string[]) => void;
    setDateRange: (from?: string, to?: string) => void;
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
  'Thing',
];

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

  const clearEntityTypes = useCallback(() => {
    setSelectedEntityTypes(AVAILABLE_ENTITY_TYPES);

    if (changeSearchParams) {
      setSearchParams((searchParams) => {
        searchParams.delete('excludedEntityTypes');

        return searchParams;
      });
    }
  }, []);

  const selectAllEntityTypes = useCallback(() => {
    setSelectedEntityTypes([]);

    if (changeSearchParams) {
      setSearchParams((searchParams) => {
        searchParams.set('excludedEntityTypes', AVAILABLE_ENTITY_TYPES.join(','));

        return searchParams;
      });
    }
  }, []);

  const toggleEntityType = useCallback(
    (entityType: string) => {
      setSelectedEntityTypes((prev) => {
        let next: string[] = [];
        let excludedTypes: string[] = [];

        if (prev.includes(entityType)) {
          // Entity was included, now exclude it
          next = prev.filter((type) => type !== entityType);
          excludedTypes = AVAILABLE_ENTITY_TYPES.filter((type) => !next.includes(type));
        } else {
          // Entity was excluded, now include it
          next = [...prev, entityType];
          excludedTypes = AVAILABLE_ENTITY_TYPES.filter((type) => !next.includes(type));
        }

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

  const toggleDropdownPanel = useCallback(() => {
    setDropdownPanelVisible((prev) => !prev);
  }, []);

  // Date range, tags, and sort are read straight from the URL (no inversion logic like entity
  // types), so derive them per-render and write through setters that update the search params.
  const tags = searchParams.get('tags')?.split(',').filter(Boolean) || [];
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
        if (next.length === 0) {
          params.delete('tags');
        } else {
          params.set('tags', next.join(','));
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
      setSelectedEntityTypes,
      setTags,
      setDateRange,
      setSort,
    },
  ];
}

const { Provider: DropdownProvider, useHookContext: useDropdownContext } = createHookContext(useDropdown);

export { DropdownProvider, useDropdownContext as useDropdown };

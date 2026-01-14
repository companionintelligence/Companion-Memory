import { useCallback, useEffect, useState } from 'react';

import { createHookContext } from '@ci/common';
import { useSearchParams } from 'react-router-dom';

type ReturnType = [
  {
    isFiltersPanelVisible: boolean;
    selectedEntityTypes: string[];
  },
  {
    toggleFilterPanel: () => void;
    selectAllEntityTypes: () => void;
    clearEntityTypes: () => void;
    toggleEntityType: (type: string) => void;
  },
];

export const AVAILABLE_ENTITY_TYPES = [
  'Person',
  'Event',
  'Content',
  'Browser',
  'Thing',
  'Contact',
  'Place',
  'Location',
  'Document',
  'File',
  'Channel',
  'Video',
  'Communication',
];

function useFilters(): ReturnType {
  const [searchParams, setSearchParams] = useSearchParams();

  const [isFiltersPanelVisible, setFilterPanelVisibile] = useState(false);
  const [selectedEntityTypes, setSelectedEntityTypes] = useState<string[]>(AVAILABLE_ENTITY_TYPES);

  // Sync entity types with URL parameters
  useEffect(() => {
    const excludedEntityTypes = searchParams.get('excludedEntityTypes')?.split(',').filter(Boolean) || [];
    const selectedTypes = AVAILABLE_ENTITY_TYPES.filter((type) => !excludedEntityTypes.includes(type));

    setSelectedEntityTypes(selectedTypes);
  }, [searchParams]);

  const clearEntityTypes = useCallback(() => {
    setSelectedEntityTypes(AVAILABLE_ENTITY_TYPES);

    setSearchParams((searchParams) => {
      searchParams.delete('excludedEntityTypes');

      return searchParams;
    });
  }, []);

  const selectAllEntityTypes = useCallback(() => {
    setSelectedEntityTypes([]);

    setSearchParams((searchParams) => {
      searchParams.set('excludedEntityTypes', AVAILABLE_ENTITY_TYPES.join(','));

      return searchParams;
    });
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

        setSearchParams((searchParams) => {
          if (excludedTypes.length === 0) {
            searchParams.delete('excludedEntityTypes');
          } else {
            searchParams.set('excludedEntityTypes', excludedTypes.join(','));
          }

          return searchParams;
        });

        return next;
      });
    },
    [setSearchParams],
  );

  const toggleFilterPanel = useCallback(() => {
    setFilterPanelVisibile((prev) => !prev);
  }, []);

  return [
    {
      isFiltersPanelVisible,
      selectedEntityTypes,
    },
    {
      toggleFilterPanel,
      selectAllEntityTypes,
      clearEntityTypes,
      toggleEntityType,
    },
  ];
}

const { Provider: FiltersProvider, useHookContext: useFiltersContext } = createHookContext(useFilters);

export { FiltersProvider, useFiltersContext as useFilters };

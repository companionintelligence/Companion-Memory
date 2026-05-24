import { useCallback, useEffect, useState } from 'react';

import { createHookContext } from '@ci/common';
import { useSearchParams } from 'react-router-dom';

type ReturnType = [
  {
    isDropdownPanelVisible: boolean;
    selectedEntityTypes: string[];
  },
  {
    toggleDropdownPanel: () => void;
    selectAllEntityTypes: () => void;
    clearEntityTypes: () => void;
    toggleEntityType: (type: string) => void;
    setSelectedEntityTypes: (type: string[]) => void;
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

function useDropdown({ changeSearchParams = true }: { changeSearchParams: boolean }): ReturnType {
  const [searchParams, setSearchParams] = useSearchParams();

  const [isDropdownPanelVisible, setDropdownPanelVisible] = useState(false);
  const [selectedEntityTypes, setSelectedEntityTypes] = useState<string[]>(AVAILABLE_ENTITY_TYPES);

  // Sync entity types with URL parameters
  useEffect(() => {
    const excludedEntityTypes = searchParams.get('excludedEntityTypes')?.split(',').filter(Boolean) || [];
    const selectedTypes = AVAILABLE_ENTITY_TYPES.filter((type) => !excludedEntityTypes.includes(type));

    if (changeSearchParams) {
      setSelectedEntityTypes(selectedTypes);
    }
  }, [searchParams]);

  // Sync entity types with URL parameters
  useEffect(() => {
    const includedEntityTypes = searchParams.get('includedEntityTypes')?.split(',').filter(Boolean) || [];
    if (includedEntityTypes.length > 0) {
      const selectedTypes = AVAILABLE_ENTITY_TYPES.filter((type) => includedEntityTypes.includes(type));

      if (changeSearchParams) {
        setSelectedEntityTypes(selectedTypes);
      }
    }
  }, [searchParams]);

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

  return [
    {
      isDropdownPanelVisible,
      selectedEntityTypes,
    },
    {
      toggleDropdownPanel,
      selectAllEntityTypes,
      clearEntityTypes,
      toggleEntityType,
      setSelectedEntityTypes,
    },
  ];
}

const { Provider: DropdownProvider, useHookContext: useDropdownContext } = createHookContext(useDropdown);

export { DropdownProvider, useDropdownContext as useDropdown };

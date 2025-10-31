import { useState, useRef, useEffect, useCallback } from 'react';

import { Checkbox } from '@ci/shadcn';
import { ChevronDown } from '@ci/shadcn/icons';
import { createPortal } from 'react-dom';

interface EntityTypeFilterProps {
  selectedEntityTypes: string[];
  onEntityTypesChange: (entityTypes: string[]) => void;
}

const AVAILABLE_ENTITY_TYPES = [
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

export function EntityTypeFilter({ selectedEntityTypes, onEntityTypesChange }: EntityTypeFilterProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const handleButtonClick = useCallback(() => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setButtonRect(rect);
    }

    setIsOpen(!isOpen);
  }, [isOpen]);

  const handleEntityTypeToggle = useCallback(
    (entityType: string, event?: React.SyntheticEvent) => {
      // Prevent event bubbling
      if (event) {
        event.stopPropagation();
        event.preventDefault();
      }

      if (selectedEntityTypes.includes(entityType)) {
        // Remove from selected (exclude it)
        const newTypes = selectedEntityTypes.filter((type) => type !== entityType);
        onEntityTypesChange(newTypes);
      } else {
        // Add to selected (include it)
        const newTypes = [...selectedEntityTypes, entityType];
        onEntityTypesChange(newTypes);
      }
    },
    [selectedEntityTypes, onEntityTypesChange],
  );

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;

      // Check if click is on button
      const isButtonClick = buttonRef.current?.contains(target);

      // Check if click is on dropdown content
      const isDropdownClick = dropdownRef.current?.contains(target);

      // Check if click is on any form element (checkbox, button, label)
      const isFormElement =
        target instanceof HTMLInputElement ||
        target instanceof HTMLButtonElement ||
        target instanceof HTMLLabelElement;

      // Only close if clicking outside both button and dropdown, and not on form elements
      if (!isButtonClick && !isDropdownClick && !isFormElement) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      // Use a slight delay to avoid immediate closure
      const timeoutId = setTimeout(() => {
        document.addEventListener('mousedown', handleClickOutside);
      }, 100);

      return () => {
        clearTimeout(timeoutId);
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [isOpen]);

  const selectedCount = selectedEntityTypes.length;
  const totalCount = AVAILABLE_ENTITY_TYPES.length;
  const isAllSelected = selectedCount === totalCount;
  const isNoneSelected = selectedCount === 0;

  const getDisplayText = () => {
    if (isAllSelected) {
      return 'All Entity Types';
    }

    if (isNoneSelected) {
      return 'No Entity Types';
    }

    if (selectedCount === 1) {
      return selectedEntityTypes[0];
    }

    return `${selectedCount} Entity Types`;
  };

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={handleButtonClick}
        className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground min-w-[160px] justify-between"
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label="Select entity types to filter"
      >
        <span>{getDisplayText()}</span>
        <ChevronDown className={`h-4 w-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen &&
        buttonRect &&
        createPortal(
          <div
            ref={dropdownRef}
            className="fixed bg-background border border-border rounded-md shadow-lg z-[9999] max-h-80 overflow-y-auto w-64"
            style={{
              top: buttonRect.bottom + 4,
              left: buttonRect.left,
            }}
            role="listbox"
            aria-label="Entity type options"
          >
            <div className="p-2">
              <div className="flex items-center justify-between p-2 border-b border-border mb-2">
                <span className="text-sm font-medium">Entity Types</span>
                <div className="flex gap-2">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onEntityTypesChange(AVAILABLE_ENTITY_TYPES);
                    }}
                    className="text-xs px-2 py-1 rounded hover:bg-accent"
                  >
                    All
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onEntityTypesChange([]);
                    }}
                    className="text-xs px-2 py-1 rounded hover:bg-accent"
                  >
                    None
                  </button>
                </div>
              </div>

              <div className="space-y-1">
                {AVAILABLE_ENTITY_TYPES.map((entityType) => (
                  <label
                    key={entityType}
                    className="flex items-center gap-2 p-2 rounded hover:bg-accent cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleEntityTypeToggle(entityType, e);
                    }}
                  >
                    <Checkbox
                      checked={selectedEntityTypes.includes(entityType)}
                      onChange={(e) => {
                        e.stopPropagation();
                        handleEntityTypeToggle(entityType, e);
                      }}
                    />
                    <span className="text-sm">{entityType}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

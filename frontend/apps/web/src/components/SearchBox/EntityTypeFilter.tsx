import { useState } from 'react';

import { Button, DropdownMenu } from '@ci/shadcn';
import { ChevronDown, Shapes } from '@ci/shadcn/icons';

import { AVAILABLE_ENTITY_TYPES, useDropdown } from './useDropdown';

interface Props {
  modal?: boolean;
  /**
   * When set, renders a plain "{label}: {value}" trigger (e.g. "What: all") for
   * the explorer's Who/What/When/Where/How bar. Omit to keep the standalone
   * "All Entity Types" wording used elsewhere (e.g. the saved-search editor).
   */
  label?: string;
}

export function EntityTypeFilter({ modal = true, label }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [{ selectedEntityTypes }, { clearEntityTypes, selectAllEntityTypes, toggleEntityType }] =
    useDropdown();

  const { CheckboxItem, Content, Label, Separator, Trigger } = DropdownMenu;

  const selectedCount = selectedEntityTypes.length;
  const totalCount = AVAILABLE_ENTITY_TYPES.length;
  const isAllSelected = selectedCount === totalCount;
  const isNoneSelected = selectedCount === 0;

  const getDisplayText = () => {
    if (label) {
      const value = isAllSelected
        ? 'all'
        : isNoneSelected
          ? 'none'
          : selectedCount === 1
            ? selectedEntityTypes[0]
            : `${selectedCount} selected`;

      return `${label}: ${value}`;
    }

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

  const menuLabel = label ? 'Types' : 'Entity Types';

  return (
    <DropdownMenu modal={modal} onOpenChange={() => setIsOpen(!isOpen)}>
      <Trigger asChild>
        <Button type="button" variant="outline">
          {label && <Shapes className="mr-2 h-4 w-4 text-muted-foreground" />}
          {getDisplayText()}
          <ChevronDown
            className={`ml-2 h-4 w-4 opacity-50 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          />
        </Button>
      </Trigger>

      <Content id="entity-type-filters" align="start" sideOffset={4} className="z-[9999] w-72 p-2">
        <div className="flex items-center justify-between gap-3 px-1 pb-2">
          <Label className="text-sm font-medium">{menuLabel}</Label>
          <div className="flex gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clearEntityTypes}
              disabled={isAllSelected}
              className="h-7 px-2 text-xs"
            >
              Select all
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={selectAllEntityTypes}
              disabled={isNoneSelected}
              className="h-7 px-2 text-xs"
            >
              Clear all
            </Button>
          </div>
        </div>
        <Separator />
        {AVAILABLE_ENTITY_TYPES.map((entityType) => {
          const isChecked = selectedEntityTypes.includes(entityType);

          return (
            <CheckboxItem
              key={entityType}
              checked={isChecked}
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                toggleEntityType(entityType);
              }}
            >
              {entityType}
            </CheckboxItem>
          );
        })}
      </Content>
    </DropdownMenu>
  );
}

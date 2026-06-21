import { useState } from 'react';

import { Button, DropdownMenu } from '@ci/shadcn';
import { ChevronDown } from '@ci/shadcn/icons';

import { AVAILABLE_ENTITY_TYPES, useDropdown } from './useDropdown';

interface Props {
  modal?: boolean;
}

export function EntityTypeFilter({ modal = true }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [{ selectedEntityTypes }, { clearEntityTypes, selectAllEntityTypes, toggleEntityType }] =
    useDropdown();

  const { CheckboxItem, Content, Label, Separator, Trigger } = DropdownMenu;

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
    <DropdownMenu modal={modal} onOpenChange={() => setIsOpen(!isOpen)}>
      <Trigger>
        <Button type="button" variant="outline">
          {getDisplayText()}
          <ChevronDown className={`h-4 w-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </Button>
      </Trigger>

      <Content
        id="entity-type-filters"
        className="fixed bg-background border border-border rounded-md shadow-lg z-[9999] max-h-80 overflow-y-auto w-64"
      >
        <div className="flex gap-2">
          <Label className="p-2 font-medium">Entity Types</Label>
          <div className="flex gap-2">
            <Button
              onClick={clearEntityTypes}
              className="text-xs px-4 py-1 bg-background text-primary hover:text-background"
            >
              All
            </Button>
            <Button
              onClick={selectAllEntityTypes}
              className="text-xs px-4 py-1 bg-background text-primary hover:text-background"
            >
              None
            </Button>
          </div>
        </div>
        <Separator />
        {AVAILABLE_ENTITY_TYPES.map((entityType) => {
          const isChecked = selectedEntityTypes.includes(entityType);

          return (
            <CheckboxItem
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

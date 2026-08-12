import { useState, type ComponentType } from 'react';

import { useQuery } from '@apollo/client';
import { Button, DropdownMenu, cn } from '@ci/shadcn';
import { ChevronDown, Shapes, Tag as TagIcon } from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';

import { AVAILABLE_ENTITY_TYPES, useDropdown } from '@/components/SearchBox/useDropdown';
import { TagInput } from '@/components/TagInput';
import { gql } from '@/graphql';
import { MemoryExplorerFilterControls } from '@/pages/MemoryPage/Components/ExplorerToolbar/ExplorerToolbar';

import {
  WHAT_BAR_ICON_CLASS,
  WHAT_BAR_ITEM_ICON_CLASS,
  WHAT_CATEGORIES,
  entityTypesForCategory,
  type EntityTypeIcon,
  type WhatCategory,
} from './entityTypeCategories';

const GET_TAGS = gql(`
  query GetTags {
    tags {
      edges {
        node {
          id
          label
          description
        }
      }
    }
  }
`);

// The account's distinct event kinds (visited, messaged, traveled, …) — the
// same dimension the Search box's How filter reads.
const GET_EVENT_TYPES = gql(`
  query WhatBarEventTypes {
    eventTypes
  }
`);

const EXPAND_LABEL_CLASS =
  'max-w-0 overflow-hidden whitespace-nowrap opacity-0 transition-all duration-200 ease-out group-hover:ml-1.5 group-hover:max-w-[7rem] group-hover:opacity-100 group-focus-visible:ml-1.5 group-focus-visible:max-w-[7rem] group-focus-visible:opacity-100 group-data-[state=open]:ml-1.5 group-data-[state=open]:max-w-[7rem] group-data-[state=open]:opacity-100';

function categoryButtonClass(selected: boolean, active: boolean) {
  return cn(
    'group inline-flex h-8 shrink-0 items-center rounded-md border px-2 text-sm font-medium transition-colors',
    selected
      ? 'border-primary bg-background text-foreground shadow-sm'
      : active
        ? 'border-border bg-background text-foreground hover:bg-accent'
        : 'border-border bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground',
  );
}

function CategoryIcon({
  icon: Icon,
  className,
  toneClass,
  entityIcon = false,
}: {
  icon: EntityTypeIcon | ComponentType<{ className?: string; colorized?: boolean }>;
  className?: string;
  toneClass?: string;
  entityIcon?: boolean;
}) {
  const iconClassName = cn('h-4 w-4 shrink-0', toneClass, className);

  if (entityIcon && toneClass) {
    return <Icon className={iconClassName} colorized={false} />;
  }

  return <Icon className={iconClassName} />;
}

function useWhatSelection() {
  const [searchParams] = useSearchParams();
  const [{ selectedEntityTypes, tags }, actions] = useDropdown();

  const includedOnly = searchParams.get('includedEntityTypes');
  const excludedOnly = searchParams.get('excludedEntityTypes');
  const isFiltered = Boolean(includedOnly || excludedOnly);
  const allSelected = selectedEntityTypes.length === AVAILABLE_ENTITY_TYPES.length;

  const isEntityTypeSelected = (entityType: string) =>
    isFiltered && selectedEntityTypes.length === 1 && selectedEntityTypes[0] === entityType;

  const isGroupSelected = (types: string[]) => {
    if (!isFiltered || types.length === 0) {
      return false;
    }

    const selectedSet = new Set(selectedEntityTypes);

    return (
      types.every((type) => selectedSet.has(type)) &&
      selectedEntityTypes.every((type) => types.includes(type))
    );
  };

  const isGroupActive = (types: string[]) =>
    allSelected || types.some((type) => selectedEntityTypes.includes(type));

  return {
    allSelected,
    isFiltered,
    isEntityTypeSelected,
    isGroupSelected,
    isGroupActive,
    selectedEntityTypes,
    tags,
    ...actions,
  };
}

function StandaloneWhatButton({
  category,
  onSelect,
  selected,
  active,
}: {
  category: Extract<WhatCategory, { kind: 'standalone' }>;
  onSelect: () => void;
  selected: boolean;
  active: boolean;
}) {
  // No tooltip here: EXPAND_LABEL_CLASS already animates the label into view on
  // hover and focus, so a bubble would paint the same text a second time, on top
  // of the text it duplicates.
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={category.label}
      onClick={onSelect}
      className={categoryButtonClass(selected, active)}
    >
      <CategoryIcon icon={category.icon} toneClass={WHAT_BAR_ICON_CLASS[category.id]} entityIcon />
      <span className={EXPAND_LABEL_CLASS}>{category.label}</span>
    </button>
  );
}

function GroupWhatDropdown({
  category,
  selectedEntityTypes,
  isGroupSelected,
  isGroupActive,
  onSelectOnly,
  onToggleType,
}: {
  category: Extract<WhatCategory, { kind: 'group' }>;
  selectedEntityTypes: string[];
  isGroupSelected: (types: string[]) => boolean;
  isGroupActive: (types: string[]) => boolean;
  onSelectOnly: (entityType: string) => void;
  onToggleType: (entityType: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const types = entityTypesForCategory(category);
  const selected = isGroupSelected(types);
  const active = isGroupActive(types);
  const { CheckboxItem, Content, Label, Separator, Trigger } = DropdownMenu;

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      {/* No tooltip: the label already expands inline on hover (EXPAND_LABEL_CLASS). */}
      <Trigger asChild>
        <button
          type="button"
          aria-pressed={active}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={category.label}
          className={categoryButtonClass(selected, active)}
        >
          <CategoryIcon icon={category.icon} toneClass={WHAT_BAR_ICON_CLASS[category.id]} entityIcon />
          <span className={EXPAND_LABEL_CLASS}>{category.label}</span>
          <ChevronDown
            className={cn(
              'ml-0 h-3.5 w-3.5 shrink-0 opacity-50 transition-transform duration-200 group-hover:ml-1 group-data-[state=open]:ml-1 group-data-[state=open]:rotate-180',
            )}
          />
        </button>
      </Trigger>

      <Content align="start" sideOffset={4} className="z-[9999] w-56 p-2">
        <Label className="px-1 pb-2 text-sm font-medium">{category.label}</Label>
        <Separator className="mb-1" />
        {category.items.map(({ entityType, label, icon: ItemIcon }) => {
          const isChecked = selectedEntityTypes.includes(entityType);
          const isOnly = selectedEntityTypes.length === 1 && selectedEntityTypes[0] === entityType;

          return (
            <CheckboxItem
              key={entityType}
              checked={isChecked}
              onClick={(event) => {
                event.stopPropagation();
                event.preventDefault();

                if (category.items.length === 1) {
                  onSelectOnly(entityType);

                  return;
                }

                onToggleType(entityType);
              }}
              onSelect={(event) => {
                event.preventDefault();
              }}
              className="gap-2"
            >
              <span className="flex items-center gap-2">
                {ItemIcon ? (
                  <ItemIcon
                    className={cn('h-4 w-4 shrink-0', WHAT_BAR_ITEM_ICON_CLASS[entityType])}
                    colorized={false}
                  />
                ) : null}
                <span>{label}</span>
                {isOnly ? <span className="text-xs text-muted-foreground">(only)</span> : null}
              </span>
            </CheckboxItem>
          );
        })}
        {category.items.length > 1 && (
          <>
            <Separator className="my-1" />
            {category.items.map(({ entityType, label }) => (
              <Button
                key={`only-${entityType}`}
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 w-full justify-start px-2 text-xs font-normal"
                onClick={() => {
                  onSelectOnly(entityType);
                  setOpen(false);
                }}
              >
                Only {label}
              </Button>
            ))}
          </>
        )}
      </Content>
    </DropdownMenu>
  );
}

/**
 * The Events category: the LifeScope-style hover-expanding icon button whose
 * dropdown filters by KIND of event. Checking kinds writes the shared
 * `eventTypes` URL param (the explorer's How dimension — List, Gallery, Map
 * and the graph all honor it); "Only Events" narrows the entity-type
 * selection to Event like any standalone What button.
 */
function EventsWhatDropdown({
  category,
  selected,
  active,
  onSelectOnly,
}: {
  category: Extract<WhatCategory, { kind: 'events' }>;
  selected: boolean;
  active: boolean;
  onSelectOnly: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const { data } = useQuery(GET_EVENT_TYPES, { skip: !open });
  const availableEventTypes: string[] = data?.eventTypes ?? [];
  const selectedEventTypes = searchParams.get('eventTypes')?.split(',').filter(Boolean) ?? [];
  const { CheckboxItem, Content, Label, Separator, Trigger } = DropdownMenu;

  const filterEngaged = selected || selectedEventTypes.length > 0;

  const setEventTypes = (next: string[]) => {
    setSearchParams((params) => {
      if (next.length === 0) {
        params.delete('eventTypes');
      } else {
        params.set('eventTypes', next.join(','));
      }

      return params;
    });
  };

  const toggleEventType = (eventType: string) => {
    if (selectedEventTypes.includes(eventType)) {
      setEventTypes(selectedEventTypes.filter((type) => type !== eventType));
    } else {
      setEventTypes([...selectedEventTypes, eventType]);
    }
  };

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      {/* No tooltip: the label already expands inline on hover (EXPAND_LABEL_CLASS). */}
      <Trigger asChild>
        <button
          type="button"
          aria-pressed={active}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={category.label}
          className={categoryButtonClass(filterEngaged, active)}
        >
          <CategoryIcon icon={category.icon} toneClass={WHAT_BAR_ICON_CLASS[category.id]} entityIcon />
          <span className={EXPAND_LABEL_CLASS}>{category.label}</span>
          <ChevronDown
            className={cn(
              'ml-0 h-3.5 w-3.5 shrink-0 opacity-50 transition-transform duration-200 group-hover:ml-1 group-data-[state=open]:ml-1 group-data-[state=open]:rotate-180',
            )}
          />
        </button>
      </Trigger>

      <Content align="start" sideOffset={4} className="z-[9999] max-h-80 w-56 overflow-y-auto p-2">
        <div className="flex items-center justify-between px-1 pb-2">
          <Label className="p-0 text-sm font-medium">Events</Label>
          {selectedEventTypes.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => setEventTypes([])}
            >
              Clear
            </Button>
          )}
        </div>
        <Separator className="mb-1" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 w-full justify-start px-2 text-xs font-normal"
          onClick={() => {
            onSelectOnly();
            setOpen(false);
          }}
        >
          Only Events
        </Button>
        <Separator className="my-1" />
        <Label className="px-1 py-1 text-xs font-medium text-muted-foreground">By activity</Label>
        {availableEventTypes.length === 0 ? (
          <div className="p-2 text-xs text-muted-foreground">No activity types yet</div>
        ) : (
          availableEventTypes.map((eventType) => (
            <CheckboxItem
              key={eventType}
              checked={selectedEventTypes.includes(eventType)}
              onClick={(event) => {
                event.stopPropagation();
                event.preventDefault();
                toggleEventType(eventType);
              }}
              onSelect={(event) => {
                event.preventDefault();
              }}
            >
              {eventType}
            </CheckboxItem>
          ))
        )}
      </Content>
    </DropdownMenu>
  );
}

function TagWhatDropdown({ tags, onTagsChange }: { tags: string[]; onTagsChange: (next: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const active = tags.length > 0;
  const { data } = useQuery(GET_TAGS, { skip: !open });
  const suggestions = data?.tags?.edges.map(({ node }: { node: { label: string } }) => node.label) ?? [];
  const { Content, Label, Trigger } = DropdownMenu;
  const { t } = useTranslation();

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      {/* No tooltip: the label already expands inline on hover (EXPAND_LABEL_CLASS). */}
      <Trigger asChild>
        <button
          type="button"
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={t('MEMORY_ENTITY_TYPE_FILTER_TAG')}
          className={categoryButtonClass(active, active)}
        >
          <CategoryIcon icon={TagIcon} toneClass={WHAT_BAR_ICON_CLASS.tag} />
          <span className={EXPAND_LABEL_CLASS}>Tag</span>
          <ChevronDown
            className={cn(
              'ml-0 h-3.5 w-3.5 shrink-0 opacity-50 transition-transform duration-200 group-hover:ml-1 group-data-[state=open]:ml-1 group-data-[state=open]:rotate-180',
            )}
          />
        </button>
      </Trigger>

      <Content align="start" sideOffset={4} className="z-[9999] w-80 p-3">
        <Label className="mb-2 block text-sm font-medium">Tags</Label>
        <TagInput
          key={tags.join('|')}
          tags={tags}
          suggestions={suggestions}
          inputPlaceholder="Search or add a tag…"
          onTagAdded={(tag) => {
            if (tags.includes(tag)) {
              return false;
            }

            onTagsChange([...tags, tag]);

            return true;
          }}
          onTagRemoved={(tag) => {
            onTagsChange(tags.filter((value) => value !== tag));
          }}
        />
      </Content>
    </DropdownMenu>
  );
}

/** Entity-type toggles for the Memory explorer — grouped What categories. */
export function MemoryEntityTypeNav() {
  const {
    isEntityTypeSelected,
    isGroupSelected,
    isGroupActive,
    selectedEntityTypes,
    tags,
    selectOnlyEntityType,
    toggleEntityType,
    setTags,
  } = useWhatSelection();

  return (
    <nav
      aria-label="What to show in Memory"
      className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1.5 md:gap-3 md:px-3"
    >
      <div className="flex shrink-0 items-center gap-1.5 text-sm font-medium text-muted-foreground">
        <Shapes className="h-4 w-4" strokeWidth={1.5} aria-hidden />
        <span className="hidden sm:inline">What</span>
      </div>

      <div className="scrollbar-none min-w-0 flex-1 overflow-x-auto overscroll-x-contain">
        <div className="flex w-max items-center gap-1 md:gap-1.5">
          {WHAT_CATEGORIES.map((category) => {
            if (category.kind === 'standalone') {
              const types = entityTypesForCategory(category);

              return (
                <StandaloneWhatButton
                  key={category.id}
                  category={category}
                  onSelect={() => selectOnlyEntityType(category.entityType)}
                  selected={isEntityTypeSelected(category.entityType)}
                  active={isGroupActive(types)}
                />
              );
            }

            if (category.kind === 'group') {
              return (
                <GroupWhatDropdown
                  key={category.id}
                  category={category}
                  selectedEntityTypes={selectedEntityTypes}
                  isGroupSelected={isGroupSelected}
                  isGroupActive={isGroupActive}
                  onSelectOnly={selectOnlyEntityType}
                  onToggleType={toggleEntityType}
                />
              );
            }

            if (category.kind === 'events') {
              return (
                <EventsWhatDropdown
                  key={category.id}
                  category={category}
                  selected={isEntityTypeSelected(category.entityType)}
                  active={isGroupActive(entityTypesForCategory(category))}
                  onSelectOnly={() => selectOnlyEntityType(category.entityType)}
                />
              );
            }

            return <TagWhatDropdown key={category.id} tags={tags} onTagsChange={setTags} />;
          })}

          <MemoryExplorerFilterControls />
        </div>
      </div>
    </nav>
  );
}

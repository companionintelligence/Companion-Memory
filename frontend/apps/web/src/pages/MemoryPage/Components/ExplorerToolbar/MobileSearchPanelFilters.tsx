import { useState, type ComponentProps, type ReactNode, type SyntheticEvent } from 'react';

import { Badge, Button, Select, Sheet, Switch, cn } from '@ci/shadcn';
import {
  Activity,
  ArrowUpDown,
  Bookmark,
  BookmarkPlus,
  Calendar as CalendarIcon,
  ChevronRight,
  Database,
  MapPin,
  Shapes,
  SlidersHorizontal,
  Users,
  type LucideIcon,
} from '@ci/shadcn/icons';
import { useLocation, useSearchParams } from 'react-router-dom';

import { WHAT_CATEGORIES } from '@/components/MemoryHub/entityTypeCategories';
import { ActivityFilter } from '@/components/SearchBox/ActivityFilter';
import { ConnectorFilter } from '@/components/SearchBox/ConnectorFilter';
import {
  MESSAGE_DIRECTION_LABELS,
  readMessageDirection,
  type MessageDirection,
} from '@/components/SearchBox/DirectionToggle';
import { EntityTypeFilter } from '@/components/SearchBox/EntityTypeFilter';
import { EntityNameFilter } from '@/components/SearchBox/NameFilter';
import { SEARCH_PANEL_LAYER_PROPS } from '@/components/SearchBox/SearchBox';
import { AVAILABLE_ENTITY_TYPES } from '@/components/SearchBox/useDropdown';

import { DateControl, SaveSearchButton, SortControl, useFilterToggle } from './ExplorerToolbar';
import { FILTER_PARAMS, eventsInPlay, peopleInPlay } from './filterParams';
import { SavedSearchList, useOwnSavedSearchCount } from './SavedSearchPicker';
import type { FilterDimension } from './viewFilterSupport';

/*
 * The header search panel's footer on a phone. The desktop footer lays every
 * control out in a row (SearchPanelFilters); a phone panel has room for none
 * of that, so it gets two rows instead — Filters, with a count, and Saved
 * searches — each opening a bottom sheet. The sheets are built from the very
 * pickers the desktop row uses (each takes a `renderTrigger` so a sheet row can
 * open it), so every filter writes the same URL params the same way, and
 * applies the moment it changes.
 */

// The What bar's own name and order for each type ("People", "Events", …),
// which read better in a summary than the picker's singular type names.
const WHAT_LABELS = WHAT_CATEGORIES.flatMap((category) => {
  if (category.kind === 'group') {
    return category.items.map(({ entityType, label }) => ({ entityType, label }));
  }

  return category.kind === 'tag' ? [] : [{ entityType: category.entityType, label: category.label }];
});

interface Summary {
  /** The row's value, in words. */
  summary: string;
  /** How many more values there are than `summary` names ("+2"). */
  more?: number;
  /** The value narrows the search, so it reads in the primary color. */
  active: boolean;
}

/** Up to two values by name and a count of the rest ("gmail, reddit" +2), or `none` when empty. */
function listSummary(values: string[], none: string): Summary {
  if (values.length === 0) {
    return { summary: none, active: false };
  }

  return { summary: values.slice(0, 2).join(', '), more: Math.max(0, values.length - 2), active: true };
}

function whatSummary(selected: string[]): Summary {
  if (selected.length === AVAILABLE_ENTITY_TYPES.length) {
    return { summary: 'Anything', active: false };
  }

  if (selected.length === 0) {
    return { summary: 'Nothing', active: true };
  }

  const labels = WHAT_LABELS.filter(({ entityType }) => selected.includes(entityType)).map(
    ({ label }) => label,
  );

  return listSummary(labels, 'Anything');
}

/** "Sarah Smith", "From Sarah Smith", "To anyone": the Who picker's people and its From / To toggle together. */
function whoSummary(people: string[], direction: MessageDirection | null): Summary {
  const named = listSummary(people, direction == null ? 'Anyone' : 'anyone');

  if (direction == null) {
    return named;
  }

  return { ...named, summary: `${MESSAGE_DIRECTION_LABELS[direction]} ${named.summary}`, active: true };
}

// Focus the sheet itself on open, not its first field: Radix would otherwise
// focus the saved-search filter box and raise the keyboard over the list.
// Taking focus off the header input also lowers the keyboard it had up.
function focusSheet(event: Event) {
  event.preventDefault();

  if (event.currentTarget instanceof HTMLElement) {
    event.currentTarget.focus();
  }
}

// The sheets are portaled, but in React's tree they sit inside the panel
// footer, whose onMouseDown preventDefault keeps focus in the search input.
// Stop that here, or a tap could never focus a field in a sheet, a picker
// opened from one, or the save dialog.
function keepMouseDownInSheet(event: SyntheticEvent) {
  event.stopPropagation();
}

const SHEET_CLASS =
  'max-h-[min(90dvh,var(--vv-height,100dvh))] gap-0 rounded-t-2xl rounded-b-none bg-popover p-0 outline-none';

function Grabber() {
  return (
    <div
      className="mx-auto mt-2.5 mb-1 h-1.5 w-10 shrink-0 rounded-full bg-muted-foreground/30"
      aria-hidden
    />
  );
}

interface RowContentProps {
  icon: LucideIcon;
  label: string;
  /** The dimension's current value, or a count / badge on the panel rows. */
  summary?: ReactNode;
  /** Values beyond the ones `summary` names; kept visible when `summary` has to truncate. */
  more?: number;
  /** The value narrows the search, so it reads in the primary color. */
  active?: boolean;
  /** Icon color: muted in the sheet, full strength on the panel's two rows. */
  iconClassName?: string;
  /** A second line under the label, e.g. why the current view ignores it. */
  note?: string | null;
}

function RowContent({
  icon: Icon,
  label,
  summary,
  more = 0,
  active = false,
  iconClassName,
  note,
}: RowContentProps) {
  return (
    <>
      <Icon className={cn('size-5 shrink-0', iconClassName ?? 'text-muted-foreground')} strokeWidth={1.5} />
      <span className="shrink-0 text-left">
        <span className="block font-semibold">{label}</span>
        {note && <span className="block text-xs text-muted-foreground">{note}</span>}
      </span>
      <span
        className={cn(
          'ml-auto flex min-w-0 items-center gap-1 text-sm',
          active ? 'font-semibold text-primary' : 'text-muted-foreground',
        )}
      >
        <span className="truncate">{summary}</span>
        {more > 0 && <span className="shrink-0">+{more}</span>}
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </>
  );
}

const ROW_CLASS =
  'flex min-h-12 w-full items-center gap-3 px-3 text-base text-foreground outline-none hover:bg-muted/50 focus-visible:bg-muted/50';

/**
 * One tappable row: icon, label, current value, chevron. Passes its props and
 * ref on to the button, so it can be the trigger of a sheet or a picker.
 */
function FilterRow({
  icon,
  label,
  summary,
  more,
  active,
  iconClassName,
  note,
  className,
  ref,
  ...buttonProps
}: RowContentProps & Omit<ComponentProps<'button'>, 'value'>) {
  return (
    <button ref={ref} type="button" className={cn(ROW_CLASS, className)} {...buttonProps}>
      <RowContent
        icon={icon}
        label={label}
        summary={summary}
        more={more}
        active={active}
        iconClassName={iconClassName}
        note={note}
      />
    </button>
  );
}

function RowGroup({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-border overflow-hidden rounded-xl bg-card">{children}</div>;
}

/** Located-only / semantic as a switch, the whole row its label. */
function SwitchRow({
  param,
  dimension,
  label,
}: {
  param: string;
  dimension: FilterDimension;
  label: string;
}) {
  const { active, reason, toggle } = useFilterToggle(param, dimension);
  const id = `search-panel-${param}`;

  return (
    <label htmlFor={id} className="flex min-h-12 items-center gap-3 px-3 text-base">
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{label}</span>
        {reason && (
          <span className="block text-xs text-muted-foreground">Not applied in this view. {reason}</span>
        )}
      </span>
      {/* The stock unchecked track (input at 80%) is the card's own color in
          dark mode, which leaves a lone thumb; lift it so "off" reads as a switch. */}
      <Switch
        id={id}
        checked={active}
        onCheckedChange={toggle}
        className="dark:data-[state=unchecked]:bg-foreground/15"
      />
    </label>
  );
}

function FiltersSheet({ filterCount, onClearFilters }: { filterCount: number; onClearFilters: () => void }) {
  const [open, setOpen] = useState(false);
  // The What picker is a DropdownMenu, and Radix's menu brings its own copy of
  // the layer stack (react-menu pins dismissable-layer 1.1.11, Dialog 1.1.10),
  // so the sheet can't tell the menu is open on top of it: the Escape or scrim
  // tap meant for the menu would close the sheet too — and an Escape the sheet
  // declines is spent, so the menu wouldn't close either. The sheet holds the
  // menu's open state and closes the menu itself.
  const [whatOpen, setWhatOpen] = useState(false);
  const [searchParams] = useSearchParams();
  const { pathname } = useLocation();
  // Same conditions the desktop row applies: Activity and Where narrow events
  // only, Who events and messages, so each is offered while its kind is in play.
  const showEventDimensions = eventsInPlay(searchParams, pathname);
  const showWho = peopleInPlay(searchParams, pathname);
  const direction = readMessageDirection(searchParams.get('direction'));
  // Sort isn't counted as a filter, but Clear all resets it with the rest.
  const anythingToClear = FILTER_PARAMS.some((param) => searchParams.has(param));

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Sheet.Trigger asChild>
        <FilterRow
          icon={SlidersHorizontal}
          label="Filters"
          iconClassName="text-foreground"
          className="px-4"
          summary={
            filterCount > 0 ? (
              <Badge className="min-w-5 rounded-full px-1.5 font-bold tabular-nums">{filterCount}</Badge>
            ) : null
          }
        />
      </Sheet.Trigger>
      <Sheet.Content
        side="bottom"
        showCloseButton={false}
        className={SHEET_CLASS}
        onOpenAutoFocus={focusSheet}
        onMouseDown={keepMouseDownInSheet}
        onEscapeKeyDown={(event) => {
          if (whatOpen) {
            event.preventDefault();
            setWhatOpen(false);
          }
        }}
        // A tap outside while the What menu is open is the menu's: it closes
        // itself, and the sheet stays.
        onPointerDownOutside={(event) => {
          if (whatOpen) {
            event.preventDefault();
          }
        }}
        {...SEARCH_PANEL_LAYER_PROPS}
      >
        <Grabber />
        <div className="flex min-h-12 shrink-0 items-center gap-2 px-4">
          <Sheet.Title className="text-base font-bold">Filters</Sheet.Title>
          <Sheet.Description className="sr-only">
            Narrow what the search looks through. Changes apply as you make them.
          </Sheet.Description>
          {anythingToClear && (
            <Button
              type="button"
              variant="ghost"
              className="-mr-2 ml-auto h-11 px-2 font-semibold text-primary hover:text-primary"
              onClick={onClearFilters}
            >
              Clear all
            </Button>
          )}
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-3 pb-3">
          {/* Modal pickers: inside a modal sheet, only a picker with its own
              scroll lock can scroll its list on a touch screen, and the What
              menu (the other Radix layer copy, above) only takes taps at all
              when it is modal, since the sheet turns pointer events off
              outside itself. */}
          <RowGroup>
            <EntityTypeFilter
              modal
              open={whatOpen}
              onOpenChange={setWhatOpen}
              renderTrigger={(selected) => (
                <FilterRow icon={Shapes} label="What" {...whatSummary(selected)} />
              )}
            />
            <DateControl
              modal
              renderTrigger={(value) => (
                <FilterRow
                  icon={CalendarIcon}
                  label="When"
                  summary={value ?? 'Any time'}
                  active={value != null}
                />
              )}
            />
            <ConnectorFilter
              modal
              renderTrigger={(values) => (
                <FilterRow icon={Database} label="How" {...listSummary(values, 'All sources')} />
              )}
            />
            {showEventDimensions && (
              <ActivityFilter
                modal
                renderTrigger={(values) => (
                  <FilterRow icon={Activity} label="Activity" {...listSummary(values, 'All activity')} />
                )}
              />
            )}
            {showWho && (
              <EntityNameFilter
                kind="person"
                modal
                renderTrigger={(values) => (
                  <FilterRow icon={Users} label="Who" {...whoSummary(values, direction)} />
                )}
              />
            )}
            {showEventDimensions && (
              <EntityNameFilter
                kind="place"
                modal
                renderTrigger={(values) => (
                  <FilterRow icon={MapPin} label="Where" {...listSummary(values, 'Anywhere')} />
                )}
              />
            )}
          </RowGroup>

          <div>
            <RowGroup>
              <SwitchRow param="hasLocation" dimension="hasLocation" label="Only items with a place" />
              <SwitchRow param="semantic" dimension="semantic" label="Match by meaning" />
            </RowGroup>
            <p className="px-1 pt-2 text-xs text-muted-foreground">
              Finds related memories even when they use different words.
            </p>
          </div>

          <RowGroup>
            <SortControl
              renderTrigger={({ label, active, reason }) => (
                <Select.Trigger
                  // A row, not a field: the trigger's own box, height and
                  // chevron-down (its last child) give way to the row's.
                  className={cn(
                    ROW_CLASS,
                    'h-auto justify-start rounded-none border-0 bg-transparent py-0 shadow-none whitespace-normal data-[size=default]:h-auto dark:bg-transparent dark:hover:bg-muted/50 [&>svg:last-child]:hidden',
                  )}
                >
                  <RowContent
                    icon={ArrowUpDown}
                    label="Sort"
                    summary={label}
                    active={active}
                    note={reason ? 'Not applied in this view' : null}
                  />
                </Select.Trigger>
              )}
            />
          </RowGroup>
        </div>

        <div className="flex shrink-0 gap-2.5 border-t px-4 pt-3 pb-[max(1rem,var(--safe-area-bottom))]">
          <SaveSearchButton
            trigger={
              <Button type="button" variant="outline" className="h-11 flex-1">
                <BookmarkPlus className="size-4" />
                Save search
              </Button>
            }
          />
          <Sheet.Close asChild>
            <Button type="button" className="h-11 flex-1">
              Done
            </Button>
          </Sheet.Close>
        </div>
      </Sheet.Content>
    </Sheet>
  );
}

function SavedSearchesSheet({ onOpenSavedSearch }: { onOpenSavedSearch: (params: URLSearchParams) => void }) {
  const [open, setOpen] = useState(false);
  const [filterText, setFilterText] = useState('');
  const count = useOwnSavedSearchCount();

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Sheet.Trigger asChild>
        <FilterRow
          icon={Bookmark}
          label="Saved searches"
          iconClassName="text-foreground"
          className="px-4"
          summary={count ? count : null}
        />
      </Sheet.Trigger>
      <Sheet.Content
        side="bottom"
        showCloseButton={false}
        className={SHEET_CLASS}
        onOpenAutoFocus={focusSheet}
        onMouseDown={keepMouseDownInSheet}
        {...SEARCH_PANEL_LAYER_PROPS}
      >
        <Grabber />
        <div className="flex min-h-12 shrink-0 items-center gap-2 px-4">
          <Sheet.Title className="text-base font-bold">Saved searches</Sheet.Title>
          <Sheet.Description className="sr-only">Load one of your saved searches.</Sheet.Description>
          <Sheet.Close asChild>
            <Button type="button" variant="ghost" className="-mr-2 ml-auto h-11 px-2 font-semibold">
              Done
            </Button>
          </Sheet.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-[max(0.5rem,var(--safe-area-bottom),var(--keyboard-inset,0px))]">
          <SavedSearchList
            touch
            onOpen={onOpenSavedSearch}
            autoFocus={false}
            filterText={filterText}
            onFilterTextChange={setFilterText}
            onClose={() => setOpen(false)}
          />
        </div>
      </Sheet.Content>
    </Sheet>
  );
}

/**
 * The phone footer of the header search panel: a Filters row (with the
 * active-filter count) and, while nothing is typed, a Saved searches row.
 * Each opens a bottom sheet; see the note at the top of this file.
 */
export function MobileSearchPanelFilters({
  filterCount,
  showSavedSearches,
  onClearFilters,
  onOpenSavedSearch,
}: {
  /** Active filters, as the header counts them (countActiveFilters). */
  filterCount: number;
  /** Off while a query is typed: the panel then shows its suggestions and the Filters row alone. */
  showSavedSearches: boolean;
  /** Clears the explorer filter set; the typed query stays. */
  onClearFilters: () => void;
  /** Opens a picked saved search (its params); the header does the navigating. */
  onOpenSavedSearch: (params: URLSearchParams) => void;
}) {
  return (
    <div className="divide-y divide-border">
      <FiltersSheet filterCount={filterCount} onClearFilters={onClearFilters} />
      {showSavedSearches && <SavedSearchesSheet onOpenSavedSearch={onOpenSavedSearch} />}
    </div>
  );
}

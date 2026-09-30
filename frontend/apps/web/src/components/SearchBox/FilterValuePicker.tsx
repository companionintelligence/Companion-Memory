import { useState, type ComponentType, type ReactElement, type ReactNode } from 'react';

import { Badge, Button, Input, Label, Popover, Tooltip, cn } from '@ci/shadcn';
import { AlertTriangle, Check, ChevronDown, Plus, X } from '@ci/shadcn/icons';

import { filterValueKey } from '@/pages/MemoryPage/Components/ExplorerToolbar/filterParams';

/**
 * One picker for the explorer's list-valued dimensions (Who / Where / How /
 * Activity), so the memory toolbar and the saved-search editor offer the same
 * choices the same way. Presentational: the caller owns the selected values,
 * the option list and (for name dimensions) the server-side search.
 *
 * Two vocabularies, decided by `optionsKnown`:
 * - **known** (How, Activity): `options` is the complete set the backend can
 *   match — source systems, event types. Free text is refused, and a selected
 *   value outside the set is flagged, since an exact `IN (...)` filter on a
 *   name that no longer exists returns nothing at all.
 * - **open** (Who, Where): `options` are suggestions for the typed text — the
 *   backend matches these as case-insensitive *contains* patterns — so any
 *   text can be committed as a pattern, and nothing is flagged.
 */
export interface FilterValuePickerProps {
  /** Dimension name: the trigger reads "{label}: all" / "{label}: 2 selected". */
  label: string;
  icon?: ComponentType<{ className?: string }>;
  values: string[];
  /** Commit one value; return an error message to show, or null on success. */
  onAdd: (value: string) => string | null;
  onRemove: (value: string) => void;
  onClear: () => void;
  /** The candidates to list (the whole vocabulary, or the suggestions for `onSearch`'s query). */
  options: string[];
  /** `options` is the complete vocabulary: no free text, flag values outside it. */
  optionsKnown?: boolean;
  /** Fired as the search box changes; when set, `options` are trusted as already filtered. */
  onSearch?: (query: string) => void;
  onOpenChange?: (open: boolean) => void;
  loading?: boolean;
  searchPlaceholder: string;
  /** Shown when nothing is listed. */
  emptyText: string;
  /** Tooltip for a flagged value (known vocabulary only). */
  unknownValueHint?: string;
  /** Extra controls under the list, e.g. the Who picker's From / To toggle. */
  footer?: ReactNode;
  /** Small print under the list, e.g. the drag-and-drop alternative. */
  hint?: ReactNode;
  modal?: boolean;
  /**
   * `toolbar`: a "{label}: value" trigger; the selections chip elsewhere (the
   * explorer's filter drop area). `field`: a labelled form field with its own
   * chip list and an "Add…" trigger, for the saved-search editor.
   */
  variant: 'toolbar' | 'field';
  /**
   * The caller's own trigger in place of the variant's, given the selected
   * values — the phone filter sheet opens this same picker from a row. It
   * becomes the popover trigger, so it must pass its props and ref on to a
   * button.
   */
  renderTrigger?: (values: string[]) => ReactElement;
}

function includesValue(values: string[], value: string): boolean {
  const key = filterValueKey(value);

  return values.some((candidate) => filterValueKey(candidate) === key);
}

export function FilterValuePicker({
  label,
  icon: Icon,
  values,
  onAdd,
  onRemove,
  onClear,
  options,
  optionsKnown = false,
  onSearch,
  onOpenChange,
  loading = false,
  searchPlaceholder,
  emptyText,
  unknownValueHint,
  footer,
  hint,
  modal = true,
  variant,
  renderTrigger,
}: FilterValuePickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  const trimmed = query.trim();
  const matchesQuery = (value: string) =>
    trimmed.length === 0 || filterValueKey(value).includes(filterValueKey(trimmed));

  // Selected values lead the list (so a free-text pattern can be unticked
  // even though no option spells it), then the options not yet selected. A
  // server-searched list is already narrowed; a full vocabulary is narrowed
  // here by the typed text.
  const selected = values.filter((value) => matchesQuery(value));
  const rest = options.filter(
    (option) => !includesValue(values, option) && (onSearch || matchesQuery(option)),
  );

  const listed = [...selected, ...rest];

  const canCommitFreeText = !optionsKnown && trimmed.length > 0 && !includesValue(listed, trimmed);

  const changeOpen = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);

    if (!next) {
      setError(null);
    }
  };

  const changeQuery = (next: string) => {
    setQuery(next);
    setError(null);
    onSearch?.(next);
  };

  const commit = (value: string) => {
    const problem = onAdd(value);

    setError(problem);

    if (!problem) {
      changeQuery('');
    }
  };

  const toggle = (value: string) => {
    if (includesValue(values, value)) {
      onRemove(value);
      setError(null);
    } else {
      commit(value);
    }
  };

  const isUnknown = (value: string) => optionsKnown && !includesValue(options, value);

  const triggerText = () => {
    if (values.length === 0) {
      return `${label}: all`;
    }

    if (values.length === 1) {
      return `${label}: ${values[0]}`;
    }

    return `${label}: ${values.length} selected`;
  };

  const panel = (
    <div className="space-y-2 p-2">
      <div className="flex items-center justify-between gap-3 px-1">
        <span className="text-sm font-medium">{label}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            onClear();
            setError(null);
          }}
          disabled={values.length === 0}
          className="h-7 px-2 text-xs text-muted-foreground"
        >
          Clear
        </Button>
      </div>
      <Input
        value={query}
        placeholder={searchPlaceholder}
        aria-label={searchPlaceholder}
        onChange={(event) => changeQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();

            if (canCommitFreeText) {
              commit(trimmed);
            } else if (listed.length === 1) {
              toggle(listed[0]);
            }
          }
        }}
      />
      {error && (
        <p role="alert" className="px-1 text-xs text-destructive">
          {error}
        </p>
      )}
      <ul
        role="listbox"
        aria-label={`${label} options`}
        aria-multiselectable
        className="max-h-60 overflow-y-auto"
      >
        {listed.map((value) => {
          const selected = includesValue(values, value);

          return (
            <li key={value}>
              <button
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => toggle(value)}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent',
                  selected && 'font-medium',
                )}
              >
                <Check className={cn('h-4 w-4 shrink-0', selected ? 'opacity-100' : 'opacity-0')} />
                <span className="truncate">{value}</span>
                {isUnknown(value) && unknownValueHint && (
                  <AlertTriangle className="ml-auto h-3.5 w-3.5 shrink-0 text-warning-foreground" />
                )}
              </button>
            </li>
          );
        })}
        {canCommitFreeText && (
          <li>
            <button
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => commit(trimmed)}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
            >
              <Plus className="h-4 w-4 shrink-0" />
              <span className="truncate">Match names containing “{trimmed}”</span>
            </button>
          </li>
        )}
        {listed.length === 0 && !canCommitFreeText && (
          <li className="px-2 py-1.5 text-xs text-muted-foreground">{loading ? 'Searching…' : emptyText}</li>
        )}
      </ul>
      {footer && <div className="border-t border-border pt-2">{footer}</div>}
      {hint && <p className="border-t border-border px-1 pt-2 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );

  const popover = (trigger: ReactNode) => (
    <Popover open={open} onOpenChange={changeOpen} modal={modal}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Content
        align="start"
        sideOffset={4}
        className={cn(
          'w-72 p-0',
          // Opened from a row in the phone filter sheet, there can be less room
          // above or below it than the panel needs once its list fills: stay
          // on screen and scroll, as the menus and selects already do.
          renderTrigger && 'max-h-(--radix-popover-content-available-height) overflow-y-auto',
        )}
      >
        {panel}
      </Popover.Content>
    </Popover>
  );

  if (renderTrigger) {
    return popover(renderTrigger(values));
  }

  if (variant === 'toolbar') {
    return popover(
      <Button type="button" variant="outline">
        {Icon && <Icon className="mr-2 h-4 w-4 text-muted-foreground" />}
        {triggerText()}
        <ChevronDown className={cn('ml-2 h-4 w-4 opacity-50 transition-transform', open && 'rotate-180')} />
      </Button>,
    );
  }

  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {values.map((value) => {
            const unknown = isUnknown(value);
            const chip = (
              <Badge
                key={value}
                variant={unknown ? 'outline' : 'secondary'}
                className={cn('max-w-[220px] gap-1', unknown && 'border-warning text-warning-foreground')}
              >
                {unknown && <AlertTriangle className="h-3 w-3 shrink-0" />}
                <span className="truncate">{value}</span>
                <button
                  type="button"
                  onClick={() => onRemove(value)}
                  aria-label={`Remove ${value}`}
                  className="hover:bg-background/60 -mr-1 rounded p-0.5"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            );

            if (!unknown || !unknownValueHint) {
              return chip;
            }

            return (
              <Tooltip key={value} delayDuration={300}>
                <Tooltip.Content>{unknownValueHint}</Tooltip.Content>
                <Tooltip.Trigger asChild>{chip}</Tooltip.Trigger>
              </Tooltip>
            );
          })}
        </div>
      )}
      {popover(
        <Button type="button" variant="outline" size="sm">
          <Plus className="mr-1.5 h-4 w-4" />
          Add {label.toLocaleLowerCase()}
          <ChevronDown
            className={cn('ml-1.5 h-4 w-4 opacity-50 transition-transform', open && 'rotate-180')}
          />
        </Button>,
      )}
    </div>
  );
}

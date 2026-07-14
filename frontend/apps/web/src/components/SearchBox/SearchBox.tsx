import {
  type ForwardedRef,
  type ReactNode,
  type RefObject,
  forwardRef,
  useCallback,
  useEffect,
  useState,
  useRef,
} from 'react';

import { ENTITY_TYPE_MAP } from '@ci/common/src/constants';
import {
  Button,
  ScrollArea,
  ScrollBar,
  Input,
  Form,
  Spinner,
  useForm,
  formDataResolver,
  formDataSchema as s,
  cn,
} from '@ci/shadcn';
import { ArrowDown, Search, X } from '@ci/shadcn/icons';

import { DropdownContent } from './DropdownContent';
import type { FilterDragPayload } from './filterDrag';
import { DropdownProvider, useDropdown } from './useDropdown';

const FormSchema = s.object({
  query: s.string(),
});

export type FormData = s.infer<typeof FormSchema>;

const EMPTY: FormData = {
  query: '',
};

// Key constants
const Keys = {
  ESCAPE: 'Escape',
  ENTER: 'Enter',
  ARROW_UP: 'ArrowUp',
  ARROW_DOWN: 'ArrowDown',
  ARROW_LEFT: 'ArrowLeft',
  ARROW_RIGHT: 'ArrowRight',
} as const;

interface SearchResultItem {
  id: string;
  content: React.ReactNode;
  preview?: React.ReactNode;
  /**
   * The filter this row can apply, for rows that double as filter sources
   * (person / place / tag). Same payload the row's drag carries — the arrow
   * keys are the keyboard analogue of dragging it onto the filter drop area.
   */
  filter?: FilterDragPayload;
}

interface Props {
  variant?: 'default' | 'compact';
  disabled?: boolean;
  loading?: boolean;
  error?: unknown;
  placeholder?: string;
  /**
   * External query to reflect in the input (e.g. the `?search=` URL param when
   * the box lives in the global header). Synced in while the box isn't focused
   * so it never fights the user's typing.
   */
  defaultQuery?: string;
  results?: SearchResultItem[];
  autoSubmit?: boolean;
  autoSubmitDelay?: number;
  /**
   * By default auto-submit fires only for non-empty queries. Set this when the
   * caller needs to react to the input being cleared by typing/backspace too
   * (e.g. the header search clearing the `?search` URL param on /memory).
   */
  autoSubmitEmpty?: boolean;
  displayResults?: boolean;
  displayDropdown?: boolean;
  /**
   * Keep the results dropdown open while the input is focused even when it's
   * empty — used to surface recent searches / suggestions before the user types.
   */
  openOnFocus?: boolean;
  saveSupported?: boolean;
  /**
   * Passive status content rendered inset just before the clear button (e.g.
   * the header slots Memory's active-filter count here).
   */
  statusSlot?: ReactNode;
  /**
   * Show the clear button even when the input is empty — for callers whose
   * onClear resets more than the query (e.g. active explorer filters).
   */
  showClear?: boolean;
  /**
   * Extra controls rendered inset at the right edge of the input, after the
   * clear button (e.g. the header slots Memory's advanced-filter toggle here).
   */
  toolsSlot?: ReactNode;
  /**
   * Caller-supplied section rendered at the top of the dropdown panel, above the
   * results (e.g. Memory's advanced filters). Shown whenever the panel is open.
   */
  panelHeader?: ReactNode;
  /**
   * Hold the dropdown panel open regardless of focus/query — used with
   * `panelHeader` so its content stays interactive (it survives input blur).
   */
  panelPinned?: boolean;
  /**
   * Escape pressed while the panel is pinned — the first stage of the Escape
   * stack, ahead of highlight-clear / dismiss / clear. The pin's owner decides
   * what closing it means; without this, Escape on a pinned panel falls
   * through the rest of the stack.
   */
  onPanelUnpin?: () => void;
  onSearch?: (data: FormData & { entityDropdowns?: string[] }) => boolean | void | Promise<boolean | void>;
  /**
   * Explicit submit (Enter with no result highlighted). Falls back to `onSearch`
   * when omitted, so existing callers keep their submit behavior.
   */
  onSubmit?: (data: FormData) => void;
  onKeyDown?: (query: string, e: React.KeyboardEvent<HTMLInputElement>) => void;
  onClear?: () => void;
  onResultSelect?: (result: SearchResultItem) => void;
  /**
   * Right arrow on a highlighted result carrying a `filter` payload applies it —
   * but only with the caret already at the end of the input, so mid-text caret
   * movement stays native. Rows without a payload — and boxes without this
   * callback — keep the arrow's native behavior everywhere.
   */
  onFilterAdd?: (filter: FilterDragPayload) => void;
  onSave?: (query: string, entityTypes: string[]) => void;
}

function SearchBox(
  {
    variant = 'default',
    disabled = false,
    placeholder,
    loading = false,
    error,
    results = [],
    autoSubmit = false,
    autoSubmitDelay = 300,
    autoSubmitEmpty = false,
    displayResults = false,
    displayDropdown = false,
    openOnFocus = false,
    saveSupported = true,
    statusSlot,
    showClear = false,
    toolsSlot,
    panelHeader,
    panelPinned = false,
    onPanelUnpin,
    defaultQuery,
    onSearch,
    onSubmit,
    onKeyDown,
    onClear,
    onResultSelect,
    onFilterAdd,
    onSave,
  }: Props,
  forwardedRef: ForwardedRef<HTMLInputElement>,
) {
  const form = useForm<FormData>({
    resolver: formDataResolver(FormSchema),
    defaultValues: defaultQuery != null ? { query: defaultQuery } : EMPTY,
  });

  const isFocusedRef = useRef(false);
  const [isFocused, setIsFocused] = useState(false);
  // Escape closes the results panel before it clears the query (two-stage);
  // typing or refocusing reopens it.
  const [panelDismissed, setPanelDismissed] = useState(false);

  // Reflect external query changes (e.g. URL `?search=` or saved-search restore)
  // into the input, but only while it isn't focused so it never clobbers typing.
  useEffect(() => {
    if (defaultQuery === undefined || isFocusedRef.current) {
      return;
    }

    if (defaultQuery !== form.getValues('query')) {
      form.reset({ query: defaultQuery });
    }
  }, [defaultQuery, form]);

  const [{ isDropdownPanelVisible }, { toggleDropdownPanel }] = useDropdown();

  const queryValue = form.watch('query');
  const [selectedIndex, setSelectedIndex] = useState<number>(-1);
  const [isAutoSubmitPending, setIsAutoSubmitPending] = useState<boolean>(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const resultItemsRef = useRef<(HTMLDivElement | null)[]>([]);
  const debounceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last value the auto-submit actually fired for; guards the effect against
  // re-running on dependency identity churn rather than real query changes.
  const lastAutoSubmittedRef = useRef<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  // Previous results list, for re-anchoring the highlight by id when it changes.
  const prevResultsRef = useRef<SearchResultItem[]>(results);

  const selectedResult = selectedIndex >= 0 && selectedIndex < results.length ? results[selectedIndex] : null;
  const isLoading = loading || isAutoSubmitPending;

  const scrollToSelectedItem = useCallback(() => {
    if (selectedIndex === -1 || !scrollAreaRef.current) {
      return;
    }

    const selectedElement = resultItemsRef.current[selectedIndex];
    const scrollContainer = scrollAreaRef.current.querySelector('[data-radix-scroll-area-viewport]');

    if (!selectedElement || !scrollContainer) {
      return;
    }

    const containerRect = scrollContainer.getBoundingClientRect();
    const itemRect = selectedElement.getBoundingClientRect();
    const isItemVisible = itemRect.top >= containerRect.top && itemRect.bottom <= containerRect.bottom;

    if (!isItemVisible) {
      const containerHeight = containerRect.height;
      const itemHeight = itemRect.height;
      const scrollTop = selectedElement.offsetTop - (containerHeight - itemHeight) / 2;

      scrollContainer.scrollTo({
        top: Math.max(0, scrollTop),
        behavior: 'instant',
      });
    }
  }, [selectedIndex]);

  const handleSubmit = useCallback(
    async (data: FormData) => {
      if (!disabled) {
        const success = await onSearch?.(data);

        if (success === true) {
          form.reset();
          setSelectedIndex(-1);
          // Allow the same value to auto-submit again after the reset.
          lastAutoSubmittedRef.current = null;
        }
      }
    },
    [form, onSearch, disabled],
  );

  // Form submit (Enter with no result highlighted). Prefer the explicit `onSubmit`
  // callback; fall back to the live `onSearch` so callers that only pass the latter
  // keep their existing behavior.
  const handleFormSubmit = useCallback(
    async (data: FormData) => {
      if (disabled) {
        return;
      }

      if (onSubmit) {
        onSubmit(data);

        return;
      }

      await handleSubmit(data);
    },
    [disabled, onSubmit, handleSubmit],
  );

  const handleClear = useCallback(() => {
    if (!disabled) {
      // Reset to empty explicitly: bare reset() restores the mount-time
      // defaultValues, which may be a non-empty seeded `defaultQuery`.
      form.reset(EMPTY);
      setSelectedIndex(-1);
      // Allow the same value to auto-submit again after the clear.
      lastAutoSubmittedRef.current = null;

      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
        debounceTimeoutRef.current = null;
      }

      onClear?.();

      setIsAutoSubmitPending(false);
    }
  }, [form, onClear, disabled]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (disabled) {
        return;
      }

      switch (e.key) {
        case Keys.ESCAPE: {
          e.preventDefault();
          e.stopPropagation();

          const panelShowing =
            displayResults &&
            !panelDismissed &&
            (openOnFocus ? isFocusedRef.current : queryValue.length > 0) &&
            results.length > 0;

          // A pinned panel closes first — before the highlight or the results
          // panel — so its owner's escape stack (e.g. close advanced filters,
          // then collapse the bar) reads top-down.
          if (panelPinned && onPanelUnpin) {
            onPanelUnpin();
          } else if (selectedIndex !== -1) {
            setSelectedIndex(-1);
          } else if (panelShowing) {
            setPanelDismissed(true);
          } else {
            handleClear();
          }

          break;
        }

        case Keys.ARROW_UP:
          if (results.length > 0) {
            e.preventDefault();
            e.stopPropagation();

            setSelectedIndex((prev) =>
              prev === -1 ? results.length - 1 : (prev - 1 + results.length) % results.length,
            );
          }

          break;

        case Keys.ARROW_DOWN:
          if (results.length > 0) {
            e.preventDefault();
            e.stopPropagation();

            setSelectedIndex((prev) => (prev === -1 ? 0 : (prev + 1) % results.length));
          }

          break;

        case Keys.ENTER:
          if (selectedIndex >= 0 && selectedIndex < results.length) {
            e.preventDefault();
            e.stopPropagation();

            onResultSelect?.(results[selectedIndex]);
          }

          break;

        // The keyboard analogue of dragging a filter-source row onto the drop
        // area: right adds the highlighted row's filter. Only hijacked when a
        // filter payload is there to act on AND the caret already sits at the
        // end of the input — anywhere earlier (or with a selection) the arrow
        // keeps moving the caret.
        case Keys.ARROW_RIGHT: {
          const input = e.target as HTMLInputElement;
          const caretAtEnd =
            input.selectionStart === input.value.length && input.selectionEnd === input.value.length;

          if (onFilterAdd && selectedResult?.filter && caretAtEnd) {
            e.preventDefault();
            e.stopPropagation();

            onFilterAdd(selectedResult.filter);
          }

          break;
        }

        default:
          if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete') {
            setSelectedIndex(-1);
            setPanelDismissed(false);
          }

          break;
      }

      // Use timeout to get the updated value after the key press
      setTimeout(() => {
        onKeyDown?.((e.target as HTMLInputElement).value, e);
      }, 0);
    },
    [
      disabled,
      form,
      results,
      selectedIndex,
      displayResults,
      panelDismissed,
      openOnFocus,
      queryValue,
      panelPinned,
      onPanelUnpin,
      onResultSelect,
      selectedResult,
      onFilterAdd,
      handleClear,
      onKeyDown,
    ],
  );

  const handleSaveSearch = useCallback(
    async (entityTypes: string[]) => {
      await onSave?.(
        queryValue,
        entityTypes.map((type) => ENTITY_TYPE_MAP[type as keyof typeof ENTITY_TYPE_MAP]),
      );
    },
    [onSave, queryValue],
  );

  // Auto-submit with debounce. By default empty queries are skipped; with
  // autoSubmitEmpty the caller is also notified when the input clears.
  useEffect(() => {
    if (!autoSubmit || disabled || (!queryValue.trim() && !autoSubmitEmpty)) {
      setIsAutoSubmitPending(false);

      return;
    }

    // The effect also re-runs when callback identities churn (e.g. the caller's
    // onSearch closes over router state and any URL write remints it). Only an
    // actual query change warrants a new debounce cycle — otherwise the spinner
    // flashes and the same value is resubmitted.
    if (queryValue === lastAutoSubmittedRef.current) {
      return;
    }

    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }

    setIsAutoSubmitPending(true);

    debounceTimeoutRef.current = setTimeout(async () => {
      lastAutoSubmittedRef.current = queryValue;
      await handleSubmit({ query: queryValue });
      setIsAutoSubmitPending(false);
    }, autoSubmitDelay);

    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
        debounceTimeoutRef.current = null;
      }

      setIsAutoSubmitPending(false);
    };
  }, [queryValue, autoSubmit, autoSubmitEmpty, autoSubmitDelay, disabled, handleSubmit]);

  // Results changed: keep the highlight on the same row — matched by id, since
  // its index may have shifted and its content re-rendered (e.g. an action row
  // whose label just toggled after Enter) — and drop it when the row is gone.
  useEffect(() => {
    const prevResults = prevResultsRef.current;
    prevResultsRef.current = results;
    resultItemsRef.current = [];
    setIsAutoSubmitPending(false);

    setSelectedIndex((prev) => {
      const prevId = prev >= 0 && prev < prevResults.length ? prevResults[prev].id : null;

      return prevId === null ? -1 : results.findIndex((result) => result.id === prevId);
    });
  }, [results]);

  // Reset selection when query is cleared
  useEffect(() => {
    if (!queryValue) {
      setSelectedIndex(-1);
    }
  }, [queryValue]);

  // Scroll to selected item when selection changes
  useEffect(() => {
    if (selectedIndex !== -1) {
      const frameId = requestAnimationFrame(scrollToSelectedItem);

      return () => cancelAnimationFrame(frameId);
    }
  }, [selectedIndex, scrollToSelectedItem]);

  // Close filters panel on outside click
  useEffect(() => {
    if (!isDropdownPanelVisible) {
      return;
    }

    const handlePointerDown = (e: PointerEvent) => {
      if (!wrapperRef.current) {
        return;
      }

      const target = e.target as Node;

      // Filter dropdowns portal to document.body (outside wrapperRef), so treat
      // clicks within them as inside-panel clicks rather than closing the panel.
      const portaledFilterIds = ['entity-type-filters', 'how-filters'];

      if (
        portaledFilterIds.some((id) => {
          const el = document.getElementById(id);

          return el != null && el.contains(target);
        })
      ) {
        return;
      }

      // Date-range, tag, and sort controls open Radix poppers in a portal outside this wrapper;
      // clicks inside them must not close the filter panel.
      if (target instanceof Element && target.closest('[data-radix-popper-content-wrapper]')) {
        return;
      }

      if (wrapperRef.current.contains(target)) {
        return;
      }

      toggleDropdownPanel();
    };

    document.addEventListener('pointerdown', handlePointerDown);

    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [isDropdownPanelVisible, toggleDropdownPanel]);

  const hasQuery = queryValue.length > 0;
  // Default: show the dropdown whenever there's a query. With `openOnFocus`, gate
  // it on focus instead — so it can surface recent searches before the user types
  // and won't auto-open just because the input reflects an external `?search` value.
  // While the panel is pinned, a live query keeps its results visible even
  // unfocused — interacting with panelHeader content (filter dropdowns steal
  // focus) must not blank the suggestions below it.
  const resultsPanelOpen =
    displayResults &&
    !disabled &&
    !panelDismissed &&
    (openOnFocus ? isFocused || (panelPinned && hasQuery) : hasQuery);

  let resultsNode: ReactNode | null = null;

  if (displayDropdown && isDropdownPanelVisible) {
    resultsNode = <DropdownContent onSave={handleSaveSearch} saveSupported={saveSupported} />;
  } else if (resultsPanelOpen) {
    let body: ReactNode | null = null;

    if (hasQuery && isLoading) {
      body = (
        <div className="flex items-center justify-center p-8">
          <Spinner size={32} variant="circle" color="rgb(6,108,128)" />
        </div>
      );
    } else if (hasQuery && error) {
      body = (
        <div className="flex flex-col items-center justify-center p-8">
          <p className="text-muted-foreground font-medium">Something went wrong.</p>
          <p className="text-sm text-muted-foreground">Please try your search again.</p>
        </div>
      );
    } else if (results.length > 0) {
      body = (
        <div className="flex max-h-[60vh]">
          {selectedResult && selectedResult.preview && (
            <div className="flex-1 p-4 overflow-hidden">{selectedResult.preview}</div>
          )}
          <ScrollArea className="flex-1/2" ref={scrollAreaRef}>
            <div className="py-1">
              {results.map((result, index) => (
                <div
                  key={result.id}
                  ref={(el) => {
                    resultItemsRef.current[index] = el;
                  }}
                  className={`
                        px-2 py-1.5 cursor-pointer border-l-4
                        ${index === selectedIndex ? 'bg-accent text-accent-foreground border-blue-500' : 'hover:bg-muted/50 border-transparent'}
                      `}
                  // Keep the input focused so the focus-driven panel doesn't close
                  // before the click lands — except on draggable rows while the
                  // panel is pinned: preventing mousedown default cancels native
                  // HTML5 drag, and a pinned panel stays visible unfocused anyway.
                  onMouseDown={(e) => {
                    if (
                      panelPinned &&
                      e.target instanceof Element &&
                      e.target.closest('[draggable="true"]')
                    ) {
                      return;
                    }

                    e.preventDefault();
                  }}
                  onClick={() => onResultSelect?.(result)}
                >
                  {result.content}
                </div>
              ))}
            </div>
            <ScrollBar />
          </ScrollArea>
        </div>
      );
    } else if (hasQuery) {
      body = (
        <div className="flex flex-col items-center justify-center p-8">
          <p className="text-muted-foreground font-medium">No results found.</p>
          <p className="text-sm text-muted-foreground">Try a different search.</p>
        </div>
      );
    }

    resultsNode = body;
  }

  const panelVisible = resultsNode != null || panelPinned;

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleFormSubmit)}>
        <div className="relative" ref={wrapperRef}>
          <div
            className={cn(
              'w-full flex flex-col',
              'placeholder:text-muted-foreground/60',
              'outline-none border shadow-xs rounded-md bg-background text-base',
              'aria-[invalid=true]:ring-destructive/20 dark:aria-[invalid=true]:ring-destructive/40 aria-[invalid=true]:border-destructive',
              'transition-[color,box-shadow]',
              disabled ? 'cursor-not-allowed opacity-50 pointer-events-none' : '',
              panelVisible ? 'rounded-b-none' : '',
              // Right inset matches the 3px of vertical slack around the h-7 controls.
              variant === 'compact' ? 'pr-[3px]' : '',
            )}
          >
            <div className={cn('flex items-center justify-center', variant === 'compact' ? '' : 'pl-3')}>
              {variant === 'compact' && (
                <div className={cn('pl-3 pr-2', disabled && 'text-muted-foreground')}>
                  <Search className="h-4 w-4" strokeWidth={1.75} />
                </div>
              )}

              <Form.Field
                control={form.control}
                name="query"
                render={({ field }) => (
                  <Input
                    {...field}
                    ref={(el) => {
                      field.ref(el);

                      if (typeof forwardedRef === 'function') {
                        forwardedRef(el);
                      } else if (forwardedRef) {
                        (forwardedRef as RefObject<HTMLInputElement | null>).current = el;
                      }
                    }}
                    placeholder={placeholder}
                    disabled={disabled}
                    onKeyDown={handleKeyDown}
                    onFocus={() => {
                      isFocusedRef.current = true;
                      setIsFocused(true);
                      setPanelDismissed(false);
                    }}
                    onBlur={() => {
                      // Window deactivation isn't a real focus change — keep the
                      // panel so it's still open when the window comes back (the
                      // browser restores focus to the input).
                      if (!document.hasFocus()) {
                        return;
                      }

                      isFocusedRef.current = false;
                      setIsFocused(false);
                      field.onBlur();
                    }}
                    className={cn(
                      `
                      !w-full
                      !flex-1
                      !bg-transparent
                      !border-0
                      !outline-none
                      !ring-0
                      !shadow-none
                      !rounded-none
                      !p-0
                      !h-[calc(theme(spacing.9)-2px)]

                      focus:!ring-0
                      focus-visible:!ring-0
                      focus-visible:!border-transparent
                      focus:!border-transparent

                      disabled:!bg-transparent

                      resize-none
                      leading-none
                    `,
                      // Compact matches the collapsed header button (h-9, text-sm).
                      variant === 'compact' ? 'text-sm md:text-sm' : 'text-base md:text-base',
                    )}
                  />
                )}
              />

              <div
                className={cn('flex items-center gap-1', variant === 'compact' ? 'h-full' : 'my-1.5 mr-1.5')}
              >
                {statusSlot}

                {(queryValue.length > 0 || showClear) && (
                  <Button
                    type="button"
                    disabled={disabled}
                    variant="ghost"
                    size="sm"
                    className={cn(
                      'cursor-pointer p-0 active:scale-90 transition-transform duration-200 ease-out will-change-transform',
                      // Tuck against a following control (chevron/submit), but only
                      // when one renders — the toolsSlot target sits empty otherwise
                      // and the X must keep the box's right inset.
                      '[&:has(+*:not(:empty))]:-mr-1',
                      // Leave visible slack inside compact's 34px content row.
                      variant === 'compact' ? 'h-7 w-7' : 'h-8 w-8',
                    )}
                    onClick={handleClear}
                    onMouseDown={(e) => e.preventDefault()}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}

                {toolsSlot}

                {displayDropdown && (
                  <Button
                    type="button"
                    disabled={disabled}
                    variant={isDropdownPanelVisible ? 'secondary' : 'ghost'}
                    size="sm"
                    className="cursor-pointer h-8 w-8 p-0 active:scale-90 transition-transform duration-200 ease-out will-change-transform"
                    onClick={toggleDropdownPanel}
                  >
                    <ArrowDown
                      className={cn(
                        'h-4 w-4 transition-transform duration-200',
                        isDropdownPanelVisible && 'rotate-180',
                      )}
                    />
                  </Button>
                )}

                {variant === 'default' && (
                  <Button
                    type="submit"
                    disabled={disabled}
                    size="sm"
                    className="cursor-pointer h-8 w-8 p-0 active:scale-90 transition-transform duration-200 ease-out will-change-transform"
                  >
                    <Search className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          </div>

          {panelVisible && (
            <div className="absolute top-full left-0 right-0 z-50 bg-background border border-t-0 rounded-b-md shadow-xs">
              {panelHeader}
              {resultsNode}
            </div>
          )}
        </div>
      </form>
    </Form>
  );
}

const SearchBoxForwarded = forwardRef(SearchBox);

const SearchBoxWithContext = forwardRef<HTMLInputElement, Props>((props, ref) => (
  <DropdownProvider args={[{ changeSearchParams: true }]}>
    <SearchBoxForwarded {...props} ref={ref} />
  </DropdownProvider>
));

export { SearchBoxWithContext as SearchBox, type SearchResultItem };

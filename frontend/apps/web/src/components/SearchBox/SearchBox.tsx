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
  IconButton,
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
import { useTranslation } from 'react-i18next';

import { DropdownContent } from './DropdownContent';
import type { FilterDragPayload } from './filterDrag';
import { DropdownProvider, useDropdown } from './useDropdown';

/** Radix filter menus portal outside the search wrapper — clicks there must not dismiss the panel. */
const PORTALED_FILTER_IDS = ['entity-type-filters'];

function isPortaledFilterTarget(target: Node | null): boolean {
  if (target == null) {
    return false;
  }

  if (
    PORTALED_FILTER_IDS.some((id) => {
      const el = document.getElementById(id);

      return el != null && el.contains(target);
    })
  ) {
    return true;
  }

  if (!(target instanceof Element)) {
    return false;
  }

  return (
    target.closest('[data-radix-popper-content-wrapper]') != null ||
    target.closest('[data-slot="dropdown-menu-content"]') != null ||
    target.closest('[data-slot="popover-content"]') != null ||
    target.closest('[data-slot="select-content"]') != null
  );
}

/** True while a nested filter control (What / When / How / sort) is open in the panel footer. */
function hasOpenNestedFilterOverlay(): boolean {
  return (
    document.querySelector(
      [
        '[data-slot="dropdown-menu-content"][data-state="open"]',
        '[data-slot="popover-content"][data-state="open"]',
        '[data-slot="select-content"][data-state="open"]',
      ].join(', '),
    ) != null
  );
}

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
   * results. Shown whenever the panel is open.
   */
  panelHeader?: ReactNode;
  /**
   * Caller-supplied section rendered at the bottom of the dropdown panel,
   * below the results (e.g. the global advanced search controls).
   */
  panelFooter?: ReactNode;
  /**
   * Hold the dropdown panel open regardless of focus/query — used with
   * `panelHeader` / `panelFooter` so their content stays interactive (it
   * survives input blur).
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
   * Explicit submit. When provided, Enter/Return always commits the exact input
   * value (highlighted suggestion rows are click-only). Falls back to `onSearch`
   * when omitted, so existing callers keep their submit behavior — and Enter
   * still activates a highlighted result when there is no `onSubmit`.
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
  /** Ref populated with a function to mark user-engaged before programmatic focus. */
  engageRef?: React.MutableRefObject<(() => void) | null>;
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
    panelFooter,
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
    engageRef,
  }: Props,
  forwardedRef: ForwardedRef<HTMLInputElement>,
) {
  const { t } = useTranslation();

  const form = useForm<FormData>({
    resolver: formDataResolver(FormSchema),
    defaultValues: defaultQuery != null ? { query: defaultQuery } : EMPTY,
  });

  const isFocusedRef = useRef(false);
  const [isFocused, setIsFocused] = useState(false);
  // Panel opens on focus only after an explicit user gesture (click/tap or
  // keyboard engage), not on mount-time or restored focus.
  const [userEngaged, setUserEngaged] = useState(false);
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

  useEffect(() => {
    if (!engageRef) {
      return;
    }

    engageRef.current = () => setUserEngaged(true);

    return () => {
      engageRef.current = null;
    };
  }, [engageRef]);

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

  // Form submit (click the submit control, or Enter when onSubmit is omitted and
  // nothing is highlighted). Prefer the explicit `onSubmit` callback; fall back
  // to the live `onSearch` so callers that only pass the latter keep working.
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
          } else if (panelFooter && userEngaged) {
            setPanelDismissed(true);
            setUserEngaged(false);
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
          // Global search (and any caller with onSubmit) must commit exactly what
          // the user typed. Do not activate a highlighted row — the dropdown puts
          // actions like "Clear search query" above "Search for …", so ArrowDown
          // + Enter (or a sticky highlight) felt like the bar just closed.
          if (onSubmit) {
            e.preventDefault();
            e.stopPropagation();

            const submitted = (e.target as HTMLInputElement).value;

            // Enter commits immediately — cancel the in-flight autoSubmit
            // debounce (scheduled off the last keystroke, not off this Enter)
            // so it doesn't fire moments later and redundantly resubmit. Left
            // alone it used to get killed by SearchBox unmounting on commit;
            // now that a /memory commit no longer remounts the box (that
            // remount was itself racing the URL write — see GlobalSearchBox's
            // commitSearch), nothing else clears this timer.
            if (debounceTimeoutRef.current) {
              clearTimeout(debounceTimeoutRef.current);
              debounceTimeoutRef.current = null;
            }

            lastAutoSubmittedRef.current = submitted;
            setIsAutoSubmitPending(false);
            onSubmit({ query: submitted });
            setSelectedIndex(-1);
            setPanelDismissed(true);

            break;
          }

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
            setUserEngaged(true);
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
      onSubmit,
      selectedResult,
      onFilterAdd,
      handleClear,
      onKeyDown,
      panelFooter,
      userEngaged,
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

  // Close filters/results panel on outside click
  useEffect(() => {
    if (!isDropdownPanelVisible) {
      return;
    }

    const handlePointerDown = (e: PointerEvent) => {
      if (!wrapperRef.current) {
        return;
      }

      const target = e.target as Node;

      if (isPortaledFilterTarget(target)) {
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
  const focusOpensPanel = userEngaged || hasQuery;
  // Default: show the dropdown whenever there's a query. With `openOnFocus`, gate
  // on an explicit user engage (click/tap or `/`) — not passive/restored focus —
  // so recent searches can surface without opening on every app visit.
  // While the panel is pinned, a live query keeps its results visible even
  // unfocused — interacting with panelHeader content (filter dropdowns steal
  // focus) must not blank the suggestions below it.
  const resultsPanelOpen =
    displayResults &&
    !disabled &&
    !panelDismissed &&
    (openOnFocus ? (focusOpensPanel && isFocused) || (panelPinned && hasQuery) : hasQuery);

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
        <div className="flex max-h-[60vh] min-w-0 overflow-x-hidden">
          {selectedResult && selectedResult.preview && (
            <div className="min-w-0 flex-1 overflow-hidden p-4">{selectedResult.preview}</div>
          )}
          {/* collapseX: the scroll viewport's inner table otherwise grows to the
              row's min-content width and paints past the search box. */}
          <ScrollArea className="min-w-0 flex-1" collapseX ref={scrollAreaRef}>
            <div className="py-1">
              {results.map((result, index) => (
                <div
                  key={result.id}
                  ref={(el) => {
                    resultItemsRef.current[index] = el;
                  }}
                  className={`
                        min-w-0 overflow-hidden px-2 py-1.5 cursor-pointer border-l-4
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

  const panelVisible =
    !panelDismissed &&
    (resultsNode != null || (panelFooter != null && userEngaged) || (panelPinned && (isFocused || hasQuery)));

  // Dismiss an open suggestion/filter panel when clicking elsewhere on the page.
  useEffect(() => {
    if (!panelVisible) {
      return;
    }

    const handlePointerDown = (e: PointerEvent) => {
      if (!wrapperRef.current) {
        return;
      }

      const target = e.target as Node;

      if (isPortaledFilterTarget(target)) {
        return;
      }

      if (wrapperRef.current.contains(target)) {
        return;
      }

      if (panelFooter && hasOpenNestedFilterOverlay()) {
        // Let Radix close the nested filter menu on this click; keep the search panel open.
        return;
      }

      setPanelDismissed(true);

      if (panelFooter) {
        setUserEngaged(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);

    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [panelVisible, panelFooter]);

  return (
    <Form {...form}>
      <form autoComplete="off" onSubmit={form.handleSubmit(handleFormSubmit)}>
        <div className="relative" ref={wrapperRef} onPointerDown={() => setUserEngaged(true)}>
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
                    type="text"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    name="ci-global-search"
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
                      if (userEngaged || queryValue.length > 0) {
                        setPanelDismissed(false);
                      }
                    }}
                    onBlur={() => {
                      // Window deactivation isn't a real focus change — keep the
                      // panel so it's still open when the window comes back (the
                      // browser restores focus to the input).
                      if (!document.hasFocus()) {
                        return;
                      }

                      const active = document.activeElement;

                      if (active != null && wrapperRef.current?.contains(active)) {
                        return;
                      }

                      if (isPortaledFilterTarget(active)) {
                        return;
                      }

                      isFocusedRef.current = false;
                      setIsFocused(false);

                      if (!panelFooter) {
                        setUserEngaged(false);
                      }

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
                      // 16px on a phone so iOS does not zoom the page on focus.
                      variant === 'compact' ? 'text-base md:text-sm' : 'text-base',
                    )}
                  />
                )}
              />

              <div
                className={cn('flex items-center gap-1', variant === 'compact' ? 'h-full' : 'my-1.5 mr-1.5')}
              >
                {statusSlot}

                {(queryValue.length > 0 || showClear) && (
                  <IconButton
                    label={t('SEARCH_CLEAR')}
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
                  </IconButton>
                )}

                {toolsSlot}

                {displayDropdown && (
                  <IconButton
                    label={isDropdownPanelVisible ? t('SEARCH_FILTERS_HIDE') : t('SEARCH_FILTERS_SHOW')}
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
                  </IconButton>
                )}

                {variant === 'default' && (
                  <IconButton
                    label={t('SEARCH_SUBMIT')}
                    type="submit"
                    disabled={disabled}
                    size="sm"
                    className="cursor-pointer h-8 w-8 p-0 active:scale-90 transition-transform duration-200 ease-out will-change-transform"
                  >
                    <Search className="h-4 w-4" />
                  </IconButton>
                )}
              </div>
            </div>
          </div>

          {panelVisible && (
            <div className="absolute top-full left-0 right-0 z-50 max-w-full overflow-x-hidden bg-background border border-t-0 rounded-b-md shadow-xs">
              {panelHeader}
              {resultsNode}
              {panelFooter && (
                <div
                  className={cn(resultsNode != null && 'border-t')}
                  // Keep focus in the input so the filter panel stays open while
                  // opening What / When / How menus in the footer.
                  onMouseDown={(e) => e.preventDefault()}
                >
                  {panelFooter}
                </div>
              )}
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

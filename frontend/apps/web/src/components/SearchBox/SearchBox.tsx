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
} as const;

interface SearchResultItem {
  id: string;
  content: React.ReactNode;
  preview?: React.ReactNode;
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
  displayResults?: boolean;
  displayDropdown?: boolean;
  saveSupported?: boolean;
  onSearch?: (data: FormData & { entityDropdowns?: string[] }) => boolean | void | Promise<boolean | void>;
  onKeyDown?: (query: string, e: React.KeyboardEvent<HTMLInputElement>) => void;
  onClear?: () => void;
  onResultSelect?: (result: SearchResultItem) => void;
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
    displayResults = false,
    displayDropdown = false,
    saveSupported = true,
    defaultQuery,
    onSearch,
    onKeyDown,
    onClear,
    onResultSelect,
    onSave,
  }: Props,
  forwardedRef: ForwardedRef<HTMLInputElement>,
) {
  const form = useForm<FormData>({
    resolver: formDataResolver(FormSchema),
    defaultValues: defaultQuery != null ? { query: defaultQuery } : EMPTY,
  });

  const isFocusedRef = useRef(false);

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
  const wrapperRef = useRef<HTMLDivElement | null>(null);

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
        }
      }
    },
    [form, onSearch, disabled],
  );

  const handleClear = useCallback(() => {
    if (!disabled) {
      form.reset();
      setSelectedIndex(-1);

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
        case Keys.ESCAPE:
          e.preventDefault();
          e.stopPropagation();

          if (selectedIndex !== -1) {
            setSelectedIndex(-1);
          } else {
            handleClear();
          }

          break;

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

        default:
          if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete') {
            setSelectedIndex(-1);
          }

          break;
      }

      // Use timeout to get the updated value after the key press
      setTimeout(() => {
        onKeyDown?.((e.target as HTMLInputElement).value, e);
      }, 0);
    },
    [disabled, form, results, selectedIndex, onResultSelect, handleClear, onKeyDown],
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

  // Auto-submit with debounce
  useEffect(() => {
    if (!autoSubmit || !queryValue.trim() || disabled) {
      setIsAutoSubmitPending(false);

      return;
    }

    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }

    setIsAutoSubmitPending(true);

    debounceTimeoutRef.current = setTimeout(async () => {
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
  }, [queryValue, autoSubmit, autoSubmitDelay, disabled, handleSubmit]);

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(-1);
    resultItemsRef.current = [];
    setIsAutoSubmitPending(false);
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

  let resultsNode: ReactNode | null = null;

  if (displayDropdown && isDropdownPanelVisible) {
    resultsNode = <DropdownContent onSave={handleSaveSearch} saveSupported={saveSupported} />;
  } else if (queryValue.length > 0 && !disabled && displayResults) {
    if (isLoading) {
      resultsNode = (
        <div className="flex items-center justify-center p-8">
          <Spinner size={32} variant="circle" color="rgb(6,108,128)" />
        </div>
      );
    } else if (error) {
      resultsNode = (
        <div className="flex flex-col items-center justify-center p-8">
          <p className="text-muted-foreground font-medium">Something went wrong.</p>
          <p className="text-sm text-muted-foreground">Please try your search again.</p>
        </div>
      );
    } else if (results.length > 0) {
      resultsNode = (
        <div className="flex max-h-[60vh]">
          {selectedResult && selectedResult.preview && (
            <div className="flex-1 p-4 overflow-hidden">{selectedResult.preview}</div>
          )}
          <ScrollArea className="flex-1/2" ref={scrollAreaRef}>
            <div className="py-2">
              {results.map((result, index) => (
                <div
                  key={result.id}
                  ref={(el) => {
                    resultItemsRef.current[index] = el;
                  }}
                  className={`
                        p-2 cursor-pointer border-l-4
                        ${index === selectedIndex ? 'bg-accent text-accent-foreground border-blue-500' : 'hover:bg-muted/50 border-transparent'}
                      `}
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
    } else {
      resultsNode = (
        <div className="flex flex-col items-center justify-center p-8">
          <p className="text-muted-foreground font-medium">No results found.</p>
          <p className="text-sm text-muted-foreground">Try a different search.</p>
        </div>
      );
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)}>
        <div className="relative" ref={wrapperRef}>
          <div
            className={cn(
              'w-full flex flex-col',
              'placeholder:text-muted-foreground/60',
              'outline-none border shadow-xs rounded-md bg-background text-base',
              'aria-[invalid=true]:ring-destructive/20 dark:aria-[invalid=true]:ring-destructive/40 aria-[invalid=true]:border-destructive',
              'transition-[color,box-shadow]',
              disabled ? 'cursor-not-allowed opacity-50 pointer-events-none' : '',
              resultsNode ? 'rounded-b-none' : '',
              variant === 'compact' ? 'py-0.5 pr-0.5' : '',
            )}
          >
            <div className={cn('flex items-center justify-center', variant === 'compact' ? '' : 'pl-3')}>
              {variant === 'compact' && (
                <div className={`p-2 ${disabled ? 'text-muted-foreground' : ''}`}>
                  <Search className="h-5 w-5" strokeWidth={1.75} />
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
                    }}
                    onBlur={() => {
                      isFocusedRef.current = false;
                      field.onBlur();
                    }}
                    className="
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
                      text-base
                      md:text-base
                      leading-none
                    "
                  />
                )}
              />

              <div
                className={cn('flex items-center gap-1 mr-1.5', variant === 'compact' ? 'h-full' : 'my-1.5')}
              >
                {queryValue.length > 0 && (
                  <Button
                    type="button"
                    disabled={disabled}
                    variant="ghost"
                    size="sm"
                    className="cursor-pointer h-8 w-8 p-0 active:scale-90 transition-transform duration-200 ease-out will-change-transform -mr-1"
                    onClick={handleClear}
                    onMouseDown={(e) => e.preventDefault()}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}

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

          {resultsNode && (
            <div className="absolute top-full left-0 right-0 z-50 bg-background border border-t-0 rounded-b-md shadow-xs">
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

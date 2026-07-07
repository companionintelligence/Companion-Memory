import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { GlobalUID, Portal } from '@ci/common';
import { cn } from '@ci/shadcn';
import { Clock, Search, X } from '@ci/shadcn/icons';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { useRecentSearches } from '@/hooks';
import { useKeyboardShortcut } from '@/hooks/useKeyboardShortcut';
import {
  FILTER_PARAMS,
  countActiveFilters,
} from '@/pages/MemoryPage/Components/ExplorerToolbar/ActiveFilterChips';

import { CommunicationResult } from './results/CommunicationResult';
import { ConceptResult } from './results/ConceptResult';
import { ContentResult } from './results/ContentResult';
import { EventResult } from './results/EventResult';
import { FileResult } from './results/FileResult';
import { ItemResult } from './results/ItemResult';
import { NoteResult } from './results/NoteResult';
import { PersonResult } from './results/PersonResult';
import { PlaceResult } from './results/PlaceResult';
import { ThreadResult } from './results/ThreadResult';
import { SearchBox } from './SearchBox';
import { useSearchService } from './useSearchService';

const RECENT_PREFIX = 'recent:';
const SEARCH_ACTION_ID = 'action:search';

/**
 * The unified search in the primary navigation header — visible on every page
 * and the single free-text search for the Memory explorer (the explorer no
 * longer renders its own search box; its toolbar holds only the advanced
 * Who/What/When/Where/How filters).
 *
 * - On `/memory`, typing writes `?search` live (debounced) so results filter as
 *   you type, and the input mirrors `?search` via `defaultQuery` (so external
 *   clears / saved searches keep it in sync — the sync only fires while
 *   unfocused, so it never clobbers typing).
 * - Off `/memory`, it's a "jump to" launcher: entity suggestions navigate to the
 *   matching detail route, and committing a free-text query opens it in the
 *   explorer at `/memory?search=…` (carrying the semantic mode).
 * - Recent searches (locally persisted) surface on focus.
 */
export function GlobalSearchBox() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();

  const onMemory = location.pathname === '/memory';
  const semantic = searchParams.get('semantic') === '1';
  // Memory's advanced-filter drawer state lives in the URL so the explorer page
  // (which owns the toggle and the filter content) and this box stay in sync.
  const advancedOpen = onMemory && searchParams.get('advanced') === '1';
  // With filters active the clear-X must show even on an empty input — it
  // resets the filters too. The count renders as subtle text beside the box in
  // both states (statusSlot when expanded, left of the button when collapsed).
  const activeFilterCount = onMemory ? countActiveFilters(searchParams) : 0;
  const filterCountText =
    activeFilterCount > 0 ? `${activeFilterCount} ${activeFilterCount === 1 ? 'filter' : 'filters'}` : null;
  // On /memory the input mirrors the live `?search` param; elsewhere it stays a
  // transient launcher value, so we don't seed it from the URL.
  const urlSearch = searchParams.get('search') ?? '';

  // Drives the suggestion query; debounced via SearchBox's autoSubmit.
  const [query, setQuery] = useState<string | null>(null);
  // Bumped to remount SearchBox after a commit/navigation, clearing input + dropdown.
  const [resetKey, setResetKey] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // GitHub-style: collapsed, the header shows a compact search *button*; clicking
  // it (or `/`) expands the real SearchBox as an overlay across the header region
  // (breadcrumbs, view tabs). The expanded box is CSS-hidden rather than
  // unmounted while collapsed so the nav-tools / nav-search-panel portal targets
  // stay in the DOM for Portal.Slot.
  const [expanded, setExpanded] = useState(false);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  // `?advanced=1` implies the expanded box (the pinned filter panel hangs off
  // it). Closing the filters keeps the wide bar and refocuses the input — the
  // user is still mid-search — which re-arms the blur/Escape collapse rules.
  // On a collapsed box the focus call is a no-op (hidden inputs can't focus),
  // so the mount run and off-memory transitions change nothing.
  useEffect(() => {
    if (advancedOpen) {
      setExpanded(true);
    } else {
      inputRef.current?.focus();
    }
  }, [advancedOpen]);

  // Focus once the overlay is visible (a display:none input can't take focus).
  useEffect(() => {
    if (expanded) {
      inputRef.current?.focus();
    }
  }, [expanded]);

  // Collapse on outside pointerdown — except while the advanced panel is pinned
  // (it's toggle-controlled), and never for clicks inside Radix poppers (filter
  // dropdowns portal to document.body).
  useEffect(() => {
    if (!expanded || advancedOpen) {
      return;
    }

    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node;

      if (overlayRef.current?.contains(target)) {
        return;
      }

      if (target instanceof Element && target.closest('[data-radix-popper-content-wrapper]')) {
        return;
      }

      setExpanded(false);
    };

    document.addEventListener('pointerdown', handlePointerDown);

    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [expanded, advancedOpen]);

  const [recentSearches, { addRecentSearch, removeRecentSearch }] = useRecentSearches();

  // Suggestions follow the explorer's semantic mode and its What (entity-type)
  // filter so the dropdown agrees with the pinned filters above it. The other
  // dimensions (who / when / where / tags / connectors) aren't part of the
  // search API's input yet, so only the page results honor them.
  const includeTypes = onMemory
    ? searchParams.get('includedEntityTypes')?.split(',').filter(Boolean)
    : undefined;
  const userExcludedTypes = onMemory
    ? (searchParams.get('excludedEntityTypes')?.split(',').filter(Boolean) ?? [])
    : [];
  // Keep the box's default exclusions on top of the explorer's (the service
  // only applies its defaults when excludeTypes is omitted entirely).
  const excludeTypes =
    userExcludedTypes.length > 0 ? [...userExcludedTypes, 'answer', 'browser-activity'] : undefined;

  const { data, loading, error } = useSearchService({
    searchQuery: query ?? '',
    semantic,
    includeTypes,
    excludeTypes,
  });

  // Also collapses: it runs after a committed search / suggestion navigation,
  // where the expanded box has done its job (the collapsed button echoes the
  // committed query on /memory).
  const clearInput = useCallback(() => {
    setQuery(null);
    setResetKey((key) => key + 1);
    setExpanded(false);
  }, []);

  // Open a free-text query in the explorer. Keep existing filters when already on
  // /memory (so the header doesn't wipe the toolbar's filters); otherwise navigate
  // there, carrying the semantic mode if it's set.
  const commitSearch = useCallback(
    (rawQuery: string) => {
      const trimmed = rawQuery.trim();

      if (!trimmed) {
        return;
      }

      addRecentSearch(trimmed);

      if (onMemory) {
        setSearchParams((params) => {
          params.set('search', trimmed);

          return params;
        });
      } else {
        const params = new URLSearchParams();
        params.set('search', trimmed);

        if (semantic) {
          params.set('semantic', '1');
        }

        navigate(`/memory?${params.toString()}`);
      }

      clearInput();
    },
    [addRecentSearch, clearInput, navigate, onMemory, semantic, setSearchParams],
  );

  const suggestions = useMemo(
    () =>
      data.map((item) => {
        switch (item.__typename) {
          case 'CommunicationType':
            return { id: item.id, content: <CommunicationResult communication={item} /> };

          case 'ConceptType':
            return { id: item.id, content: <ConceptResult concept={item} /> };

          case 'ContentType':
            return { id: item.id, content: <ContentResult content={item} /> };

          case 'EventType':
            return { id: item.id, content: <EventResult event={item} /> };

          case 'FileType':
            return { id: item.id, content: <FileResult file={item} /> };

          case 'ItemType':
            return { id: item.id, content: <ItemResult item={item} /> };

          case 'NoteType':
            return { id: item.id, content: <NoteResult note={item} /> };

          case 'PersonType':
            return { id: item.id, content: <PersonResult person={item} /> };

          case 'PlaceType':
            return { id: item.id, content: <PlaceResult place={item} /> };

          case 'ThreadType':
            return { id: item.id, content: <ThreadResult thread={item} /> };

          default:
            return { id: item.id, content: null };
        }
      }),
    [data],
  );

  const results = useMemo(() => {
    const trimmed = (query ?? '').trim();

    // Typing → a "search Memory" action followed by live entity suggestions.
    if (trimmed) {
      return [
        {
          id: SEARCH_ACTION_ID,
          content: (
            <div className="flex items-center gap-2 text-sm">
              <Search className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">
                {onMemory ? 'Search Memory for' : 'Search all of Memory for'}
              </span>
              <span className="font-medium">“{trimmed}”</span>
            </div>
          ),
        },
        ...suggestions,
      ];
    }

    // Empty + focused → recent searches.
    return recentSearches.map((recent) => ({
      id: `${RECENT_PREFIX}${recent}`,
      content: (
        <div className="flex items-center gap-2 text-sm">
          <Clock className="h-4 w-4 text-muted-foreground" />
          <span className="flex-1 truncate">{recent}</span>
          <button
            type="button"
            aria-label={`Remove "${recent}" from recent searches`}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              removeRecentSearch(recent);
            }}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ),
    }));
  }, [onMemory, query, recentSearches, removeRecentSearch, suggestions]);

  // Live, debounced. Drives the suggestion query everywhere, and on /memory also
  // writes `?search` so the explorer filters as you type (replace: keep history clean).
  const handleSearch = useCallback(
    ({ query: searchQuery }: { query: string }) => {
      setQuery(searchQuery);

      if (onMemory) {
        const trimmed = searchQuery.trim();

        setSearchParams(
          (params) => {
            if (trimmed) {
              params.set('search', trimmed);
            } else {
              params.delete('search');
            }

            return params;
          },
          { replace: true },
        );
      }
    },
    [onMemory, setSearchParams],
  );

  // The X is a full reset: the query, every explorer filter (the same set as
  // the chips row's "Clear all"), the pinned-filters state, and the expansion.
  const handleClear = useCallback(() => {
    setQuery(null);

    if (onMemory) {
      setSearchParams(
        (params) => {
          params.delete('search');
          params.delete('advanced');

          for (const param of FILTER_PARAMS) {
            params.delete(param);
          }

          return params;
        },
        { replace: true },
      );
    }

    setExpanded(false);
  }, [onMemory, setSearchParams]);

  const handleResultSelect = useCallback(
    ({ id }: { id: string }) => {
      if (id === SEARCH_ACTION_ID) {
        commitSearch(query ?? '');

        return;
      }

      if (id.startsWith(RECENT_PREFIX)) {
        commitSearch(id.slice(RECENT_PREFIX.length));

        return;
      }

      // Entity suggestion → jump to its detail route; remember what was searched.
      if (query?.trim()) {
        addRecentSearch(query.trim());
      }

      clearInput();

      const { type, id: decodedId } = GlobalUID.decode(id);

      switch (type) {
        case 'communication':
          navigate(`/communications/${decodedId}`);
          break;

        case 'concept':
          navigate(`/concepts/${decodedId}`);
          break;

        case 'content':
          navigate(`/content/${decodedId}`);
          break;

        case 'event':
          navigate(`/events/${decodedId}`);
          break;

        case 'item':
          navigate(`/items/${decodedId}`);
          break;

        case 'note':
          navigate(`/notes/${decodedId}`);
          break;

        case 'person':
          navigate(`/people/${decodedId}`);
          break;

        case 'place':
          navigate(`/places/${decodedId}`);
          break;

        case 'thread':
          navigate(`/chat/${decodedId}`);
          break;

        default:
          break;
      }
    },
    [addRecentSearch, clearInput, commitSearch, navigate, query],
  );

  // Expand + focus. The focus call only lands when already expanded (a hidden
  // input can't take focus); the expanded-effect above covers the fresh expand.
  useKeyboardShortcut('/', () => {
    setExpanded(true);
    inputRef.current?.focus();
  });

  // One Escape closes the whole expanded bar — pinned filters included — and
  // nothing else: the typed text survives hidden, clearing stays on the X.
  // Focus lands on the collapsed button so Enter/Space reopens.
  const collapseBar = useCallback(() => {
    setSearchParams(
      (params) => {
        params.delete('advanced');

        return params;
      },
      { replace: true },
    );
    setExpanded(false);
    buttonRef.current?.focus();
  }, [setSearchParams]);

  return (
    <>
      {/* Collapsed state: a button dressed as a small search field. On /memory it
          echoes the committed query — and the active-filter count beside it — so
          the collapsed bar still shows what's filtering the page. */}
      {filterCountText && (
        <span className="mr-2 whitespace-nowrap text-xs text-muted-foreground">{filterCountText}</span>
      )}
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setExpanded(true)}
        aria-label="Search"
        aria-expanded={expanded}
        className="flex h-9 w-64 max-w-full cursor-pointer items-center gap-2 rounded-md border bg-background px-3 text-sm text-muted-foreground shadow-xs hover:bg-accent/50"
      >
        <Search className="h-4 w-4 shrink-0" strokeWidth={1.75} />
        <span className={cn('truncate', onMemory && urlSearch && 'text-foreground')}>
          {onMemory && urlSearch ? urlSearch : 'Search'}
        </span>
        <kbd className="ml-auto rounded border bg-muted px-1.5 font-mono text-[10px]">/</kbd>
      </button>

      {/* Expanded state: the real SearchBox, overlaying the header's relative
          region (breadcrumbs + view tabs). Hidden, not unmounted, while collapsed
          so its portal targets survive. Escape past the panel/clear stages (i.e.
          on an empty box) collapses back to the button. */}
      <div
        ref={overlayRef}
        className={cn('absolute inset-0 z-40 flex items-center bg-background', !expanded && 'hidden')}
        // Escape from anywhere in the overlay — the input stops propagation and
        // reports via SearchBox's onKeyDown instead, so this only catches ESC on
        // the inset controls and filter triggers (focus lives there after a
        // filter interaction).
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            collapseBar();
          }
        }}
        // Panel closed ⇒ collapsed: when focus leaves the overlay entirely the
        // dropdown is gone, so the box goes with it (suggestion clicks hold focus
        // via mousedown-preventDefault; the pinned filter panel is chevron-owned).
        onBlur={(e) => {
          // Window deactivation isn't a real focus change — stay expanded so
          // everything is intact when the window comes back.
          if (!document.hasFocus()) {
            return;
          }

          if (!advancedOpen && !overlayRef.current?.contains(e.relatedTarget as Node)) {
            setExpanded(false);
          }
        }}
      >
        <div className="min-w-0 flex-1">
          <SearchBox
            key={resetKey}
            ref={inputRef}
            defaultQuery={onMemory ? urlSearch : undefined}
            onSearch={handleSearch}
            onSubmit={({ query: submitted }) => commitSearch(submitted)}
            onClear={handleClear}
            onResultSelect={handleResultSelect}
            onKeyDown={(_value, e) => {
              if (e.key === 'Escape') {
                collapseBar();
              }
            }}
            variant="compact"
            placeholder="Search"
            autoSubmit
            autoSubmitEmpty={onMemory}
            displayResults
            openOnFocus
            loading={loading}
            error={error}
            results={results}
            // Inset tool target at the input's right edge; Memory portals its
            // advanced-filter toggle here (empty — and hidden — on other pages).
            // Passive status text before the clear-X.
            statusSlot={
              filterCountText && (
                <span className="whitespace-nowrap text-xs text-muted-foreground">{filterCountText}</span>
              )
            }
            showClear={activeFilterCount > 0}
            toolsSlot={<Portal id="nav-tools" className="flex items-center empty:hidden" />}
            // Filters section pinned above the results while `?advanced=1`; Memory
            // portals its filter row here. The trailing border only renders when
            // results follow (the target is last-child otherwise).
            panelHeader={
              <Portal id="nav-search-panel" className="empty:hidden [&:not(:last-child)]:border-b" />
            }
            panelPinned={advancedOpen}
          />
        </div>
      </div>
    </>
  );
}

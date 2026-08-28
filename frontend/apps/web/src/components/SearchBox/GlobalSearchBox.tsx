import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { GlobalUID } from '@ci/common';
import { Tooltip } from '@ci/shadcn';
import { Clock, FilterX, Search, SearchX, X } from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { isMemoryExplorerPath, isMemoryHubPath } from '@/components/MemoryHub/memoryHubSections';
import { DropdownProvider } from '@/components/SearchBox/useDropdown';
import { useRecentSearches } from '@/hooks';
import { useKeyboardShortcut } from '@/hooks/useKeyboardShortcut';
import { chatThreadPath } from '@/pages/ChatPage/chatPaths';
import { SearchPanelFilters } from '@/pages/MemoryPage/Components/ExplorerToolbar/ExplorerToolbar';
import {
  FILTER_PARAMS,
  addEntityFilter,
  countActiveFilters,
} from '@/pages/MemoryPage/Components/ExplorerToolbar/filterParams';

import type { FilterDragPayload } from './filterDrag';
import { CommunicationResult } from './results/CommunicationResult';
import { ConceptResult } from './results/ConceptResult';
import { ContentResult } from './results/ContentResult';
import { EventResult } from './results/EventResult';
import { FileResult } from './results/FileResult';
import { ItemResult } from './results/ItemResult';
import { NoteResult } from './results/NoteResult';
import { PersonResult } from './results/PersonResult';
import { PlaceResult } from './results/PlaceResult';
import { TagResult } from './results/TagResult';
import { ThreadResult } from './results/ThreadResult';
import { SearchBox, type SearchResultItem } from './SearchBox';
import { useSearchService } from './useSearchService';

const RECENT_PREFIX = 'recent:';
// Tag suggestion ids carry the label, not a GlobalUID — selecting one applies
// the tag as an explorer filter rather than opening a detail route.
const TAG_PREFIX = 'tagfilter:';
const SEARCH_ACTION_ID = 'action:search';
const CLEAR_FILTERS_ACTION_ID = 'action:clear-filters';
const CLEAR_QUERY_ACTION_ID = 'action:clear-query';

/**
 * The unified search in the primary navigation header — visible on every page
 * and the single free-text search for the Memory explorer (the explorer no
 * longer renders its own search box; its toolbar holds only the advanced
 * Who/What/When/Where/How filters on mobile).
 *
 * Advanced filters live inline on the Events explorer page only — not in this
 * header dropdown. On other pages (and Memory hub sub-routes), What / When /
 * How / toggles / sort open in the panel footer when the search bar is focused.
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
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();

  const onMemoryExplorer = isMemoryExplorerPath(location.pathname);
  const onMemoryHub = isMemoryHubPath(location.pathname);
  const semantic = searchParams.get('semantic') === '1';
  const activeFilterCount = countActiveFilters(searchParams);
  // On /memory the input mirrors the live `?search` param; elsewhere it stays a
  // transient launcher value, so we don't seed it from the URL.
  const urlSearch = searchParams.get('search') ?? '';

  // Drives the suggestion query; debounced via SearchBox's autoSubmit.
  const [query, setQuery] = useState<string | null>(null);
  // Bumped to remount SearchBox after a commit/navigation, clearing input + dropdown.
  const [resetKey, setResetKey] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const engageSearchRef = useRef<(() => void) | null>(null);
  // Only the clear-query row's in-place reset should refocus + re-engage the
  // remounted input (see the resetKey effect below) — set right before that
  // bump, and consumed (reset to false) the moment it's acted on.
  const refocusOnResetRef = useRef(false);

  // Always expanded — the search bar stays visible in the header.
  const overlayRef = useRef<HTMLDivElement | null>(null);

  const [recentSearches, { addRecentSearch, removeRecentSearch }] = useRecentSearches();

  // Suggestions follow the explorer's semantic mode and its What (entity-type)
  // filter so the dropdown agrees with the pinned filters above it. The other
  // dimensions (who / when / where / tags / connectors) aren't part of the
  // search API's input yet, so only the page results honor them.
  const includeTypes = searchParams.get('includedEntityTypes')?.split(',').filter(Boolean);
  const userExcludedTypes = searchParams.get('excludedEntityTypes')?.split(',').filter(Boolean) ?? [];
  // Keep the box's default exclusions on top of the explorer's (the service
  // only applies its defaults when excludeTypes is omitted entirely).
  const excludeTypes =
    userExcludedTypes.length > 0 ? [...userExcludedTypes, 'answer', 'browser-activity'] : undefined;

  const { data, tags, loading, error } = useSearchService({
    searchQuery: query ?? '',
    semantic,
    includeTypes,
    excludeTypes,
  });

  // Runs after a suggestion navigation (entity/tag jump, or the off-memory
  // "jump to explorer" commit), where the box has done its job. Remounts
  // unfocused (see the resetKey effect below) — the fresh instance picks the
  // committed query back up from `?search` via `defaultQuery` once the URL
  // update lands.
  const clearInput = useCallback(() => {
    setQuery(null);
    setResetKey((key) => key + 1);
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

      if (onMemoryExplorer) {
        // Already mirrored live by `handleSearch` as the user types — this
        // just fast-forwards past its debounce. Do NOT remount here: react-router
        // v7 applies `setSearchParams` as an async transition, never batched
        // with a same-tick `setResetKey`, so a remount can land — and read
        // `urlSearch` for the fresh instance's `defaultQuery` — before the
        // `search` param above has actually committed. The stale-empty
        // `defaultQuery` that results feeds `autoSubmitEmpty`'s debounce,
        // which then deletes `search` right back out of the URL. Leaving the
        // input alone means there's nothing to resync — it already shows
        // exactly what was just committed.
        setSearchParams((params) => {
          params.set('search', trimmed);

          return params;
        });

        return;
      }

      const params = new URLSearchParams();

      params.set('search', trimmed);

      for (const param of FILTER_PARAMS) {
        const value = searchParams.get(param);

        if (value) {
          params.set(param, value);
        }
      }

      navigate(`/memory/events?${params.toString()}`);
      clearInput();
    },
    [addRecentSearch, clearInput, navigate, onMemoryExplorer, searchParams, setSearchParams],
  );

  // The query only — the counterpart to `clearFilters`. Remounting SearchBox
  // empties the input; on /memory the live `?search` param goes with it. The
  // filters, the drawer state, and the expanded bar all stay.
  //
  // The remount is deferred (via the pending flag) until the `?search` delete
  // has landed in the router state: bumping resetKey in the same batch remounts
  // SearchBox one render early, while urlSearch still holds the old query — the
  // fresh instance seeds its input from it, the refocus below then blocks the
  // defaultQuery sync (it yields to a focused input), and the fresh instance's
  // auto-submit writes the stale query straight back to the URL.
  const [clearQueryPending, setClearQueryPending] = useState(false);

  const clearQuery = useCallback(() => {
    setQuery(null);
    setClearQueryPending(true);

    if (onMemoryExplorer) {
      setSearchParams(
        (params) => {
          params.delete('search');

          return params;
        },
        { replace: true },
      );
    }
  }, [onMemoryExplorer, setSearchParams]);

  useEffect(() => {
    if (!clearQueryPending || (onMemoryExplorer && urlSearch)) {
      return;
    }

    setClearQueryPending(false);
    refocusOnResetRef.current = true;
    setResetKey((key) => key + 1);
  }, [clearQueryPending, onMemoryExplorer, urlSearch]);

  // A remount replaces the input with a fresh, unfocused one. Refocus so an
  // in-place reset (the clear-query row) keeps the user typing. `clearInput`'s
  // remounts (committing a search, jumping to a result) must NOT refocus —
  // that's what previously made the box grab focus (and, on /memory, race the
  // just-committed `?search` back to empty) on every navigation away from it.
  useEffect(() => {
    if (!refocusOnResetRef.current) {
      return;
    }

    refocusOnResetRef.current = false;
    engageSearchRef.current?.();
    inputRef.current?.focus();
  }, [resetKey]);

  // Same reset as the drop area's `Clear all`: the filter set only. The query
  // and the drawer state stay — the row acts in place, like the advanced toggle.
  const clearFilters = useCallback(() => {
    setSearchParams(
      (params) => {
        for (const param of FILTER_PARAMS) {
          params.delete(param);
        }

        return params;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  const suggestions = useMemo<SearchResultItem[]>(
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

          // Person/place rows carry their drag payload (`filterName` is the
          // query-level unmasked name) so the right arrow can add them as
          // who/where filters without a drag.
          case 'PersonType':
            return {
              id: item.id,
              content: <PersonResult person={item} />,
              filter: item.filterName ? { kind: 'person', name: item.filterName } : undefined,
            };

          case 'PlaceType':
            return {
              id: item.id,
              content: <PlaceResult place={item} />,
              filter: item.filterName ? { kind: 'place', name: item.filterName } : undefined,
            };

          case 'ThreadType':
            return { id: item.id, content: <ThreadResult thread={item} /> };

          default:
            return { id: item.id, content: null };
        }
      }),
    [data],
  );

  const results = useMemo<SearchResultItem[]>(() => {
    const trimmed = (query ?? '').trim();

    const clearFiltersRows: SearchResultItem[] =
      activeFilterCount > 0
        ? [
            {
              id: CLEAR_FILTERS_ACTION_ID,
              content: (
                <div className="flex items-center gap-2">
                  <FilterX className="h-6 w-6 text-muted-foreground" strokeWidth={1.5} />
                  <span className="text-muted-foreground">Clear search filters</span>
                </div>
              ),
            },
          ]
        : [];

    // Typing → clear-query, "search Memory", matching tags, then live suggestions.
    if (trimmed) {
      return [
        {
          id: CLEAR_QUERY_ACTION_ID,
          content: (
            <div className="flex items-center gap-2">
              <SearchX className="h-6 w-6 text-muted-foreground" strokeWidth={1.5} />
              <span className="text-muted-foreground">Clear search query</span>
            </div>
          ),
        },
        ...clearFiltersRows,
        {
          id: SEARCH_ACTION_ID,
          content: (
            <div className="flex items-center gap-2">
              <Search className="h-6 w-6 text-muted-foreground" strokeWidth={1.5} />
              <span className="text-muted-foreground">
                {onMemoryExplorer ? 'Search Memory for' : 'Search all of Memory for'}
              </span>
              <span className="font-medium">“{trimmed}”</span>
            </div>
          ),
        },
        ...tags.map((tag) => ({
          id: `${TAG_PREFIX}${tag.label}`,
          content: <TagResult label={tag.label} />,
          filter: { kind: 'tag' as const, name: tag.label },
        })),
        ...suggestions,
      ];
    }

    // Empty + focused → clear-filters (when active), then recent searches.
    return [
      ...clearFiltersRows,
      ...recentSearches.map((recent) => ({
        id: `${RECENT_PREFIX}${recent}`,
        content: (
          <div className="flex items-center gap-2">
            <Clock className="h-6 w-6 text-muted-foreground" strokeWidth={1.5} />
            <span className="flex-1 truncate">{recent}</span>
            <Tooltip delayDuration={600}>
              <Tooltip.Content>{t('SEARCH_RECENT_REMOVE', { query: recent })}</Tooltip.Content>
              <Tooltip.Trigger asChild>
                <button
                  type="button"
                  aria-label={t('SEARCH_RECENT_REMOVE', { query: recent })}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeRecentSearch(recent);
                  }}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </Tooltip.Trigger>
            </Tooltip>
          </div>
        ),
      })),
    ];
  }, [activeFilterCount, onMemoryExplorer, query, recentSearches, removeRecentSearch, suggestions, t, tags]);

  // Live, debounced. Drives the suggestion query everywhere, and on /memory also
  // writes `?search` so the explorer filters as you type (replace: keep history clean).
  const handleSearch = useCallback(
    ({ query: searchQuery }: { query: string }) => {
      setQuery(searchQuery);

      if (onMemoryExplorer) {
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
    [onMemoryExplorer, setSearchParams],
  );

  // The X is a full reset: the query, every explorer filter (the same set as
  // the drop area's "Clear all"), the pinned-filters state, and the expansion.
  const handleClear = useCallback(() => {
    setQuery(null);

    if (onMemoryHub && !onMemoryExplorer) {
      navigate('/memory/events', { replace: true });

      return;
    }

    setSearchParams(
      (params) => {
        params.delete('search');

        for (const param of FILTER_PARAMS) {
          params.delete(param);
        }

        return params;
      },
      { replace: true },
    );
  }, [navigate, onMemoryExplorer, onMemoryHub, setSearchParams]);

  // Arrow-key analogue of dragging a person/place/tag row onto the explorer's
  // filter drop area: right adds the highlighted row's filter. Same
  // validation/dedupe as a drop; failures are silent no-ops here (the drop
  // area owns the error surface). Only wired on /memory — matching the drag,
  // whose drop target only exists there — so the arrow keeps its native caret
  // behavior everywhere else. Removal stays on the drop area's chips.
  const handleFilterAdd = useCallback(
    (filter: FilterDragPayload) => {
      setSearchParams((params) => {
        addEntityFilter(params, filter.kind, filter.name);

        return params;
      });
    },
    [setSearchParams],
  );

  const handleResultSelect = useCallback(
    ({ id }: { id: string }) => {
      // Acts in place — the typed query and the dropdown stay; the row itself
      // disappears once the filter count hits zero.
      if (id === CLEAR_FILTERS_ACTION_ID) {
        clearFilters();

        return;
      }

      // The box stays open and focused; with the query gone the dropdown
      // falls back to recent searches.
      if (id === CLEAR_QUERY_ACTION_ID) {
        clearQuery();

        return;
      }

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

      // Tag suggestion → the explorer filtered to the tag (its de facto detail
      // page); fresh params, like any other detail navigation.
      if (id.startsWith(TAG_PREFIX)) {
        navigate(`/memory/events?tags=${encodeURIComponent(id.slice(TAG_PREFIX.length))}`);

        return;
      }

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
          navigate(chatThreadPath(decodedId));
          break;

        default:
          break;
      }
    },
    [addRecentSearch, clearFilters, clearInput, clearQuery, commitSearch, navigate, query],
  );

  // Expand + focus. The focus call only lands when already expanded (a hidden
  // input can't take focus); the expanded-effect above covers the fresh expand.
  useKeyboardShortcut('/', () => {
    engageSearchRef.current?.();
    inputRef.current?.focus();
  });

  return (
    <div ref={overlayRef} className="relative flex min-w-0 items-center">
      <div className="min-w-0 flex-1">
        <SearchBox
          key={resetKey}
          ref={inputRef}
          engageRef={engageSearchRef}
          defaultQuery={onMemoryExplorer ? urlSearch : undefined}
          onSearch={handleSearch}
          onSubmit={({ query: submitted }) => commitSearch(submitted)}
          onClear={handleClear}
          onResultSelect={handleResultSelect}
          onFilterAdd={onMemoryExplorer ? handleFilterAdd : undefined}
          variant="compact"
          placeholder="Search memory…"
          autoSubmit
          autoSubmitEmpty={onMemoryExplorer}
          displayResults
          openOnFocus
          loading={loading}
          error={error}
          results={results}
          showClear={activeFilterCount > 0 || Boolean(onMemoryExplorer ? urlSearch : query?.trim())}
          panelFooter={
            !onMemoryExplorer ? (
              <DropdownProvider args={[{ changeSearchParams: true }]}>
                <SearchPanelFilters modal={false} />
              </DropdownProvider>
            ) : undefined
          }
        />
      </div>
    </div>
  );
}

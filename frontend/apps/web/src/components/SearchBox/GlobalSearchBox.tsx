import { useCallback, useMemo, useRef, useState } from 'react';

import { GlobalUID } from '@ci/common';
import { cn } from '@ci/shadcn';
import { Clock, Search, Sparkles, Type, X } from '@ci/shadcn/icons';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { useRecentSearches } from '@/hooks';
import { useKeyboardShortcut } from '@/hooks/useKeyboardShortcut';

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
 * Inline global search rendered in the primary navigation header.
 *
 * UX reconciliation (this is the single Memory search surface):
 * - **On `/memory`** the header search *is* the explorer search. Typing writes
 *   the debounced `?search=` URL param so the explorer grid filters live, and the
 *   input reflects that param. Picking an entity suggestion still jumps to its
 *   detail route ("jump to"); the explorer search is the primary filter.
 * - **Off `/memory`** it stays a global "jump to": entity suggestions navigate to
 *   detail routes, and committing a search (Enter / the "Search Memory" row)
 *   bridges to `/memory?search=…` so the same query opens in the explorer.
 *
 * It also offers locally-persisted recent searches and a keyword/semantic mode
 * toggle (the `?semantic` param, consumed by the explorer + suggestion queries).
 */
export function GlobalSearchBox() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();

  const onMemory = location.pathname === '/memory';
  const semantic = searchParams.get('semantic') === '1';
  const urlSearch = searchParams.get('search') ?? '';

  // Drives the suggestion query; debounced via SearchBox's autoSubmit.
  const [query, setQuery] = useState<string | null>(null);
  // Bumped to remount SearchBox after a commit/navigation, clearing input + dropdown.
  const [resetKey, setResetKey] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [recentSearches, { addRecentSearch, removeRecentSearch }] = useRecentSearches();

  const { data, loading, error } = useSearchService({ searchQuery: query ?? '', semantic });

  const clearInput = useCallback(() => {
    setQuery(null);
    setResetKey((key) => key + 1);
  }, []);

  // Live, debounced reflection of the input while on /memory — keeps the explorer in sync.
  const writeSearchParam = useCallback(
    (value: string) => {
      setSearchParams(
        (params) => {
          if (value.trim()) {
            params.set('search', value.trim());
          } else {
            params.delete('search');
          }

          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const setSemanticMode = useCallback(
    (next: boolean) => {
      setSearchParams(
        (params) => {
          if (next) {
            params.set('semantic', '1');
          } else {
            params.delete('semantic');
          }

          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // Commit a search: record it as recent and either filter the explorer in place
  // (on /memory) or bridge to the explorer (everywhere else).
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
        clearInput();

        return;
      }

      const params = new URLSearchParams();
      params.set('search', trimmed);

      if (semantic) {
        params.set('semantic', '1');
      }

      navigate(`/memory?${params.toString()}`);
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

  const handleSearch = useCallback(
    ({ query: searchQuery }: { query: string }) => {
      setQuery(searchQuery);

      if (onMemory) {
        writeSearchParam(searchQuery);
      }
    },
    [onMemory, writeSearchParam],
  );

  const handleClear = useCallback(() => {
    setQuery(null);

    if (onMemory) {
      writeSearchParam('');
    }
  }, [onMemory, writeSearchParam]);

  // Catches backspace-to-empty (autoSubmit doesn't fire on an empty query) so the
  // explorer filter + suggestions clear as soon as the input is emptied.
  const handleKeyDown = useCallback(
    (value: string) => {
      if (value.trim() === '') {
        setQuery(null);

        if (onMemory) {
          writeSearchParam('');
        }
      }
    },
    [onMemory, writeSearchParam],
  );

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

  const modeToggle = (
    <div className="flex items-center gap-2 border-b px-3 py-2">
      <span className="text-xs font-medium text-muted-foreground">Search mode</span>
      <div className="ml-auto inline-flex overflow-hidden rounded-md border">
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setSemanticMode(false)}
          className={cn(
            'flex items-center gap-1 px-2 py-1 text-xs transition-colors',
            !semantic ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted/50',
          )}
        >
          <Type className="h-3.5 w-3.5" />
          Keyword
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setSemanticMode(true)}
          className={cn(
            'flex items-center gap-1 px-2 py-1 text-xs transition-colors',
            semantic ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted/50',
          )}
        >
          <Sparkles className="h-3.5 w-3.5" />
          Semantic
        </button>
      </div>
    </div>
  );

  useKeyboardShortcut('/', () => inputRef.current?.focus());

  return (
    <SearchBox
      key={resetKey}
      ref={inputRef}
      onSearch={handleSearch}
      onSubmit={({ query: submitted }) => commitSearch(submitted)}
      onClear={handleClear}
      onKeyDown={handleKeyDown}
      onResultSelect={handleResultSelect}
      variant="compact"
      placeholder="Search"
      autoSubmit
      displayResults
      openOnFocus
      // The explorer filter panel (entity types / date / tags / sort) lives behind
      // the dropdown toggle. Save-search isn't wired here yet, so hide that button.
      displayDropdown
      saveSupported={false}
      resultsHeader={modeToggle}
      defaultQuery={onMemory ? urlSearch : undefined}
      loading={loading}
      error={error}
      results={results}
    />
  );
}

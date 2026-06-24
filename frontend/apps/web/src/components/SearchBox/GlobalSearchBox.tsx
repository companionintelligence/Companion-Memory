import { useCallback, useMemo, useRef, useState } from 'react';

import { GlobalUID } from '@ci/common';
import { Clock, Search, X } from '@ci/shadcn/icons';
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
  // On /memory the input mirrors the live `?search` param; elsewhere it stays a
  // transient launcher value, so we don't seed it from the URL.
  const urlSearch = searchParams.get('search') ?? '';

  // Drives the suggestion query; debounced via SearchBox's autoSubmit.
  const [query, setQuery] = useState<string | null>(null);
  // Bumped to remount SearchBox after a commit/navigation, clearing input + dropdown.
  const [resetKey, setResetKey] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [recentSearches, { addRecentSearch, removeRecentSearch }] = useRecentSearches();

  // Suggestions follow the explorer's semantic mode so the two stay consistent.
  const { data, loading, error } = useSearchService({ searchQuery: query ?? '', semantic });

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

  const handleClear = useCallback(() => {
    setQuery(null);

    if (onMemory) {
      setSearchParams(
        (params) => {
          params.delete('search');

          return params;
        },
        { replace: true },
      );
    }
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

  useKeyboardShortcut('/', () => inputRef.current?.focus());

  return (
    <SearchBox
      key={resetKey}
      ref={inputRef}
      defaultQuery={onMemory ? urlSearch : undefined}
      onSearch={handleSearch}
      onSubmit={({ query: submitted }) => commitSearch(submitted)}
      onClear={handleClear}
      onResultSelect={handleResultSelect}
      variant="compact"
      placeholder="Search"
      autoSubmit
      autoSubmitEmpty={onMemory}
      displayResults
      openOnFocus
      loading={loading}
      error={error}
      results={results}
    />
  );
}

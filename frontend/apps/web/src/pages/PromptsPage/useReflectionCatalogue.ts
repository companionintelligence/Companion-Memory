import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { fetchJson } from '@ci/common';

import { useSessionAuth } from '@/hooks';

import {
  type AnswerTier,
  type CatalogueAnswered,
  type CatalogueFilters,
  type CataloguePage,
  type CatalogueStatus,
  DEFAULT_CATALOGUE_FILTERS,
  catalogueUrl,
} from './catalogue';

/** How long the search box sits still before it costs a round-trip. */
export const SEARCH_DEBOUNCE_MS = 300;

export interface ReflectionDraft {
  text: string;
  category: string | null;
  answerTier: AnswerTier | null;
}

interface State {
  page: CataloguePage | null;
  loading: boolean;
  /** Set while a create/edit/deactivate is in flight, keyed by reflection id. */
  savingId: string | null;
  error: string | null;
  filters: CatalogueFilters;
  /** The raw search box value, before debouncing into `filters.search`. */
  searchInput: string;
}

export interface ReflectionCatalogueActions {
  setSearch: (value: string) => void;
  setCategory: (value: string | null) => void;
  setAnswerTier: (value: AnswerTier | null) => void;
  setStatus: (value: CatalogueStatus) => void;
  setAnswered: (value: CatalogueAnswered) => void;
  goToPage: (offset: number) => void;
  refresh: () => void;
  create: (draft: ReflectionDraft) => Promise<void>;
  update: (id: string, draft: ReflectionDraft) => Promise<void>;
  setActive: (id: string, isActive: boolean) => Promise<void>;
}

function authHeaders(sessionHeaders: Record<string, string>): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...sessionHeaders,
  };
}

function message(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/**
 * Browse and edit the reflection catalogue.
 *
 * Filters other than paging reset the offset — landing on page 12 of a
 * three-page result is the classic way a filtered list looks empty when it is
 * not. Writes re-fetch the current page rather than patching local state, so
 * facet counts and the answered/unanswered split stay honest.
 */
export function useReflectionCatalogue(): [State, ReflectionCatalogueActions] {
  // `ready`, not `authToken`: the token is the web JWT, which the native shell never has — its
  // credential is a keystore API key that `fetchJson` attaches as `x-api-key`. Gating on the token
  // left the list on skeletons forever (`loading` starts true) and a new reflection never refreshed it.
  const { ready, headers: sessionHeaders } = useSessionAuth();

  const [state, setState] = useState<State>({
    page: null,
    loading: true,
    savingId: null,
    error: null,
    filters: DEFAULT_CATALOGUE_FILTERS,
    searchInput: DEFAULT_CATALOGUE_FILTERS.search,
  });

  const [reloadToken, setReloadToken] = useState(0);

  // Only the newest request may write to state: filters change faster than the
  // network answers, and an out-of-order response would show the wrong page.
  const requestRef = useRef(0);

  const { filters, searchInput } = state;

  useEffect(() => {
    if (searchInput === filters.search) {
      return;
    }

    const timer = setTimeout(() => {
      setState((prev) => ({
        ...prev,
        filters: { ...prev.filters, search: prev.searchInput, offset: 0 },
      }));
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [searchInput, filters.search]);

  useEffect(() => {
    if (!ready) {
      return;
    }

    const requestId = requestRef.current + 1;
    requestRef.current = requestId;

    let cancelled = false;

    setState((prev) => ({ ...prev, loading: true, error: null }));

    fetchJson<CataloguePage>(catalogueUrl(filters), { headers: authHeaders(sessionHeaders) })
      .then((page) => {
        if (cancelled || requestRef.current !== requestId || !page) {
          return;
        }

        setState((prev) => ({ ...prev, page, loading: false, error: null }));
      })
      .catch((err: unknown) => {
        if (cancelled || requestRef.current !== requestId) {
          return;
        }

        setState((prev) => ({
          ...prev,
          loading: false,
          error: message(err, 'Could not load the reflection catalogue.'),
        }));
      });

    return () => {
      cancelled = true;
    };
  }, [ready, sessionHeaders, filters, reloadToken]);

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  const write = useCallback(
    async (id: string | null, path: string, method: 'POST' | 'PATCH', body: unknown, fallback: string) => {
      setState((prev) => ({ ...prev, savingId: id ?? 'new', error: null }));

      try {
        await fetchJson(path, {
          method,
          headers: authHeaders(sessionHeaders),
          body: JSON.stringify(body),
        });
      } catch (err) {
        setState((prev) => ({ ...prev, savingId: null }));

        throw new Error(message(err, fallback));
      }

      setState((prev) => ({ ...prev, savingId: null }));
      refresh();
    },
    [sessionHeaders, refresh],
  );

  const actions = useMemo<ReflectionCatalogueActions>(
    () => ({
      setSearch: (value) => setState((prev) => ({ ...prev, searchInput: value })),
      setCategory: (value) =>
        setState((prev) => ({ ...prev, filters: { ...prev.filters, category: value, offset: 0 } })),
      setAnswerTier: (value) =>
        setState((prev) => ({ ...prev, filters: { ...prev.filters, answerTier: value, offset: 0 } })),
      setStatus: (value) =>
        setState((prev) => ({ ...prev, filters: { ...prev.filters, status: value, offset: 0 } })),
      setAnswered: (value) =>
        setState((prev) => ({ ...prev, filters: { ...prev.filters, answered: value, offset: 0 } })),
      goToPage: (offset) =>
        setState((prev) => ({ ...prev, filters: { ...prev.filters, offset: Math.max(0, offset) } })),
      refresh,
      create: (draft) =>
        write(
          null,
          '/api/questions',
          'POST',
          {
            text: draft.text,
            ...(draft.category ? { category: draft.category } : {}),
            ...(draft.answerTier ? { answerTier: draft.answerTier } : {}),
          },
          'Could not create the reflection.',
        ),
      update: (id, draft) =>
        write(
          id,
          `/api/questions/${id}`,
          'PATCH',
          {
            text: draft.text,
            ...(draft.category ? { category: draft.category } : {}),
            answerTier: draft.answerTier,
          },
          'Could not save the reflection.',
        ),
      // Deactivation, not deletion: ci.answers and ci.feed_queue both cascade
      // from ci.questions, so removing a reflection would take real answers with
      // it. An inactive reflection stops being asked and keeps its history.
      setActive: (id, isActive) =>
        write(
          id,
          `/api/questions/${id}`,
          'PATCH',
          { isActive },
          isActive ? 'Could not reactivate the reflection.' : 'Could not deactivate the reflection.',
        ),
    }),
    [refresh, write],
  );

  return [state, actions];
}

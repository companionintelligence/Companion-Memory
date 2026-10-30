import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { countLocal, listLocal, LOCAL_LIST_PAGE_SIZE, type LocalListSort } from '@/api/powersync/localList';
import type { LocalDocument } from '@/api/powersync/localSearch';
import { getReplicaDatabase } from '@/api/powersync/session';
import { savedRecordRoute } from '@/components/SearchBox/entityRoute';
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat';
import {
  Empty,
  ErrorState,
  ListSkeleton,
  formatLoadedCount,
  formatRowTime,
} from '@/pages/MemoryPage/Components';

import { LocalDocumentRow } from './LocalDocumentRow';
import { localListOptionsFromParams } from './localListParams';

interface ListState {
  /** The filter set these rows answer; rows for another are never shown. */
  key: string;
  documents: LocalDocument[];
  /** How many match in all; null until the (separate, slower) count lands. */
  totalCount: number | null;
  /** The last page came back short, so there is no next one. */
  exhausted: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: Error | null;
}

/**
 * The everything browse answered from this phone: the records the device has
 * synced (`mobile_search_documents`), filtered by the same URL the appliance's
 * ExploreView reads, in relevance or time order, paged on scroll.
 *
 * Rendered by ExploreView in place of the appliance's list when the Memory
 * server does not answer (see ExploreView's `answersFromDevice`), so "Search
 * all of Memory for …" lands somewhere offline. Says so at the top: a stale
 * local answer must never pass for the server's. Filters the device cannot
 * apply are named rather than silently dropped.
 *
 * A tap opens the offline record page for the row (plan U4).
 */
export function LocalListView({ sort }: { sort?: LocalListSort } = {}) {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const fmt = useDateTimeFormat();

  // `sort` is a view's own order (the timeline tab is a chronology whatever the
  // URL says); otherwise the URL's.
  const options = useMemo(() => {
    const parsed = localListOptionsFromParams(searchParams, pathname);

    return sort ? { ...parsed, query: { ...parsed.query, sort } } : parsed;
  }, [searchParams, pathname, sort]);
  const key = JSON.stringify(options.query);

  const [state, setState] = useState<ListState>({
    key: '',
    documents: [],
    totalCount: null,
    exhausted: false,
    loading: true,
    loadingMore: false,
    error: null,
  });
  // Bumped by Retry so the effect below runs again for the same filters.
  const [attempt, setAttempt] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // First page whenever the filters change.
  useEffect(() => {
    const database = getReplicaDatabase();

    if (options.nothingLeft || database == null) {
      setState({
        key,
        documents: [],
        totalCount: 0,
        exhausted: true,
        loading: false,
        loadingMore: false,
        error: null,
      });

      return;
    }

    let cancelled = false;

    setState((previous) => ({ ...previous, key, loading: true, error: null }));

    // The page first; the count follows on its own, since over a date range it
    // is a walk of every matching row and the rows must not wait for it.
    listLocal(database, options.query, { limit: LOCAL_LIST_PAGE_SIZE, offset: 0 })
      .then((page) => {
        if (cancelled) {
          return;
        }

        setState({
          key,
          documents: page.documents,
          totalCount: null,
          exhausted: page.documents.length < LOCAL_LIST_PAGE_SIZE,
          loading: false,
          loadingMore: false,
          error: null,
        });

        return countLocal(database, options.query).then((totalCount) => {
          if (!cancelled) {
            setState((previous) => (previous.key === key ? { ...previous, totalCount } : previous));
          }
        });
      })
      .catch((error: unknown) => {
        console.warn('[memory] On-device list failed', error);

        if (!cancelled) {
          setState({
            key,
            documents: [],
            totalCount: 0,
            exhausted: true,
            loading: false,
            loadingMore: false,
            error: error instanceof Error ? error : new Error('On-device list failed'),
          });
        }
      });

    return () => {
      cancelled = true;
    };
    // `key` is `options.query` serialised, so the query itself is not a dependency.
  }, [key, options.nothingLeft, attempt]);

  const current = state.key === key && !state.loading;
  const documents = current ? state.documents : [];
  const hasNextPage = current && !state.exhausted;

  const loadMore = useCallback(() => {
    const database = getReplicaDatabase();

    if (!hasNextPage || state.loadingMore || database == null) {
      return;
    }

    setState((previous) => ({ ...previous, loadingMore: true }));

    listLocal(database, options.query, { limit: LOCAL_LIST_PAGE_SIZE, offset: state.documents.length })
      .then((page) => {
        setState((previous) =>
          previous.key === key
            ? {
                ...previous,
                documents: [...previous.documents, ...page.documents],
                exhausted: page.documents.length < LOCAL_LIST_PAGE_SIZE,
                loadingMore: false,
              }
            : previous,
        );
      })
      .catch((error: unknown) => {
        console.warn('[memory] On-device list page failed', error);
        setState((previous) => ({ ...previous, loadingMore: false }));
      });
  }, [hasNextPage, key, options.query, state.documents.length, state.loadingMore]);

  // Next page when the sentinel scrolls into view, as the appliance's list does.
  useEffect(() => {
    const sentinel = sentinelRef.current;

    if (!sentinel || !hasNextPage) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          loadMore();
        }
      },
      { root: scrollRef.current, rootMargin: '400px' },
    );

    observer.observe(sentinel);

    return () => observer.disconnect();
  }, [hasNextPage, loadMore]);

  // Every row opens the record this phone holds (pages/LocalRecordPage),
  // which has a page for every type; the per-type pages need the appliance.
  const open = (document: LocalDocument) =>
    navigate(savedRecordRoute(document.entityType, document.entityId));

  const caption = (
    <div className="px-2 pb-1 pt-2 text-xs text-muted-foreground" data-testid="local-list-caption">
      <span className="font-medium text-foreground">{t('MEMORY_LOCAL_LIST_HEADING')}</span>
      {' · '}
      {t('MEMORY_LOCAL_LIST_DESCRIPTION')}
      {options.ignored.length > 0 && <> {t('MEMORY_LOCAL_LIST_FILTERS_IGNORED')}</>}
    </div>
  );

  if (!current) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" data-list-scroll="">
        {caption}
        <ListSkeleton count={10} />
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" data-list-scroll="">
        {caption}
        <ErrorState
          title={t('MEMORY_LOCAL_READ_FAILED_TITLE')}
          description={t('MEMORY_LOCAL_READ_FAILED_DESCRIPTION')}
          onRetry={() => setAttempt((n) => n + 1)}
        />
      </div>
    );
  }

  if (documents.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" data-list-scroll="">
        {caption}
        <Empty
          title={t('MEMORY_LOCAL_LIST_EMPTY_TITLE')}
          description={t('MEMORY_LOCAL_LIST_EMPTY_DESCRIPTION')}
          icon="📱"
        />
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" data-list-scroll="">
      {caption}
      <div className="flex flex-col">
        {documents.map((document) => (
          <LocalDocumentRow
            key={document.id}
            document={document}
            time={formatRowTime(document.occurredAt ? new Date(document.occurredAt) : null, fmt)}
            onClick={() => open(document)}
          />
        ))}
      </div>

      {state.loadingMore && <ListSkeleton count={3} showHeader={false} />}

      {hasNextPage && <div ref={sentinelRef} className="h-8" />}

      <div className="py-3 text-center text-xs text-muted-foreground">
        {formatLoadedCount({
          loaded: documents.length,
          // 0 reads as "not supplied" there, which is right while the count is still running.
          totalCount: state.totalCount ?? 0,
          loadingMore: state.loadingMore,
          hasNextPage,
        })}
      </div>
    </div>
  );
}

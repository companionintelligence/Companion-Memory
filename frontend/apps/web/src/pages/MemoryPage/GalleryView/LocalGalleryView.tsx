import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Image } from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { listLocal, LOCAL_LIST_PAGE_SIZE } from '@/api/powersync/localList';
import type { LocalDocument } from '@/api/powersync/localSearch';
import { isPreviewSyncEnabled, previewSources } from '@/api/powersync/previews';
import { getReplicaDatabase } from '@/api/powersync/session';
import { EntityGrid } from '@/components/entities/EntityGrid';
import { PendingImage } from '@/components/PendingImage';
import { savedRecordRoute } from '@/components/SearchBox/entityRoute';
import { Empty, ErrorState } from '@/pages/MemoryPage/Components';

import { localListOptionsFromParams } from '../LocalListView/localListParams';

interface GridState {
  key: string;
  documents: LocalDocument[];
  sources: Map<string, string>;
  exhausted: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: boolean;
}

/** A document's preview key, when it names one. */
function previewIdOf(document: LocalDocument): string | null {
  const id = document.detail?.preview_id;

  return typeof id === 'string' ? id : null;
}

/**
 * The gallery while the Memory server does not answer: the photos and videos
 * this phone's replica names a preview for, newest first, drawn from the
 * preview store (previews.ts). Same URL filters as the offline list. A tile
 * whose preview has not arrived yet shows the picture glyph; a tap opens the
 * saved record page, which shows the preview large. No lightbox: the full
 * media is the appliance's.
 */
export function LocalGalleryView() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { pathname } = useLocation();
  const options = useMemo(() => {
    const parsed = localListOptionsFromParams(searchParams, pathname);

    return { ...parsed, query: { ...parsed.query, hasPreview: true, sort: 'newest' as const } };
  }, [searchParams, pathname]);
  const key = JSON.stringify(options.query);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<GridState>({
    key: '',
    documents: [],
    sources: new Map(),
    exhausted: false,
    loading: true,
    loadingMore: false,
    error: false,
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const database = getReplicaDatabase();

    if (database == null) {
      setState({
        key,
        documents: [],
        sources: new Map(),
        exhausted: true,
        loading: false,
        loadingMore: false,
        error: true,
      });

      return;
    }

    let cancelled = false;

    setState((previous) => ({ ...previous, key, loading: true, error: false }));

    listLocal(database, options.query)
      .then(async ({ documents }) => {
        const sources = await previewSources(
          database,
          documents.map(previewIdOf).filter((id): id is string => id != null),
        );

        if (!cancelled) {
          setState({
            key,
            documents,
            sources,
            exhausted: documents.length < LOCAL_LIST_PAGE_SIZE,
            loading: false,
            loadingMore: false,
            error: false,
          });
        }
      })
      .catch((error: unknown) => {
        console.warn('[memory] On-device gallery failed', error);

        if (!cancelled) {
          setState((previous) => ({ ...previous, key, loading: false, error: true }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [attempt, key, options.query]);

  const hasNextPage = !state.exhausted && !state.loading && !state.error;

  const loadMore = useCallback(() => {
    const database = getReplicaDatabase();

    if (database == null || state.loadingMore || !hasNextPage) {
      return;
    }

    setState((previous) => ({ ...previous, loadingMore: true }));

    listLocal(database, options.query, { offset: state.documents.length })
      .then(async (page) => {
        const sources = await previewSources(
          database,
          page.documents.map(previewIdOf).filter((id): id is string => id != null),
        );

        setState((previous) =>
          previous.key === key
            ? {
                ...previous,
                documents: [...previous.documents, ...page.documents],
                sources: new Map([...previous.sources, ...sources]),
                exhausted: page.documents.length < LOCAL_LIST_PAGE_SIZE,
                loadingMore: false,
              }
            : previous,
        );
      })
      .catch((error: unknown) => {
        console.warn('[memory] On-device gallery page failed', error);
        setState((previous) => ({ ...previous, loadingMore: false }));
      });
  }, [hasNextPage, key, options.query, state.documents.length, state.loadingMore]);

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
      { root: scrollRef.current, rootMargin: '600px' },
    );

    observer.observe(sentinel);

    return () => observer.disconnect();
  }, [hasNextPage, loadMore]);

  const caption = (
    <div className="px-2 pb-1 pt-2 text-xs text-muted-foreground" data-testid="local-gallery-caption">
      <span className="font-medium text-foreground">{t('MEMORY_LOCAL_LIST_HEADING')}</span>
      {' · '}
      {isPreviewSyncEnabled()
        ? t('MEMORY_LOCAL_GALLERY_DESCRIPTION')
        : t('MEMORY_LOCAL_GALLERY_DESCRIPTION_OFF')}
    </div>
  );

  if (state.loading && state.documents.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" data-list-scroll="">
        {caption}
        <EntityGrid>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-full w-full animate-pulse rounded-lg border bg-card" />
          ))}
        </EntityGrid>
      </div>
    );
  }

  if (state.error && state.documents.length === 0) {
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

  if (state.documents.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" data-list-scroll="">
        {caption}
        <Empty
          title={t('MEMORY_LOCAL_GALLERY_EMPTY_TITLE')}
          description={t('MEMORY_LOCAL_LIST_EMPTY_DESCRIPTION')}
        />
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" data-list-scroll="">
      {caption}
      <EntityGrid>
        {state.documents.map((document) => {
          const previewId = previewIdOf(document);
          const src = previewId ? state.sources.get(previewId) : undefined;
          const title = document.title || t('MEMORY_LOCAL_GALLERY_UNTITLED');

          return (
            <button
              key={document.id}
              type="button"
              aria-label={title}
              onClick={() => navigate(savedRecordRoute(document.entityType, document.entityId))}
              className="group relative flex h-full w-full flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-md"
              data-testid="local-gallery-tile"
            >
              {src ? (
                <PendingImage src={src} />
              ) : (
                <span className="flex h-full w-full items-center justify-center bg-muted text-muted-foreground">
                  <Image className="size-6" strokeWidth={1.5} aria-hidden />
                </span>
              )}
            </button>
          );
        })}
      </EntityGrid>
      {hasNextPage && <div ref={sentinelRef} className="h-px" />}
      {state.loadingMore && <div className="py-3 text-center text-xs text-muted-foreground">…</div>}
    </div>
  );
}

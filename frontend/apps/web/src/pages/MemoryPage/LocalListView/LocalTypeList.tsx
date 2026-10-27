import { useCallback, useEffect, useState } from 'react';

import { usePageTitle } from '@ci/common';
import { Button } from '@ci/shadcn';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';

import type { LocalDocument } from '@/api/powersync/localSearch';
import {
  countLocalByType,
  listLocalByType,
  LOCAL_TYPE_LIST_PAGE_SIZE,
  type LocalTypeOrder,
} from '@/api/powersync/localTypeList';
import { getReplicaDatabase } from '@/api/powersync/session';
import { ErrorState } from '@/components/ErrorState';
import { PageContent } from '@/components/layout';
import { MemoryHubShell } from '@/components/MemoryHub';
import { savedRecordRoute } from '@/components/SearchBox/entityRoute';
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat';
import { Empty, ListSkeleton, formatRowTime } from '@/pages/MemoryPage/Components';

import { LocalDocumentRow } from './LocalDocumentRow';

export interface LocalTypeListProps {
  /** The device-record type the page lists (`place`, `item`, `receipt`, `content`). */
  entityType: string;
  /** The page's own heading, as the appliance's page shows it ("Places"). */
  heading: string;
  /** The document title, as the appliance's page sets it. */
  pageTitle: string;
  /** Browse order while there is no query: by name for the small sets, newest first for the bulk ones. */
  order: LocalTypeOrder;
  /**
   * The URL parameters whose text is the query, first found wins. The header box writes
   * `search` on these pages; the receipts page also has its own `q`.
   */
  searchParams?: readonly string[];
}

interface ListState {
  key: string;
  documents: LocalDocument[];
  totalCount: number | null;
  exhausted: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: boolean;
}

/**
 * A per-type page (places, things, receipts, content) while the Memory server does not
 * answer: the records of that one type this phone has synced, browsed in the type's order
 * or ranked for the header box's query. Each row opens the saved record page. Everything
 * the appliance's page adds on top -- duplicates, facets, pins on a map, bulk actions --
 * is the appliance's; the list says so at the top.
 */
export function LocalTypeList({
  entityType,
  heading,
  pageTitle,
  order,
  searchParams: queryParams = ['search'],
}: LocalTypeListProps) {
  usePageTitle(pageTitle);

  const { t } = useTranslation();
  const navigate = useNavigate();
  const fmt = useDateTimeFormat();
  const [searchParams] = useSearchParams();
  const query = (
    queryParams.map((name) => searchParams.get(name)).find((value) => value?.trim()) ?? ''
  ).trim();
  const key = `${entityType}\u0000${query}`;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ListState>({
    key: '',
    documents: [],
    totalCount: null,
    exhausted: false,
    loading: true,
    loadingMore: false,
    error: false,
  });

  useEffect(() => {
    const database = getReplicaDatabase();

    if (database == null) {
      setState({
        key,
        documents: [],
        totalCount: 0,
        exhausted: true,
        loading: false,
        loadingMore: false,
        error: true,
      });

      return;
    }

    let cancelled = false;

    setState((previous) => ({ ...previous, key, loading: true, error: false }));

    Promise.all([
      listLocalByType(database, entityType, order, query),
      countLocalByType(database, entityType, query),
    ])
      .then(([documents, totalCount]) => {
        if (!cancelled) {
          setState({
            key,
            documents,
            totalCount,
            exhausted: documents.length < LOCAL_TYPE_LIST_PAGE_SIZE,
            loading: false,
            loadingMore: false,
            error: false,
          });
        }
      })
      .catch((error: unknown) => {
        console.warn(`[memory] On-device ${entityType} list failed`, error);

        if (!cancelled) {
          setState((previous) => ({ ...previous, key, loading: false, error: true }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [attempt, entityType, key, order, query]);

  const loadMore = useCallback(() => {
    const database = getReplicaDatabase();

    if (database == null || state.loadingMore || state.exhausted) {
      return;
    }

    setState((previous) => ({ ...previous, loadingMore: true }));

    listLocalByType(database, entityType, order, query, { offset: state.documents.length })
      .then((page) => {
        setState((previous) =>
          previous.key === key
            ? {
                ...previous,
                documents: [...previous.documents, ...page],
                exhausted: page.length < LOCAL_TYPE_LIST_PAGE_SIZE,
                loadingMore: false,
              }
            : previous,
        );
      })
      .catch((error: unknown) => {
        console.warn(`[memory] On-device ${entityType} page failed`, error);
        setState((previous) => ({ ...previous, loadingMore: false }));
      });
  }, [entityType, key, order, query, state.documents.length, state.exhausted, state.loadingMore]);

  const caption = (
    <div className="px-1 text-xs text-muted-foreground device:px-0" data-testid="local-type-caption">
      <span className="font-medium text-foreground">{t('MEMORY_LOCAL_LIST_HEADING')}</span>
      {' · '}
      {t('MEMORY_LOCAL_LIST_DESCRIPTION')}
    </div>
  );

  let body: React.ReactNode;

  if (state.loading && state.documents.length === 0) {
    body = <ListSkeleton />;
  } else if (state.error && state.documents.length === 0) {
    body = (
      <ErrorState
        title={t('MEMORY_LOCAL_READ_FAILED_TITLE')}
        description={t('MEMORY_LOCAL_READ_FAILED_DESCRIPTION')}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  } else if (state.documents.length === 0) {
    body = (
      <Empty
        title={t('MEMORY_LOCAL_LIST_EMPTY_TITLE')}
        description={t('MEMORY_LOCAL_LIST_EMPTY_DESCRIPTION')}
      />
    );
  } else {
    body = (
      <>
        <div className="flex flex-col">
          {state.documents.map((document) => (
            <LocalDocumentRow
              key={document.id}
              document={document}
              time={formatRowTime(document.occurredAt ? new Date(document.occurredAt) : null, fmt)}
              onClick={() => navigate(savedRecordRoute(document.entityType, document.entityId))}
            />
          ))}
        </div>

        {!state.exhausted && (
          <div className="flex justify-center">
            <Button variant="outline" size="sm" onClick={loadMore} disabled={state.loadingMore}>
              {state.loadingMore ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        )}
      </>
    );
  }

  return (
    <PageContent className="gap-4 p-0">
      <MemoryHubShell>
        <div className="flex flex-col gap-3 px-2 pb-3 device:gap-4 device:px-4 device:pb-4">
          <div className="flex items-baseline gap-2 px-1 device:px-0">
            <div className="font-medium">{heading}</div>
            {state.totalCount != null && (
              <div className="text-sm tabular-nums text-muted-foreground">
                {state.totalCount.toLocaleString()}
              </div>
            )}
          </div>
          {caption}
          {body}
        </div>
      </MemoryHubShell>
    </PageContent>
  );
}

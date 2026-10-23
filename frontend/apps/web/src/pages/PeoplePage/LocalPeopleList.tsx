import { useCallback, useEffect, useState } from 'react';

import { usePageTitle } from '@ci/common';
import { Button } from '@ci/shadcn';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { countLocalPeople, listLocalPeople, LOCAL_PEOPLE_PAGE_SIZE } from '@/api/powersync/localPeople';
import type { LocalDocument } from '@/api/powersync/localSearch';
import { getReplicaDatabase } from '@/api/powersync/session';
import { ErrorState } from '@/components/ErrorState';
import { PageContent } from '@/components/layout';
import { MemoryHubShell } from '@/components/MemoryHub';
import { PersonAvatar } from '@/components/PersonAvatar';
import { savedRecordRoute } from '@/components/SearchBox/entityRoute';
import { Empty, ListSkeleton } from '@/pages/MemoryPage/Components';

/**
 * The record's text minus the search-only tail: a person's body is their name
 * and then the JSON of their names and addresses the index matches on, which
 * is not a subtitle.
 */
function personSubtitle(person: LocalDocument): string {
  const text = (person.body ?? '').replace(/\s*\{[\s\S]*$/, '').trim();

  return text === (person.title ?? '').trim() ? '' : text;
}

interface ListState {
  key: string;
  people: LocalDocument[];
  totalCount: number | null;
  exhausted: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: boolean;
}

/**
 * The people page while the Memory server does not answer: the person records
 * this phone has synced, by name, or ranked for the header box's `?search=`.
 * Each row opens the saved record page. No merge queue, identifiers or
 * interaction counts — those are the appliance's.
 */
export function LocalPeopleList() {
  usePageTitle('People & communications - Companion Memory');

  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const query = (searchParams.get('search') ?? '').trim();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ListState>({
    key: '',
    people: [],
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
        key: query,
        people: [],
        totalCount: 0,
        exhausted: true,
        loading: false,
        loadingMore: false,
        error: true,
      });

      return;
    }

    let cancelled = false;

    setState((previous) => ({ ...previous, key: query, loading: true, error: false }));

    Promise.all([listLocalPeople(database, query), countLocalPeople(database, query)])
      .then(([people, totalCount]) => {
        if (!cancelled) {
          setState({
            key: query,
            people,
            totalCount,
            exhausted: people.length < LOCAL_PEOPLE_PAGE_SIZE,
            loading: false,
            loadingMore: false,
            error: false,
          });
        }
      })
      .catch((error: unknown) => {
        console.warn('[memory] On-device people failed', error);

        if (!cancelled) {
          setState((previous) => ({ ...previous, key: query, loading: false, error: true }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [attempt, query]);

  const loadMore = useCallback(() => {
    const database = getReplicaDatabase();

    if (database == null || state.loadingMore || state.exhausted) {
      return;
    }

    setState((previous) => ({ ...previous, loadingMore: true }));

    listLocalPeople(database, query, { offset: state.people.length })
      .then((page) => {
        setState((previous) =>
          previous.key === query
            ? {
                ...previous,
                people: [...previous.people, ...page],
                exhausted: page.length < LOCAL_PEOPLE_PAGE_SIZE,
                loadingMore: false,
              }
            : previous,
        );
      })
      .catch((error: unknown) => {
        console.warn('[memory] On-device people page failed', error);
        setState((previous) => ({ ...previous, loadingMore: false }));
      });
  }, [query, state.exhausted, state.loadingMore, state.people.length]);

  const caption = (
    <div className="px-1 text-xs text-muted-foreground device:px-0" data-testid="local-people-caption">
      <span className="font-medium text-foreground">{t('MEMORY_LOCAL_LIST_HEADING')}</span>
      {' · '}
      {t('MEMORY_LOCAL_LIST_DESCRIPTION')}
    </div>
  );

  let body: React.ReactNode;

  if (state.loading && state.people.length === 0) {
    body = <ListSkeleton />;
  } else if (state.error && state.people.length === 0) {
    body = <ErrorState onRetry={() => setAttempt((n) => n + 1)} />;
  } else if (state.people.length === 0) {
    body = (
      <Empty
        title={t('MEMORY_LOCAL_PEOPLE_EMPTY_TITLE')}
        description={t('MEMORY_LOCAL_LIST_EMPTY_DESCRIPTION')}
      />
    );
  } else {
    body = (
      <>
        <div className="flex flex-col gap-2">
          {state.people.map((person) => (
            <button
              key={person.id}
              type="button"
              onClick={() => navigate(savedRecordRoute(person.entityType, person.entityId))}
              className="flex w-full items-center gap-3 rounded-md border bg-card p-3 text-left transition hover:bg-accent"
              data-testid="local-person-row"
            >
              <PersonAvatar name={person.title ?? ''} avatarUrl={null} size="md" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{person.title || 'Unnamed'}</div>
                <div className="truncate text-sm text-muted-foreground">{personSubtitle(person) || '—'}</div>
              </div>
            </button>
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
            <div className="font-medium">People</div>
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

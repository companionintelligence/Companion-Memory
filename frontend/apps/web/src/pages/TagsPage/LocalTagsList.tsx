import { useEffect, useMemo, useState } from 'react';

import { EmptyState, usePageTitle } from '@ci/common';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';

import { listLocalTags, type LocalTag } from '@/api/powersync/localTags';
import { getReplicaDatabase } from '@/api/powersync/session';
import { ErrorState } from '@/components/ErrorState';
import { PageContent } from '@/components/layout';
import { MemoryHubShell } from '@/components/MemoryHub';
import { LoadingRegion, TagRowsSkeleton } from '@/components/MemoryHub/MemoryHubSkeletons';
import { Tag } from '@/components/Tag';

interface ListState {
  tags: LocalTag[];
  loading: boolean;
  error: boolean;
}

/**
 * The tags page while the Memory server does not answer: the tags this phone has synced,
 * with how many records carry each, filtered by the header box's `?search=` like the
 * appliance's page. A tag opens the Memory list filtered to it, which the phone answers
 * too. No rename, merge or delete: those are server writes.
 */
export function LocalTagsList() {
  usePageTitle('Tags - Companion Memory');

  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const searchQuery = (searchParams.get('search') ?? '').trim().toLowerCase();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ListState>({ tags: [], loading: true, error: false });

  useEffect(() => {
    const database = getReplicaDatabase();

    if (database == null) {
      setState({ tags: [], loading: false, error: true });

      return;
    }

    let cancelled = false;

    setState((previous) => ({ ...previous, loading: true, error: false }));

    listLocalTags(database)
      .then((tags) => {
        if (!cancelled) {
          setState({ tags, loading: false, error: false });
        }
      })
      .catch((error: unknown) => {
        console.warn('[memory] On-device tags failed', error);

        if (!cancelled) {
          setState({ tags: [], loading: false, error: true });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const filteredTags = useMemo(
    () => state.tags.filter((tag) => tag.label.toLowerCase().includes(searchQuery)),
    [searchQuery, state.tags],
  );

  const caption = (
    <div className="px-1 text-xs text-muted-foreground device:px-0" data-testid="local-tags-caption">
      <span className="font-medium text-foreground">{t('MEMORY_LOCAL_LIST_HEADING')}</span>
      {' · '}
      {t('MEMORY_LOCAL_LIST_DESCRIPTION')}
    </div>
  );

  let body: React.ReactNode;

  if (state.loading) {
    body = (
      <LoadingRegion label="Loading tags">
        <TagRowsSkeleton />
      </LoadingRegion>
    );
  } else if (state.error) {
    body = (
      <ErrorState
        title={t('MEMORY_LOCAL_READ_FAILED_TITLE')}
        description={t('MEMORY_LOCAL_READ_FAILED_DESCRIPTION')}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  } else if (state.tags.length === 0) {
    body = <EmptyState message={t('MEMORY_LOCAL_TAGS_EMPTY')} />;
  } else if (filteredTags.length === 0) {
    body = <EmptyState message="No tags match your filter." />;
  } else {
    body = (
      <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
        {filteredTags.map((tag) => (
          <li
            key={tag.id}
            data-testid="local-tag-row"
            className="flex items-center gap-2 px-2 py-1.5 device:gap-3 device:px-3 device:py-2"
          >
            <Link
              to={`/memory?tags=${encodeURIComponent(tag.label)}`}
              className="flex min-w-0 flex-1 items-center gap-2 device:gap-3"
            >
              <Tag text={tag.label} className="min-w-0 max-w-full cursor-pointer [&>span]:truncate" />
              {tag.description ? (
                <span className="hidden min-w-0 truncate text-sm text-muted-foreground device:block">
                  {tag.description}
                </span>
              ) : null}
            </Link>

            <span className="shrink-0 text-xs tabular-nums text-muted-foreground device:text-sm">
              {tag.entityCount === 1 ? '1 item' : `${tag.entityCount} items`}
            </span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <PageContent className="gap-2 p-0 device:gap-4">
      <MemoryHubShell>
        <div className="flex flex-col gap-2 px-2 pb-3 device:gap-4 device:px-4 device:pb-4">
          {caption}
          {body}
        </div>
      </MemoryHubShell>
    </PageContent>
  );
}

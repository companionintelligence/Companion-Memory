import { useCallback, useEffect, useState } from 'react';

import { EmptyState, LoadingPage, useConnectionMode, usePageTitle } from '@ci/common';
import { Badge, Button, Card, cn } from '@ci/shadcn';
import { ArrowLeft, Smartphone } from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';

import {
  countSiblings,
  getLocalDocument,
  getLocalDocumentByEntityId,
  listSiblings,
  SIBLINGS_PAGE_SIZE,
} from '@/api/powersync/localRecord';
import type { LocalDocument } from '@/api/powersync/localSearch';
import { previewSources } from '@/api/powersync/previews';
import { getReplicaDatabase } from '@/api/powersync/session';
import { EntityFieldsCard, formatEntityTimestamp } from '@/components/EntityFields';
import { ErrorState } from '@/components/ErrorState';
import { PageContent } from '@/components/layout';
import { routeForEntity, savedRecordRoute } from '@/components/SearchBox/entityRoute';
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat';
import {
  LocalDocumentRow,
  localDocumentIcon,
  localDocumentLines,
} from '@/pages/MemoryPage/LocalListView/LocalDocumentRow';

import { detailRows, recordTypeLabel } from './recordDetail';

interface Conversation {
  before: LocalDocument[];
  after: LocalDocument[];
  total: number;
  moreBefore: boolean;
  moreAfter: boolean;
}

type Loaded =
  | { state: 'loading' }
  | { state: 'missing' }
  | { state: 'error'; error: Error }
  | {
      state: 'ready';
      document: LocalDocument;
      parent: LocalDocument | null;
      conversation: Conversation | null;
    };

/**
 * The record this phone holds for an entity, at `/memory/saved/:type/:id`:
 * the synced search document's title, text, time and per-type detail, with
 * a banner saying it is the phone's copy. Where a result or list row opens
 * while the Memory server does not answer, for every type alike; once
 * connected, "Open full record" leads to the type's own page.
 *
 * A message shows its conversation: the siblings that share its
 * `related_id` (the server's conversation key), in time order, a window of
 * twenty either side that extends on request. Any other record that belongs
 * with one (a sub-event, a file in a folder, content from an event) links to
 * that record when the phone holds it too.
 */
/**
 * The record's photo preview from this phone's store (previews.ts), when the
 * record names one and the file has arrived; null otherwise.
 */
function usePreviewUrl(document: LocalDocument | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const previewId = typeof document?.detail?.preview_id === 'string' ? document.detail.preview_id : null;

  useEffect(() => {
    const database = getReplicaDatabase();

    setUrl(null);

    if (previewId == null || database == null) {
      return;
    }

    let cancelled = false;

    void previewSources(database, [previewId])
      .then((sources) => {
        if (!cancelled) {
          setUrl(sources.get(previewId) ?? null);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [previewId]);

  return url;
}

export function LocalRecordPage() {
  const { type = '', id = '' } = useParams<{ type: string; id: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const fmt = useDateTimeFormat();
  const { mode } = useConnectionMode();
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const database = getReplicaDatabase();

    if (!database || !type || !id) {
      setLoaded({ state: 'missing' });

      return;
    }

    let cancelled = false;

    setLoaded({ state: 'loading' });

    (async () => {
      const document = await getLocalDocument(database, type, id);

      if (!document) {
        return { state: 'missing' } as const;
      }

      let parent: LocalDocument | null = null;
      let conversation: Conversation | null = null;

      if (document.relatedId && document.entityType === 'communication') {
        const cursor = { occurredAt: document.occurredAt, id: document.id };
        const [before, after, total] = await Promise.all([
          listSiblings(database, document.relatedId, 'before', cursor),
          listSiblings(database, document.relatedId, 'after', cursor),
          countSiblings(database, document.relatedId),
        ]);

        conversation = {
          before,
          after,
          total,
          moreBefore: before.length === SIBLINGS_PAGE_SIZE,
          moreAfter: after.length === SIBLINGS_PAGE_SIZE,
        };
      } else if (document.relatedId) {
        parent = await getLocalDocumentByEntityId(database, document.relatedId);
      }

      return { state: 'ready', document, parent, conversation } as const;
    })()
      .then((next) => {
        if (!cancelled) {
          setLoaded(next);
        }
      })
      .catch((error: unknown) => {
        console.warn('[memory] On-device record failed', error);

        if (!cancelled) {
          setLoaded({
            state: 'error',
            error: error instanceof Error ? error : new Error('On-device record failed'),
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [type, id, attempt]);

  const extend = useCallback(
    async (side: 'before' | 'after') => {
      const database = getReplicaDatabase();

      if (loaded.state !== 'ready' || !loaded.conversation || !database) {
        return;
      }

      const { conversation, document } = loaded;
      const relatedId = document.relatedId;

      if (!relatedId) {
        return;
      }

      const edge =
        side === 'before' ? conversation.before[0] : conversation.after[conversation.after.length - 1];
      const cursor = edge
        ? { occurredAt: edge.occurredAt, id: edge.id }
        : { occurredAt: document.occurredAt, id: document.id };
      const more = await listSiblings(database, relatedId, side, cursor);

      setLoaded((current) => {
        if (current.state !== 'ready' || !current.conversation) {
          return current;
        }

        const next = { ...current.conversation };

        if (side === 'before') {
          next.before = [...more, ...next.before];
          next.moreBefore = more.length === SIBLINGS_PAGE_SIZE;
        } else {
          next.after = [...next.after, ...more];
          next.moreAfter = more.length === SIBLINGS_PAGE_SIZE;
        }

        return { ...current, conversation: next };
      });
    },
    [loaded],
  );

  const document = loaded.state === 'ready' ? loaded.document : null;
  // Before the early returns below: a hook.
  const previewUrl = usePreviewUrl(document);
  const lines = document ? localDocumentLines(document) : null;

  usePageTitle(lines ? `${lines.title} - Companion Memory` : 'Saved record - Companion Memory');

  if (loaded.state === 'loading') {
    return <LoadingPage />;
  }

  if (loaded.state === 'error') {
    return <ErrorState onRetry={() => setAttempt((n) => n + 1)} />;
  }

  if (loaded.state === 'missing' || !document || !lines) {
    return (
      <PageContent>
        <BackButton label={t('MEMORY_RECORD_BACK')} onClick={() => navigate(-1)} />
        <EmptyState
          icon={<Smartphone size={48} />}
          message={
            <div>
              <div className="font-medium">{t('MEMORY_RECORD_NOT_FOUND_TITLE')}</div>
              <div className="text-muted-foreground">{t('MEMORY_RECORD_NOT_FOUND_DESCRIPTION')}</div>
            </div>
          }
        />
      </PageContent>
    );
  }

  const fullRecord =
    mode === 'connected'
      ? routeForEntity(document.entityType, document.entityId, { title: lines.title })
      : null;
  const rows = detailRows(document.detail, fmt);
  const { conversation, parent } = loaded;

  return (
    <PageContent>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <BackButton label={t('MEMORY_RECORD_BACK')} onClick={() => navigate(-1)} />
        <Badge variant="secondary" className="gap-1" data-testid="saved-banner">
          <Smartphone className="h-3 w-3" />
          {t('MEMORY_RECORD_SAVED_BANNER')}
        </Badge>
      </div>

      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 [&>svg]:h-6 [&>svg]:w-6">{localDocumentIcon(document.entityType)}</span>
        <h1 className="min-w-0 break-words text-2xl font-bold">{lines.title}</h1>
      </div>

      <p className="text-sm text-muted-foreground">{t('MEMORY_RECORD_SAVED_DESCRIPTION')}</p>

      {previewUrl && (
        <img
          src={previewUrl}
          alt=""
          className="max-h-80 w-full rounded-lg border bg-muted object-contain"
          data-testid="saved-preview"
        />
      )}

      {fullRecord && (
        <div>
          <Button asChild variant="outline" size="sm">
            <Link to={fullRecord}>{t('MEMORY_RECORD_OPEN_FULL')}</Link>
          </Button>
        </div>
      )}

      <EntityFieldsCard
        title={recordTypeLabel(document.entityType)}
        editMode={false}
        resetKey={document.id}
        fields={
          document.body
            ? [{ key: 'body', label: t('MEMORY_RECORD_TEXT'), value: document.body, multiline: true }]
            : []
        }
        metaItems={[
          { label: 'Type', value: recordTypeLabel(document.entityType) },
          { label: 'When', value: formatEntityTimestamp(document.occurredAt, fmt) },
          ...rows.map((row) => ({ label: row.label, value: row.value })),
        ]}
      />

      {parent && (
        <Card className="p-3">
          <div className="mb-1 text-xs font-medium uppercase text-muted-foreground">
            {t('MEMORY_RECORD_PART_OF')}
          </div>
          <LocalDocumentRow
            document={parent}
            time={formatEntityTimestamp(parent.occurredAt, fmt) ?? undefined}
            onClick={() => navigate(savedRecordRoute(parent.entityType, parent.entityId))}
          />
        </Card>
      )}

      {conversation && (
        <Card className="p-3" data-testid="conversation">
          <div className="mb-1 flex items-baseline justify-between">
            <div className="text-xs font-medium uppercase text-muted-foreground">
              {t('MEMORY_RECORD_CONVERSATION')}
            </div>
            <div className="text-xs text-muted-foreground">{conversation.total.toLocaleString()}</div>
          </div>
          {conversation.moreBefore && (
            <Button variant="ghost" size="sm" onClick={() => void extend('before')}>
              {t('MEMORY_RECORD_SHOW_EARLIER')}
            </Button>
          )}
          <div className="flex flex-col">
            {[...conversation.before, document, ...conversation.after].map((sibling) => (
              <LocalDocumentRow
                key={sibling.id}
                document={sibling}
                time={formatEntityTimestamp(sibling.occurredAt, fmt) ?? undefined}
                onClick={
                  sibling.id === document.id
                    ? undefined
                    : () => navigate(savedRecordRoute(sibling.entityType, sibling.entityId))
                }
                className={cn(sibling.id === document.id && 'bg-accent/40')}
              />
            ))}
          </div>
          {conversation.moreAfter && (
            <Button variant="ghost" size="sm" onClick={() => void extend('after')}>
              {t('MEMORY_RECORD_SHOW_LATER')}
            </Button>
          )}
        </Card>
      )}
    </PageContent>
  );
}

function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" onClick={onClick} className="gap-1 px-2">
      <ArrowLeft className="h-4 w-4" />
      {label}
    </Button>
  );
}

export default LocalRecordPage;

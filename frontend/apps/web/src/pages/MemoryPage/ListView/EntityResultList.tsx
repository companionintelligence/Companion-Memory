import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';

import { useLocation } from 'react-router-dom';

import { MemoryChatAbout } from '@/components/ChatWithAgent';
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat';
import {
  DateGroupHeader,
  ErrorState,
  ListSkeleton,
  formatLoadedCount,
  formatRowTime,
  getEntityTimestamp,
  groupEntitiesByBucket,
} from '@/pages/MemoryPage/Components';

import { useEntityService, type EntityItem } from '../useEntityService';

import { AnswerRow } from './rows/AnswerRow';
import { BrowserActivityRow } from './rows/BrowserActivityRow';
import { CommunicationRow } from './rows/CommunicationRow';
import { ConceptRow } from './rows/ConceptRow';
import { ContentRow } from './rows/ContentRow';
import { EventRow } from './rows/EventRow';
import { FileChunkRow } from './rows/FileChunkRow';
import { FileRow } from './rows/FileRow';
import { ItemRow } from './rows/ItemRow';
import { NoteRow } from './rows/NoteRow';
import { PersonRow } from './rows/PersonRow';
import { PlaceRow } from './rows/PlaceRow';
import { ProductRow } from './rows/ProductRow';
import { ReceiptRow } from './rows/ReceiptRow';
import { ThreadRow } from './rows/ThreadRow';

/**
 * Where the list was scrolled to, per history entry (`location.key`), for the
 * life of the tab. The list scrolls inside its own box rather than the window,
 * so the browser's own scroll restoration never sees it, and opening a full
 * page unmounts it. Back to the same entry puts the list where it was.
 */
const scrollTopByHistoryEntry = new Map<string, number>();

/**
 * The scrolling result list every list-shaped explorer view is built on: the
 * per-type rows, cursor paging on scroll, and the skeleton / error / empty
 * states. `grouped` puts date headings between runs of same-day rows and
 * collects undated rows under one trailing "No date" heading; off, the rows
 * render flat in the server's order, so a newly-fetched page can only ever
 * append at the bottom. The caller decides which, and what to show when the
 * result set is empty — see ListView (events) and ExploreView (everything).
 */
export function EntityResultList({ grouped, emptyState }: { grouped: boolean; emptyState: ReactNode }) {
  const [
    { data, loading, hasNextPage, loadingMore, loadMore, error, refetch, totalCount },
    { setActiveEntity },
  ] = useEntityService();
  const fmt = useDateTimeFormat();

  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Remember the scroll position under the history entry it belongs to, and
  // give it back when that entry is shown again (Back from a full page). The
  // position is saved as the entry is left, from the last scroll seen, because
  // the scroll box is already gone by the time an unmount's cleanup runs.
  const { key: historyKey } = useLocation();
  const lastScrollTopRef = useRef(0);
  const pendingRestoreRef = useRef<number | null>(scrollTopByHistoryEntry.get(historyKey) ?? null);

  useEffect(() => {
    return () => {
      scrollTopByHistoryEntry.set(historyKey, lastScrollTopRef.current);
    };
  }, [historyKey]);

  // Re-applied as pages arrive, until the list is tall enough to reach the
  // saved position or there is nothing more to load.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const target = pendingRestoreRef.current;

    if (!el || target == null || data.length === 0) {
      return;
    }

    el.scrollTop = target;
    lastScrollTopRef.current = el.scrollTop;

    if (el.scrollTop >= target - 1 || !hasNextPage) {
      pendingRestoreRef.current = null;
    }
  }, [data.length, hasNextPage]);

  // Fetch the next server page (cursor-based) when the sentinel scrolls into view.
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

  // groupEntitiesByBucket already collects undated entities into one trailing
  // group; the flat branch keeps the server's order.
  const groups = useMemo(() => (grouped ? groupEntitiesByBucket(data) : null), [grouped, data]);

  // Every row opens the same shared details drawer (incl. File/Item media).
  const renderRow = (item: EntityItem) => {
    const time = formatRowTime(getEntityTimestamp(item), fmt);
    let row: ReactNode;

    switch (item.__typename) {
      case 'AnswerType':
        row = <AnswerRow answer={item} time={time} onClick={() => setActiveEntity(item)} />;
        break;

      case 'BrowserActivityType':
        row = <BrowserActivityRow browserActivity={item} time={time} onClick={() => setActiveEntity(item)} />;
        break;

      case 'CommunicationType':
        row = <CommunicationRow communication={item} time={time} onClick={() => setActiveEntity(item)} />;
        break;

      case 'ConceptType':
        row = <ConceptRow concept={item} time={time} onClick={() => setActiveEntity(item)} />;
        break;

      case 'ContentType':
        row = <ContentRow content={item} time={time} onClick={() => setActiveEntity(item)} />;
        break;

      case 'EventType':
        row = <EventRow event={item} time={time} onClick={() => setActiveEntity(item)} />;
        break;

      case 'FileChunkType':
        row = <FileChunkRow fileChunk={item} onClick={() => setActiveEntity(item)} />;
        break;

      case 'FileType':
        row = <FileRow file={item} time={time} onClick={() => setActiveEntity(item)} />;
        break;

      case 'ItemType':
        row = <ItemRow item={item} time={time} onClick={() => setActiveEntity(item)} />;
        break;

      case 'NoteType':
        row = <NoteRow note={item} time={time} onClick={() => setActiveEntity(item)} />;
        break;

      case 'PersonType':
        row = <PersonRow person={item} time={time} onClick={() => setActiveEntity(item)} />;
        break;

      case 'PlaceType':
        row = <PlaceRow place={item} time={time} onClick={() => setActiveEntity(item)} />;
        break;

      case 'ProductModelType':
        row = <ProductRow product={item} time={time} onClick={() => setActiveEntity(item)} />;
        break;

      case 'ReceiptType':
        row = <ReceiptRow receipt={item} time={time} onClick={() => setActiveEntity(item)} />;
        break;

      case 'ThreadType':
        row = <ThreadRow thread={item} time={time} onClick={() => setActiveEntity(item)} />;
        break;

      default:
        return null;
    }

    return (
      <MemoryChatAbout key={item.id} entity={item}>
        {row}
      </MemoryChatAbout>
    );
  };

  // First load (no data yet): skeletons over a bare spinner.
  if (loading && data.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" data-list-scroll="">
        <ListSkeleton count={10} />
      </div>
    );
  }

  // Hard error with nothing to show.
  if (error && data.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" data-list-scroll="">
        <ErrorState onRetry={refetch} />
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" data-list-scroll="">
        {emptyState}
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
      data-list-scroll=""
      onScroll={(event) => {
        lastScrollTopRef.current = event.currentTarget.scrollTop;
      }}
    >
      <div className="flex flex-col">
        {groups
          ? groups.map((group) => (
              <section key={group.key} className="pb-1">
                <DateGroupHeader label={group.label} count={group.entities.length} />
                <div className="flex flex-col">{group.entities.map(renderRow)}</div>
              </section>
            ))
          : data.map(renderRow)}
      </div>

      {loadingMore && <ListSkeleton count={3} showHeader={false} />}

      {hasNextPage && <div ref={sentinelRef} className="h-8" />}

      <div className="py-3 text-center text-xs text-muted-foreground">
        {formatLoadedCount({ loaded: data.length, totalCount, loadingMore, hasNextPage })}
      </div>
    </div>
  );
}

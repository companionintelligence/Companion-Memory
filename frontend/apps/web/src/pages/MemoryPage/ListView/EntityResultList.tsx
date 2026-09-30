import { useEffect, useMemo, useRef, type ReactNode } from 'react';

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
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" data-list-scroll="">
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

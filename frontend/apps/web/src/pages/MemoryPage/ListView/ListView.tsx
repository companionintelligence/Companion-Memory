import { useEffect, useMemo, useRef, type ReactNode } from 'react';

import { useSearchParams } from 'react-router-dom';

import { MemoryChatAbout } from '@/components/ChatWithAgent';
import {
  DateGroupHeader,
  ErrorState,
  ListSkeleton,
  MemoryEmptyState,
  formatLoadedCount,
  formatRowTime,
  getEntityTimestamp,
  groupEntitiesByBucket,
  isChronologicalSort,
} from '@/pages/MemoryPage/Components';
import { countActiveFilters } from '@/pages/MemoryPage/Components/ExplorerToolbar/filterParams';

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

export function ListView() {
  const [
    { data, loading, hasNextPage, loadingMore, loadMore, error, refetch, totalCount },
    { setActiveEntity },
  ] = useEntityService();

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

  // Date-group headers only make sense while results are in chronological order.
  // Relevance/name sorts interleave dates, so we fall back to a flat list there
  // (grouping then would emit repeated, out-of-order headers).
  const [searchParams] = useSearchParams();
  const grouped = isChronologicalSort(
    searchParams.get('sortBy'),
    Boolean(searchParams.get('search')?.trim()),
  );
  // groupEntitiesByBucket already collects undated entities into one trailing
  // group; the flat (relevance/name-sorted) branch keeps the server's order.
  const groups = useMemo(() => (grouped ? groupEntitiesByBucket(data) : null), [grouped, data]);
  const filteredBrowse = countActiveFilters(searchParams) > 0 || Boolean(searchParams.get('search')?.trim());

  // Every row opens the same shared details drawer (incl. File/Item media).
  const renderRow = (item: EntityItem) => {
    const time = formatRowTime(getEntityTimestamp(item));
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
        <MemoryEmptyState filtered={filteredBrowse} />
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

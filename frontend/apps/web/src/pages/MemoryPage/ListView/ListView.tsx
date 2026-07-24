import { useEffect, useMemo, useRef } from 'react';

import { useSearchParams } from 'react-router-dom';

import {
  DateGroupHeader,
  Empty,
  ErrorState,
  ListSkeleton,
  formatRowTime,
  getEntityTimestamp,
  groupEntitiesByBucket,
  isChronologicalSort,
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
import { ThreadRow } from './rows/ThreadRow';

export function ListView() {
  const [{ data, loading, hasNextPage, loadingMore, loadMore, error, refetch }, { setActiveEntity }] =
    useEntityService();

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
  const groups = useMemo(() => (grouped ? groupEntitiesByBucket(data) : null), [grouped, data]);

  // Every row opens the same shared details drawer (incl. File/Item media).
  const renderRow = (item: EntityItem) => {
    const time = formatRowTime(getEntityTimestamp(item));

    switch (item.__typename) {
      case 'AnswerType':
        return <AnswerRow key={item.id} answer={item} time={time} onClick={() => setActiveEntity(item)} />;

      case 'BrowserActivityType':
        return (
          <BrowserActivityRow
            key={item.id}
            browserActivity={item}
            time={time}
            onClick={() => setActiveEntity(item)}
          />
        );

      case 'CommunicationType':
        return (
          <CommunicationRow
            key={item.id}
            communication={item}
            time={time}
            onClick={() => setActiveEntity(item)}
          />
        );

      case 'ConceptType':
        return <ConceptRow key={item.id} concept={item} time={time} onClick={() => setActiveEntity(item)} />;

      case 'ContentType':
        return <ContentRow key={item.id} content={item} time={time} onClick={() => setActiveEntity(item)} />;

      case 'EventType':
        return <EventRow key={item.id} event={item} time={time} onClick={() => setActiveEntity(item)} />;

      case 'FileChunkType':
        return <FileChunkRow key={item.id} fileChunk={item} onClick={() => setActiveEntity(item)} />;

      case 'FileType':
        return <FileRow key={item.id} file={item} time={time} onClick={() => setActiveEntity(item)} />;

      case 'ItemType':
        return <ItemRow key={item.id} item={item} time={time} onClick={() => setActiveEntity(item)} />;

      case 'NoteType':
        return <NoteRow key={item.id} note={item} time={time} onClick={() => setActiveEntity(item)} />;

      case 'PersonType':
        return <PersonRow key={item.id} person={item} time={time} onClick={() => setActiveEntity(item)} />;

      case 'PlaceType':
        return <PlaceRow key={item.id} place={item} time={time} onClick={() => setActiveEntity(item)} />;

      case 'ThreadType':
        return <ThreadRow key={item.id} thread={item} time={time} onClick={() => setActiveEntity(item)} />;

      default:
        return null;
    }
  };

  // First load (no data yet): skeletons over a bare spinner.
  if (loading && data.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto pl-1 pr-4 pb-2">
        <ListSkeleton count={10} />
      </div>
    );
  }

  // Hard error with nothing to show.
  if (error && data.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto pl-1 pr-4 pb-2">
        <ErrorState onRetry={refetch} />
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <Empty
        title="No results"
        description="Try clearing your filters or searching for something else."
        icon="🔍"
      />
    );
  }

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto pl-1 pr-4 pb-2">
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
        {data.length} loaded{loadingMore ? ' · loading…' : hasNextPage ? '' : ' · end'}
      </div>
    </div>
  );
}

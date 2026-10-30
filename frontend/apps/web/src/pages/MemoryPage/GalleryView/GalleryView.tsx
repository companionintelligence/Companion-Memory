import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { useSearchParams } from 'react-router-dom';

import { useAnswersFromDevice } from '@/api/powersync/deviceFallback';
import { MemoryChatAbout } from '@/components/ChatWithAgent';
import {
  AnswerGridItem,
  BrowserActivityGridItem,
  CommunicationGridItem,
  ConceptGridItem,
  ContentGridItem,
  EntityGrid,
  EventGridItem,
  FileChunkGridItem,
  FileGridItem,
  ItemGridItem,
  NoteGridItem,
  PersonGridItem,
  PlaceGridItem,
  ProductGridItem,
  ReceiptGridItem,
  ThreadGridItem,
} from '@/components/entities';

import {
  ErrorState,
  MemoryEmptyState,
  formatLoadedCount,
  isChronologicalSort,
  orderDatedFirst,
} from '../Components';
import { countActiveFilters } from '../Components/ExplorerToolbar/filterParams';
import { useEntityService } from '../useEntityService';

import { LocalGalleryView } from './LocalGalleryView';
import { getEntityMedia, type EntityMedia } from './media';
import { MediaLightbox } from './MediaLightbox';
import { MediaTile } from './MediaTile';

/**
 * The gallery tab. While the Memory server does not answer and this phone
 * holds a replica, the photos come from the phone's preview store
 * (LocalGalleryView); otherwise from the appliance. See
 * api/powersync/deviceFallback.ts.
 */
export function GalleryView() {
  const offline = useAnswersFromDevice();

  return offline ? <LocalGalleryView /> : <OnlineGalleryView />;
}

function OnlineGalleryView() {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [searchParams] = useSearchParams();
  const filteredBrowse = countActiveFilters(searchParams) > 0 || Boolean(searchParams.get('search')?.trim());

  const [
    { data, loading, hasNextPage, loadingMore, loadMore, error, refetch, totalCount },
    { setActiveEntity },
  ] = useEntityService();

  // Under a chronological sort, entities the client cannot date (Content,
  // Person, Place, Item, … — the server orders them by row-write time, which a
  // bulk import parks at the very front) go to the back of the grid, mirroring
  // the trailing "No date" group ListView renders. A relevance/name sort has no
  // date axis to fall off, so its order is left alone.
  const ordered = useMemo(() => {
    const chronological = isChronologicalSort(
      searchParams.get('sortBy'),
      Boolean(searchParams.get('search')?.trim()),
    );

    return chronological ? orderDatedFirst(data) : data;
  }, [data, searchParams]);

  // Ordered list of media-bearing entities (images/video). It drives the
  // lightbox and lets a tile look up its position for arrow navigation.
  const mediaEntries = useMemo(
    () => ordered.map(getEntityMedia).filter((m): m is EntityMedia => m != null),
    [ordered],
  );
  const mediaIndexById = useMemo(() => {
    const map = new Map<string, number>();
    mediaEntries.forEach((media, i) => map.set(media.entityId, i));

    return map;
  }, [mediaEntries]);

  // Infinite scroll (cursor-based) — mirrors ListView.
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
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

  if (loading && data.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" data-list-scroll="">
        <EntityGrid>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-full w-full animate-pulse rounded-lg border bg-card" />
          ))}
        </EntityGrid>
      </div>
    );
  }

  // Hard error with nothing to show — mirror List/Timeline rather than letting a
  // query failure read as "No results found".
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
    <>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" data-list-scroll="">
        <EntityGrid>
          {ordered.map((item) => {
            // Media-bearing entities (image/video) render as real thumbnails and
            // open the lightbox; everything else keeps its clean text tile and
            // opens the shared details drawer (incl. non-media File/Item).
            const mediaIdx = mediaIndexById.get(item.id);
            if (mediaIdx != null) {
              // FileType (incl. Capture screenshots): open the details sheet so
              // the sidebar shows EntityMedia + metadata. Other media (e.g.
              // Event photos) keep the cross-item lightbox.
              const openMedia = () => {
                if (item.__typename === 'FileType') {
                  setActiveEntity(item);

                  return;
                }

                setLightboxIndex(mediaIdx);
              };

              return (
                <MemoryChatAbout key={item.id} entity={item} className="h-full min-w-0">
                  <MediaTile media={mediaEntries[mediaIdx]} onClick={openMedia} />
                </MemoryChatAbout>
              );
            }

            let tile: ReactNode;

            switch (item.__typename) {
              case 'AnswerType':
                tile = <AnswerGridItem answer={item} onClick={() => setActiveEntity(item)} />;
                break;

              case 'BrowserActivityType':
                tile = (
                  <BrowserActivityGridItem browserActivity={item} onClick={() => setActiveEntity(item)} />
                );
                break;

              case 'CommunicationType':
                tile = <CommunicationGridItem communication={item} onClick={() => setActiveEntity(item)} />;
                break;

              case 'ConceptType':
                tile = <ConceptGridItem concept={item} onClick={() => setActiveEntity(item)} />;
                break;

              case 'ContentType':
                tile = <ContentGridItem content={item} onClick={() => setActiveEntity(item)} />;
                break;

              case 'EventType':
                tile = <EventGridItem event={item} onClick={() => setActiveEntity(item)} />;
                break;

              case 'FileChunkType':
                tile = <FileChunkGridItem fileChunk={item} onClick={() => setActiveEntity(item)} />;
                break;

              case 'FileType':
                tile = <FileGridItem file={item} onClick={() => setActiveEntity(item)} />;
                break;

              case 'ItemType':
                tile = <ItemGridItem item={item} onClick={() => setActiveEntity(item)} />;
                break;

              case 'NoteType':
                tile = <NoteGridItem note={item} onClick={() => setActiveEntity(item)} />;
                break;

              case 'PersonType':
                tile = <PersonGridItem person={item} onClick={() => setActiveEntity(item)} />;
                break;

              case 'PlaceType':
                tile = <PlaceGridItem place={item} onClick={() => setActiveEntity(item)} />;
                break;

              case 'ProductModelType':
                tile = <ProductGridItem product={item} onClick={() => setActiveEntity(item)} />;
                break;

              case 'ReceiptType':
                tile = <ReceiptGridItem receipt={item} onClick={() => setActiveEntity(item)} />;
                break;

              case 'ThreadType':
                tile = <ThreadGridItem thread={item} onClick={() => setActiveEntity(item)} />;
                break;

              default:
                return null;
            }

            return (
              <MemoryChatAbout key={item.id} entity={item} className="h-full min-w-0">
                {tile}
              </MemoryChatAbout>
            );
          })}

          {/* Pulsing placeholders for the page being fetched (mirrors ListView). */}
          {loadingMore &&
            Array.from({ length: 4 }).map((_, i) => (
              <div
                key={`loading-more-${i}`}
                className="h-full w-full animate-pulse rounded-lg border bg-card"
              />
            ))}
        </EntityGrid>

        {hasNextPage && <div ref={sentinelRef} className="h-8" />}

        <div className="py-3 text-center text-xs text-muted-foreground">
          {formatLoadedCount({ loaded: data.length, totalCount, loadingMore, hasNextPage })}
        </div>
      </div>

      {lightboxIndex != null && mediaEntries[lightboxIndex] && (
        <MediaLightbox
          entries={mediaEntries}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onIndexChange={setLightboxIndex}
        />
      )}
    </>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';

import { Images } from '@ci/shadcn/icons';

import {
  AnswerGridItem,
  BrowserActivityGridItem,
  CommunicationGridItem,
  ConceptGridItem,
  ContentGridItem,
  EntityGrid,
  EventGridItem,
  FileGridItem,
  ItemGridItem,
  NoteGridItem,
  PersonGridItem,
  PlaceGridItem,
  ThreadGridItem,
} from '@/components/entities';

import { Empty } from '../Components';
import { useEntityService } from '../useEntityService';

import { getEntityMedia, type EntityMedia } from './media';
import { MediaLightbox } from './MediaLightbox';
import { MediaTile } from './MediaTile';

export function GalleryView() {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const [{ data, loading, hasNextPage, loadingMore, loadMore }, { setActiveEntity }] = useEntityService();

  // Ordered list of media-bearing entities (images/video). It drives the
  // lightbox and lets a tile look up its position for arrow navigation.
  const mediaEntries = useMemo(
    () => data.map(getEntityMedia).filter((m): m is EntityMedia => m != null),
    [data],
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
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-2">
        <EntityGrid>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-full w-full animate-pulse rounded-lg border bg-card" />
          ))}
        </EntityGrid>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <Empty
        title="No results found"
        description="Connect your data sources or try a different search to see content here"
        icon={Images}
      />
    );
  }

  return (
    <>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 pb-2">
        <EntityGrid>
          {data.map((item) => {
            // Media-bearing entities (image/video) render as real thumbnails and
            // open the lightbox; everything else keeps its clean text tile and
            // opens the shared details drawer (incl. non-media File/Item).
            const mediaIdx = mediaIndexById.get(item.id);
            if (mediaIdx != null) {
              return (
                <MediaTile
                  key={item.id}
                  media={mediaEntries[mediaIdx]}
                  onClick={() => setLightboxIndex(mediaIdx)}
                />
              );
            }

            switch (item.__typename) {
              case 'AnswerType':
                return <AnswerGridItem key={item.id} answer={item} onClick={() => setActiveEntity(item)} />;

              case 'BrowserActivityType':
                return (
                  <BrowserActivityGridItem
                    key={item.id}
                    browserActivity={item}
                    onClick={() => setActiveEntity(item)}
                  />
                );

              case 'CommunicationType':
                return (
                  <CommunicationGridItem
                    key={item.id}
                    communication={item}
                    onClick={() => setActiveEntity(item)}
                  />
                );

              case 'ConceptType':
                return <ConceptGridItem key={item.id} concept={item} onClick={() => setActiveEntity(item)} />;

              case 'ContentType':
                return <ContentGridItem key={item.id} content={item} onClick={() => setActiveEntity(item)} />;

              case 'EventType':
                return <EventGridItem key={item.id} event={item} onClick={() => setActiveEntity(item)} />;

              case 'FileType':
                return <FileGridItem key={item.id} file={item} onClick={() => setActiveEntity(item)} />;

              case 'ItemType':
                return <ItemGridItem key={item.id} item={item} onClick={() => setActiveEntity(item)} />;

              case 'NoteType':
                return <NoteGridItem key={item.id} note={item} onClick={() => setActiveEntity(item)} />;

              case 'PersonType':
                return <PersonGridItem key={item.id} person={item} onClick={() => setActiveEntity(item)} />;

              case 'PlaceType':
                return <PlaceGridItem key={item.id} place={item} onClick={() => setActiveEntity(item)} />;

              case 'ThreadType':
                return <ThreadGridItem key={item.id} thread={item} onClick={() => setActiveEntity(item)} />;

              default:
                return null;
            }
          })}
        </EntityGrid>

        {hasNextPage && <div ref={sentinelRef} className="h-8" />}

        <div className="py-3 text-center text-xs text-muted-foreground">
          {data.length} loaded{loadingMore ? ' · loading…' : hasNextPage ? '' : ' · end'}
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

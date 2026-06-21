import { useEffect, useRef, useState } from 'react';

import { GlobalUID } from '@ci/common';
import { Images } from '@ci/shadcn/icons';

import { FileModal } from '@/components/modals/FileModal';
import { InventoryItemModal, type InventoryItem } from '@/components/modals/InventoryItemModal';
import { Empty } from '@/pages/MemoryPage/Components';

import { useEntityService } from '../useEntityService';

import { AnswerRow } from './rows/AnswerRow';
import { BrowserActivityRow } from './rows/BrowserActivityRow';
import { CommunicationRow } from './rows/CommunicationRow';
import { ConceptRow } from './rows/ConceptRow';
import { ContentRow } from './rows/ContentRow';
import { EventRow } from './rows/EventRow';
import { FileRow } from './rows/FileRow';
import { ItemRow, type ItemInventoryPreview } from './rows/ItemRow';
import { NoteRow } from './rows/NoteRow';
import { PersonRow } from './rows/PersonRow';
import { PlaceRow } from './rows/PlaceRow';
import { ThreadRow } from './rows/ThreadRow';
import { SearchTable } from './SearchTable';

export function ListView() {
  const [selectedInventoryItem, setSelectedInventoryItem] = useState<InventoryItem | null>(null);
  const [activeItem, setActiveItem] = useState<string | null>(null);

  const clearActiveItem = () => setActiveItem(null);

  const [{ data, hasNextPage, loadingMore, loadMore }, { setActiveEntity }] = useEntityService();

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

  if (data.length === 0) {
    return (
      <Empty
        title="No results found"
        description="Connect your data sources or try a different search to see content here"
        icon={Images}
      />
    );
  }

  const openInventoryModal = (item: ItemInventoryPreview) => {
    setSelectedInventoryItem({
      id: item.id,
      name: item.name,
      description: item.description,
      file: item.file,
    });
  };

  return (
    <>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 pb-2">
        <SearchTable>
          <SearchTable.RowGroup>
            {data.map((item) => {
              // In-place details Sheet for entity rows; richer dedicated modals
              // for media (File) and inventory (Item).
              switch (item.__typename) {
                case 'AnswerType':
                  return <AnswerRow key={item.id} answer={item} onClick={() => setActiveEntity(item)} />;

                case 'BrowserActivityType':
                  return (
                    <BrowserActivityRow
                      key={item.id}
                      browserActivity={item}
                      onClick={() => setActiveEntity(item)}
                    />
                  );

                case 'CommunicationType':
                  return (
                    <CommunicationRow
                      key={item.id}
                      communication={item}
                      onClick={() => setActiveEntity(item)}
                    />
                  );

                case 'ConceptType':
                  return <ConceptRow key={item.id} concept={item} onClick={() => setActiveEntity(item)} />;

                case 'ContentType':
                  return <ContentRow key={item.id} content={item} onClick={() => setActiveEntity(item)} />;

                case 'EventType':
                  return <EventRow key={item.id} event={item} onClick={() => setActiveEntity(item)} />;

                case 'FileType':
                  return <FileRow key={item.id} file={item} onClick={() => setActiveItem(item.id)} />;

                case 'ItemType':
                  return <ItemRow key={item.id} item={item} onSelectInventoryItem={openInventoryModal} />;

                case 'NoteType':
                  return <NoteRow key={item.id} note={item} onClick={() => setActiveEntity(item)} />;

                case 'PersonType':
                  return <PersonRow key={item.id} person={item} onClick={() => setActiveEntity(item)} />;

                case 'PlaceType':
                  return <PlaceRow key={item.id} place={item} onClick={() => setActiveEntity(item)} />;

                case 'ThreadType':
                  return <ThreadRow key={item.id} thread={item} onClick={() => setActiveEntity(item)} />;

                default:
                  return null;
              }
            })}
          </SearchTable.RowGroup>
        </SearchTable>

        {hasNextPage && <div ref={sentinelRef} className="h-8" />}

        <div className="py-3 text-center text-xs text-muted-foreground">
          {data.length} loaded{loadingMore ? ' · loading…' : hasNextPage ? '' : ' · end'}
        </div>
      </div>

      <FileModal fileId={activeItem ?? null} onClose={clearActiveItem} />

      <InventoryItemModal
        open={selectedInventoryItem != null}
        onClose={() => setSelectedInventoryItem(null)}
        item={selectedInventoryItem}
        create={false}
        detailPagePath={
          selectedInventoryItem ? `/items/${GlobalUID.parse('item', selectedInventoryItem.id)}` : undefined
        }
      />
    </>
  );
}

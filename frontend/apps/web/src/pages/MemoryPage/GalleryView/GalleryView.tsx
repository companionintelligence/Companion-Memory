import { useState } from 'react';

import { GlobalUID } from '@ci/common';
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
  type ItemInventoryPreview,
  NoteGridItem,
  PersonGridItem,
  PlaceGridItem,
  ThreadGridItem,
} from '@/components/entities';
import { FileModal } from '@/components/modals/FileModal';
import { InventoryItemModal, type InventoryItem } from '@/components/modals/InventoryItemModal';

import { Empty } from '../Components';
import { useEntityService } from '../useEntityService';

export function GalleryView() {
  const [activeItem, setActiveItem] = useState<string | null>(null);
  const [selectedInventoryItem, setSelectedInventoryItem] = useState<InventoryItem | null>(null);

  const [{ data, loading }, { setActiveEntity }] = useEntityService();

  if (loading && data.length === 0) {
    return (
      <EntityGrid className="p-4 pt-0">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-full w-full animate-pulse rounded-lg border bg-card" />
        ))}
      </EntityGrid>
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

  const clearActiveItem = () => setActiveItem(null);

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
      <EntityGrid className="p-4 pt-0">
        {data.map((item) => {
          // In-place details for entity tiles; richer dedicated modals for
          // media (File) and inventory (Item).
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
              return <FileGridItem key={item.id} file={item} onClick={() => setActiveItem(item.id)} />;

            case 'ItemType':
              return <ItemGridItem key={item.id} item={item} onSelectInventoryItem={openInventoryModal} />;

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

import { useState } from 'react';

import { GlobalUID } from '@ci/common';
import { Images } from '@ci/shadcn/icons';
import { useNavigate } from 'react-router-dom';

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
  const navigate = useNavigate();

  const [activeItem, setActiveItem] = useState<string | null>(null);

  const [selectedInventoryItem, setSelectedInventoryItem] = useState<InventoryItem | null>(null);

  const [{ data }] = useEntityService();

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
          switch (item.__typename) {
            case 'AnswerType':
              return <AnswerGridItem key={item.id} answer={item} onClick={() => {}} />;

            case 'BrowserActivityType':
              return <BrowserActivityGridItem key={item.id} browserActivity={item} onClick={() => {}} />;

            case 'CommunicationType':
              return (
                <CommunicationGridItem
                  key={item.id}
                  communication={item}
                  onClick={() => {
                    navigate(`/communications/${GlobalUID.parse('communication', item.id)}`);
                  }}
                />
              );

            case 'ConceptType':
              return (
                <ConceptGridItem
                  key={item.id}
                  concept={item}
                  onClick={() => {
                    navigate(`/concepts/${GlobalUID.parse('concept', item.id)}`);
                  }}
                />
              );

            case 'ContentType':
              return (
                <ContentGridItem
                  key={item.id}
                  content={item}
                  onClick={() => {
                    navigate(`/content/${GlobalUID.parse('content', item.id)}`);
                  }}
                />
              );

            case 'EventType':
              return (
                <EventGridItem
                  key={item.id}
                  event={item}
                  onClick={() => {
                    navigate(`/events/${GlobalUID.parse('event', item.id)}`);
                  }}
                />
              );

            case 'FileType':
              return <FileGridItem key={item.id} file={item} onClick={() => setActiveItem(item.id)} />;

            case 'ItemType':
              return <ItemGridItem key={item.id} item={item} onSelectInventoryItem={openInventoryModal} />;

            case 'NoteType':
              return (
                <NoteGridItem
                  key={item.id}
                  note={item}
                  onClick={() => {
                    navigate(`/notes/${GlobalUID.parse('note', item.id)}`);
                  }}
                />
              );

            case 'PersonType':
              return (
                <PersonGridItem
                  key={item.id}
                  person={item}
                  onClick={() => {
                    navigate(`/people/${GlobalUID.parse('person', item.id)}`);
                  }}
                />
              );

            case 'PlaceType':
              return (
                <PlaceGridItem
                  key={item.id}
                  place={item}
                  onClick={() => {
                    navigate(`/places/${GlobalUID.parse('place', item.id)}`);
                  }}
                />
              );

            case 'ThreadType':
              return (
                <ThreadGridItem
                  key={item.id}
                  thread={item}
                  onClick={() => {
                    navigate(`/chat/${GlobalUID.parse('thread', item.id)}`);
                  }}
                />
              );

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

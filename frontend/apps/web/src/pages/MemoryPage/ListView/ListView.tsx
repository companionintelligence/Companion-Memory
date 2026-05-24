import { useState } from 'react';

import { GlobalUID } from '@ci/common';
import { Images } from '@ci/shadcn/icons';
import { useNavigate } from 'react-router-dom';

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
  const navigate = useNavigate();

  const [selectedInventoryItem, setSelectedInventoryItem] = useState<InventoryItem | null>(null);
  const [activeItem, setActiveItem] = useState<string | null>(null);

  const clearActiveItem = () => setActiveItem(null);

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
      <SearchTable className="p-4 pt-0">
        <SearchTable.RowGroup>
          {data.map((item) => {
            switch (item.__typename) {
              case 'AnswerType':
                return <AnswerRow key={item.id} answer={item} onClick={() => {}} />;

              case 'BrowserActivityType':
                return <BrowserActivityRow key={item.id} browserActivity={item} onClick={() => {}} />;

              case 'CommunicationType':
                return (
                  <CommunicationRow
                    key={item.id}
                    communication={item}
                    onClick={() => {
                      navigate(`/communications/${GlobalUID.parse('communication', item.id)}`);
                    }}
                  />
                );

              case 'ConceptType':
                return (
                  <ConceptRow
                    key={item.id}
                    concept={item}
                    onClick={() => {
                      navigate(`/concepts/${GlobalUID.parse('concept', item.id)}`);
                    }}
                  />
                );

              case 'ContentType':
                return (
                  <ContentRow
                    key={item.id}
                    content={item}
                    onClick={() => {
                      navigate(`/contents/${GlobalUID.parse('content', item.id)}`);
                    }}
                  />
                );

              case 'EventType':
                return (
                  <EventRow
                    key={item.id}
                    event={item}
                    onClick={() => {
                      navigate(`/events/${GlobalUID.parse('event', item.id)}`);
                    }}
                  />
                );

              case 'FileType':
                return <FileRow key={item.id} file={item} onClick={() => setActiveItem(item.id)} />;

              case 'ItemType':
                return <ItemRow key={item.id} item={item} onSelectInventoryItem={openInventoryModal} />;

              case 'NoteType':
                return (
                  <NoteRow
                    key={item.id}
                    note={item}
                    onClick={() => {
                      navigate(`/notes/${GlobalUID.parse('note', item.id)}`);
                    }}
                  />
                );

              case 'PersonType':
                return (
                  <PersonRow
                    key={item.id}
                    person={item}
                    onClick={() => {
                      navigate(`/people/${GlobalUID.parse('person', item.id)}`);
                    }}
                  />
                );

              case 'PlaceType':
                return (
                  <PlaceRow
                    key={item.id}
                    place={item}
                    onClick={() => {
                      navigate(`/places/${GlobalUID.parse('place', item.id)}`);
                    }}
                  />
                );

              case 'ThreadType':
                return (
                  <ThreadRow
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
        </SearchTable.RowGroup>
      </SearchTable>

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

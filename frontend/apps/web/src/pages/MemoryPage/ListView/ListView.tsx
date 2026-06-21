import { useEffect, useRef, useState } from 'react';

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

// Render the fetched set in pages, growing as the user scrolls, so the DOM
// stays light and the list feels responsive even with hundreds of results.
const PAGE_SIZE = 40;

export function ListView() {
  const navigate = useNavigate();

  const [selectedInventoryItem, setSelectedInventoryItem] = useState<InventoryItem | null>(null);
  const [activeItem, setActiveItem] = useState<string | null>(null);

  const clearActiveItem = () => setActiveItem(null);

  const [{ data }] = useEntityService();

  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Reset paging whenever the underlying result set changes (e.g. a new search).
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [data]);

  const hasMore = visibleCount < data.length;

  // Reveal the next page when the sentinel scrolls into view.
  useEffect(() => {
    if (!hasMore) {
      return;
    }

    const sentinel = sentinelRef.current;

    if (!sentinel) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount((count) => Math.min(count + PAGE_SIZE, data.length));
        }
      },
      { root: scrollRef.current, rootMargin: '400px' },
    );

    observer.observe(sentinel);

    return () => observer.disconnect();
  }, [hasMore, data.length]);

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
            {data.slice(0, visibleCount).map((item) => {
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

        {hasMore && <div ref={sentinelRef} className="h-8" />}

        <div className="py-3 text-center text-xs text-muted-foreground">
          Showing {Math.min(visibleCount, data.length)} of {data.length}
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

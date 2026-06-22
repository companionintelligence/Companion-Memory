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

export function GalleryView() {
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

  return (
    <EntityGrid className="p-4 pt-0">
      {data.map((item) => {
        // Every tile opens the same shared details drawer (incl. File/Item media).
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
  );
}

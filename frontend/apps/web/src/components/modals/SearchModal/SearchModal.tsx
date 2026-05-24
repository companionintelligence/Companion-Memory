import { useCallback, useMemo, useRef, useState } from 'react';

import { GlobalUID } from '@ci/common';
import { Dialog } from '@ci/shadcn';
import { useNavigate } from 'react-router-dom';

import { SearchBox } from '@/components/SearchBox';

import { CommunicationResult } from './results/CommunicationResult';
import { ConceptResult } from './results/ConceptResult';
import { ContentResult } from './results/ContentResult';
import { EventResult } from './results/EventResult';
import { FileResult } from './results/FileResult';
import { ItemResult } from './results/ItemResult';
import { NoteResult } from './results/NoteResult';
import { PersonResult } from './results/PersonResult';
import { PlaceResult } from './results/PlaceResult';
import { ThreadResult } from './results/ThreadResult';
import { useSearchService } from './useSearchService';

interface Props {
  open?: boolean;
  onClose?: (open?: boolean) => void;
}

export function SearchModal({ open, onClose }: Props) {
  const navigate = useNavigate();

  const [query, setQuery] = useState<string | null>(null);
  const queryValueRef = useRef<string>('');

  const { data, loading, error } = useSearchService({
    searchQuery: query ?? '',
  });

  const results = useMemo(
    () =>
      data.map((item) => {
        switch (item.__typename) {
          case 'CommunicationType':
            return {
              id: item.id,
              content: <CommunicationResult communication={item} />,
            };

          case 'ConceptType':
            return {
              id: item.id,
              content: <ConceptResult concept={item} />,
            };

          case 'ContentType':
            return {
              id: item.id,
              content: <ContentResult content={item} />,
            };

          case 'EventType':
            return {
              id: item.id,
              content: <EventResult event={item} />,
            };

          case 'FileType':
            return {
              id: item.id,
              content: <FileResult file={item} />,
            };

          case 'ItemType':
            return {
              id: item.id,
              content: <ItemResult item={item} />,
            };

          case 'NoteType':
            return {
              id: item.id,
              content: <NoteResult note={item} />,
            };

          case 'PersonType':
            return {
              id: item.id,
              content: <PersonResult person={item} />,
            };

          case 'PlaceType':
            return {
              id: item.id,
              content: <PlaceResult place={item} />,
            };

          case 'ThreadType':
            return {
              id: item.id,
              content: <ThreadResult thread={item} />,
            };

          default:
            return {
              id: item.id,
              content: null,
            };
        }
      }),
    [data],
  );

  const handleSearch = useCallback(({ query: searchQuery }: { query: string }) => {
    setQuery(searchQuery);
  }, []);

  const handleResultSelect = useCallback(
    ({ id }: { id: string }) => {
      const { type, id: decodedId } = GlobalUID.decode(id);

      onClose?.();

      switch (type) {
        case 'communication':
          navigate(`/communications/${decodedId}`);
          break;

        case 'concept':
          navigate(`/concepts/${decodedId}`);
          break;

        case 'content':
          navigate(`/content/${decodedId}`);
          break;

        case 'event':
          navigate(`/events/${decodedId}`);
          break;

        case 'item':
          navigate(`/items/${decodedId}`);
          break;

        case 'note':
          navigate(`/notes/${decodedId}`);
          break;

        case 'person':
          navigate(`/people/${decodedId}`);
          break;

        case 'place':
          navigate(`/places/${decodedId}`);
          break;

        case 'thread':
          navigate(`/chat/${decodedId}`);
          break;

        default:
          break;
      }
    },
    [onClose, navigate],
  );

  const handleKeyDown = useCallback((query: string) => {
    queryValueRef.current = query;
  }, []);

  const handleEscape = useCallback(
    (e: KeyboardEvent) => {
      if (queryValueRef.current !== '') {
        e.preventDefault();
      }
    },
    [onClose],
  );

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <Dialog.Content
        className="bg-transparent border-none shadow-none p-0 top-[15%] translate-y-0 sm:max-w-2xl"
        showCloseButton={false}
        onEscapeKeyDown={handleEscape}
      >
        <Dialog.Title className="sr-only">Search through your Companion data</Dialog.Title>
        <SearchBox
          onSearch={handleSearch}
          onResultSelect={handleResultSelect}
          onKeyDown={handleKeyDown}
          variant="compact"
          autoSubmit
          displayResults
          loading={loading}
          error={error}
          results={results}
        />
      </Dialog.Content>
    </Dialog>
  );
}

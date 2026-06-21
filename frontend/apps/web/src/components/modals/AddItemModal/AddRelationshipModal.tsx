import { useCallback, useState, useMemo } from 'react';

import { useMutation } from '@apollo/client';
import { GlobalUID } from '@ci/common';
import { Button, Calendar, Dialog, Label, Select } from '@ci/shadcn';
import { X } from '@ci/shadcn/icons';

import { type SearchResultItem, SearchBox } from '@/components/SearchBox';
import { CommunicationResult } from '@/components/SearchBox/results/CommunicationResult.tsx';
import { ConceptResult } from '@/components/SearchBox/results/ConceptResult.tsx';
import { ContentResult } from '@/components/SearchBox/results/ContentResult.tsx';
import { EventResult } from '@/components/SearchBox/results/EventResult.tsx';
import { ItemResult } from '@/components/SearchBox/results/ItemResult.tsx';
import { NoteResult } from '@/components/SearchBox/results/NoteResult.tsx';
import { PersonResult } from '@/components/SearchBox/results/PersonResult.tsx';
import { PlaceResult } from '@/components/SearchBox/results/PlaceResult.tsx';
import { ThreadResult } from '@/components/SearchBox/results/ThreadResult.tsx';
import { useSearchService } from '@/components/SearchBox/useSearchService.ts';
import { gql } from '@/graphql';

const CREATE_RELATIONSHIP = gql(`
  mutation CreateRelationship($input: CreateRelationshipInput!) {
    createRelationship(input: $input) {
      success
      relationship {
        id
        fromNodeId
        fromNodeType
        toNodeId
        toNodeType
        type
        properties
        isBidirectional
        startDate
        endDate
      }
    }
  }
`);

interface Props {
  entityId: string;
  entityType: string;
  allowedRelationshipTypes: {
    communication?: string[];
    concept?: string[];
    content?: string[];
    event?: string[];
    item?: string[];
    note?: string[];
    person?: string[];
    place?: string[];
    thread?: string[];
  };
  open?: boolean;
  onClose?: (open?: boolean) => void;
}

export function AddRelationshipModal({
  entityId,
  entityType,
  allowedRelationshipTypes,
  open,
  onClose,
}: Props) {
  const [query, setQuery] = useState<string | null>(null);
  const [selectedEntity, setSelectedEntity] = useState<SearchResultItem | null>(null);
  const [selectedRelationshipType, setSelectedRelationshipType] = useState<string | undefined>(undefined);
  const [startDate, setStartDate] = useState<Date | undefined>(undefined);
  const [endDate, setEndDate] = useState<Date | undefined>(undefined);

  const { data, loading, error } = useSearchService({
    searchQuery: query ?? '',
  });

  const results: SearchResultItem[] = useMemo(
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

  const [createRelationship] = useMutation(CREATE_RELATIONSHIP);

  const handleCancel = () => {
    onClose?.(false);
  };

  const handleCreate = async () => {
    if (!selectedEntity || !selectedRelationshipType) {
      return;
    }

    try {
      const { type, id } = GlobalUID.decode(selectedEntity.id);
      await createRelationship({
        variables: {
          input: {
            fromNodeId: entityId,
            fromNodeType: entityType,
            toNodeId: id,
            toNodeType: type,
            type: selectedRelationshipType,
            startDate: startDate?.toISOString(),
            endDate: endDate?.toISOString(),
          },
        },
      });

      // Reset form and close modal on success
      setSelectedEntity(null);
      setSelectedRelationshipType(undefined);
      setStartDate(undefined);
      setEndDate(undefined);
      setQuery(null);
      onClose?.(false);
    } catch (error) {
      console.error('Failed to create relationship:', error);
    }
  };

  const handleClose = () => {
    setSelectedEntity(null);
    setSelectedRelationshipType(undefined);
    setStartDate(undefined);
    setEndDate(undefined);
    setQuery(null);
    onClose?.(false);
  };

  const handleSearch = useCallback(({ query: searchQuery }: { query: string }) => {
    setQuery(searchQuery);
  }, []);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <Dialog.Content className="top-[15%] translate-y-0 sm:max-w-2xl">
        <Dialog.Header>
          <Dialog.Title className="text-xl mb-4">Add Relationship</Dialog.Title>
        </Dialog.Header>

        <Dialog.Title>Related Entity</Dialog.Title>
        {!selectedEntity && (
          <SearchBox
            onSearch={handleSearch}
            onResultSelect={(e) => setSelectedEntity(e)}
            onKeyDown={() => {}}
            variant="compact"
            autoSubmit
            displayResults
            loading={loading}
            error={error}
            results={results}
          />
        )}
        {selectedEntity && (
          <div className="flex items-center gap-2">
            <div className="flex-1">{selectedEntity.content}</div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setSelectedEntity(null);
                setSelectedRelationshipType(undefined);
              }}
              className="text-gray-500 hover:text-red-400 hover:bg-red-50"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        )}

        {selectedEntity && (
          <div className="mt-4">
            <Label htmlFor="relationship-type">Relationship Type</Label>
            <Select value={selectedRelationshipType} onValueChange={setSelectedRelationshipType}>
              <Select.Trigger id="relationship-type">
                <Select.Value placeholder="Select relationship type" />
              </Select.Trigger>
              <Select.Content>
                {(
                  allowedRelationshipTypes[
                    GlobalUID.decode(selectedEntity.id).type as keyof typeof allowedRelationshipTypes
                  ] || []
                )
                  .sort((a, b) => a.localeCompare(b))
                  .map((type) => {
                    const formattedType = type
                      .replace(/_/g, ' ')
                      .toLowerCase()
                      .replace(/^\w/, (c) => c.toUpperCase());

                    return (
                      <Select.Item key={type} value={type}>
                        {formattedType}
                      </Select.Item>
                    );
                  })}
              </Select.Content>
            </Select>
          </div>
        )}

        {selectedEntity && (
          <div className="flex gap-4 justify-between mt-4">
            <div className="flex-1">
              <Label>Start Date</Label>
              {startDate && (
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-sm">{startDate.toLocaleDateString()}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setStartDate(undefined)}
                    className="text-gray-500 hover:text-red-400 hover:bg-red-50 h-6 w-6 p-0"
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              )}
              <Calendar
                mode="single"
                selected={startDate}
                defaultMonth={startDate}
                captionLayout="dropdown"
                onSelect={(date) => {
                  setStartDate(date);
                }}
              />
            </div>
            <div className="flex-1">
              <Label>End Date</Label>
              {endDate && (
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-sm">{endDate.toLocaleDateString()}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setEndDate(undefined)}
                    className="text-gray-500 hover:text-red-400 hover:bg-red-50 h-6 w-6 p-0"
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              )}
              <Calendar
                mode="single"
                selected={endDate}
                defaultMonth={endDate}
                captionLayout="dropdown"
                onSelect={(date) => {
                  setEndDate(date);
                }}
              />
            </div>
          </div>
        )}

        <Dialog.Footer className="flex gap-2 justify-end">
          <Button type="button" variant="destructive" onClick={handleCancel} disabled={loading}>
            Cancel
          </Button>
          <Button
            disabled={!selectedEntity || !selectedRelationshipType}
            onClick={handleCreate}
            className="bg-green-600 hover:bg-green-700"
          >
            Add
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog>
  );
}

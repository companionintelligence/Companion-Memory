import { useEffect, useState } from 'react';

import { useMutation, type Reference, isReference } from '@apollo/client';
import { ENTITY_TYPE_MAP, ENTITY_TYPE_REVERSE_MAP } from '@ci/common/src/constants';
import { Button, Dialog, Input, Label, Textarea } from '@ci/shadcn';

import { EntityTypeFilter } from '@/components/SearchBox/EntityTypeFilter';
import { useDropdown } from '@/components/SearchBox/useDropdown';
import { TagInput } from '@/components/TagInput';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { SavedSearchGridItemFragment } from '../SavedSearchesPage/SavedSearch';

import { toFiltersInput, type EditableFilters } from './savedSearchFiltersEdit';
import { SavedSearchFiltersEditor } from './SavedSearchFiltersEditor';

interface Props {
  savedSearch: FragmentType<typeof SavedSearchGridItemFragment>;
  onClose: () => void;
}

const UPDATE_SAVED_SEARCH = gql(`
  mutation UpdateSavedSearch($input: UpdateSavedSearchInput!) {
    updateSavedSearch(input: $input) {
      success
      savedSearch {
        id
        name
        description
        query
        entityTypes
        tags
        filters {
          eventTypes
          startTime
          endTime
          datePreset
          sortBy
          sortOrder
          connectors
          people
          places
          hasLocation
          semantic
        }
      }
    }
  }
`);

export function EditSavedSearchModal({ savedSearch: savedSearchMask, onClose }: Props) {
  const savedSearch = useFragment(SavedSearchGridItemFragment, savedSearchMask);

  const [name, setName] = useState(savedSearch.name);
  const [description, setDescription] = useState(savedSearch.description);
  const [query, setQuery] = useState(savedSearch.query);
  const [filters, setFilters] = useState<EditableFilters>(savedSearch.filters ?? {});
  const [{ selectedEntityTypes }, { setSelectedEntityTypes }] = useDropdown();

  useEffect(() => {
    const mappedEntityTypes = savedSearch.entityTypes?.map(
      (type) => ENTITY_TYPE_REVERSE_MAP[type as keyof typeof ENTITY_TYPE_REVERSE_MAP],
    );
    setSelectedEntityTypes(mappedEntityTypes || []);
  }, [savedSearch?.entityTypes]);

  const [updateSavedSearch, { loading: updating }] = useMutation(UPDATE_SAVED_SEARCH, {
    update(cache, { data }) {
      const updatedSavedSearchId = data?.updateSavedSearch?.savedSearch?.id;

      if (updatedSavedSearchId) {
        cache.modify({
          fields: {
            savedSearches(
              existingSavedSearches:
                | {
                    edges: { node: Reference }[];
                  }
                | Reference = { edges: [] },
              { readField },
            ) {
              if (isReference(existingSavedSearches)) {
                return existingSavedSearches;
              }

              return {
                ...existingSavedSearches,
                edges: existingSavedSearches.edges.map((edge) => {
                  const edgeNodeId = readField('id', edge.node);

                  if (!data?.updateSavedSearch?.savedSearch) {
                    return edge;
                  }

                  return edgeNodeId !== updatedSavedSearchId
                    ? edge
                    : {
                        ...edge,
                        ...data.updateSavedSearch.savedSearch,
                      };
                }),
              };
            },
          },
        });
      }
    },
  });

  const handleSave = async () => {
    await updateSavedSearch({
      variables: {
        input: {
          id: savedSearch.id,
          name,
          description,
          query,
          entityTypes: selectedEntityTypes.map(
            (type) => ENTITY_TYPE_MAP[type as keyof typeof ENTITY_TYPE_MAP],
          ),
          filters: toFiltersInput(filters),
        },
      },
    });

    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content className="sm:max-w-[600px]">
        <Dialog.Header>
          <Dialog.Title>Update Saved Search</Dialog.Title>
        </Dialog.Header>

        <div className="max-h-[65vh] space-y-4 overflow-y-auto py-4 pr-1">
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={name || undefined}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter search name"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={description || undefined}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Enter search description"
              rows={3}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="query">Query</Label>
            <Input
              id="query"
              value={query || undefined}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Enter search query"
            />
          </div>

          <div className="space-y-2">
            <Label>Entity Types</Label>
            <EntityTypeFilter modal={true} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="tags">Tags</Label>
            <TagInput tags={savedSearch.tags || undefined} onTagAdded={() => true} />
          </div>

          <div className="space-y-2 border-t border-border pt-4">
            <Label>Filters</Label>
            <p className="text-xs text-muted-foreground">
              The who / where / when / how / sort captured with this search. Editing here keeps it in sync
              everywhere it runs — including a shared link.
            </p>
            <SavedSearchFiltersEditor value={filters} onChange={setFilters} />
          </div>
        </div>

        <Dialog.Footer>
          <Button variant="outline" onClick={onClose} disabled={updating}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={updating}>
            {updating ? 'Saving...' : 'Save'}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog>
  );
}

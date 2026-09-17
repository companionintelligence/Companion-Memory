import { useState } from 'react';

import { useMutation } from '@apollo/client';
import { ENTITY_TYPE_MAP } from '@ci/common/src/constants';
import { Button, Dialog, Input, Label, Textarea, useToast } from '@ci/shadcn';

import { EntityTypeFilter } from '@/components/SearchBox/EntityTypeFilter';
import { useDropdown } from '@/components/SearchBox/useDropdown';
import { gql } from '@/graphql';

import { toFiltersInput, type EditableFilters } from './savedSearchFiltersEdit';
import { SavedSearchFiltersEditor } from './SavedSearchFiltersEditor';
import { useSavedSearchVocabulary } from './useSavedSearchVocabulary';

/**
 * Shared with the Memory explorer's SaveSearchButton (which saves the *current*
 * search); this modal is the from-scratch path on the Saved Searches page.
 */
export const CREATE_SAVED_SEARCH = gql(`
  mutation CreateSavedSearch($input: CreateSavedSearchInput!) {
    createSavedSearch(input: $input) {
      success
      savedSearch {
        id
        # Full grid fragment (incl. isPublic/shareToken/filters) so the created
        # search can be handed straight to the share modal from "Save & share".
        ...SavedSearchGridItemFragment
      }
    }
  }
`);

interface Props {
  onClose: () => void;
}

/**
 * Create a saved search from scratch: name / description / query / entity
 * types plus the same who / where / when / how / sort editor the edit modal
 * uses. The other creation path — saving the search you are currently
 * running — lives in the Memory explorer's advanced-filter drawer.
 */
export function CreateSavedSearchModal({ onClose }: Props) {
  const { toast } = useToast();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<EditableFilters>({});
  const vocabulary = useSavedSearchVocabulary();
  const [{ selectedEntityTypes }] = useDropdown();

  const [createSavedSearch, { loading }] = useMutation(CREATE_SAVED_SEARCH, {
    // Drop the cached list so the page refetches it with the new entry.
    update(cache, { data }) {
      if (data?.createSavedSearch?.success) {
        cache.evict({ id: 'ROOT_QUERY', fieldName: 'savedSearches' });
        cache.gc();
      }
    },
  });

  const handleCreate = async () => {
    const trimmed = name.trim();

    if (!trimmed) {
      return;
    }

    try {
      const result = await createSavedSearch({
        variables: {
          input: {
            name: trimmed,
            description: description.trim() || undefined,
            query: query.trim() || undefined,
            entityTypes: selectedEntityTypes.map(
              (type) => ENTITY_TYPE_MAP[type as keyof typeof ENTITY_TYPE_MAP],
            ),
            filters: toFiltersInput(filters),
          },
        },
      });

      if (result.data?.createSavedSearch?.savedSearch) {
        toast.success(`Saved search “${trimmed}”`);
        onClose();
      } else {
        toast.error('Failed to create saved search');
      }
    } catch {
      toast.error('Failed to create saved search');
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content className="sm:max-w-[600px]">
        <Dialog.Header>
          <Dialog.Title>New Saved Search</Dialog.Title>
          <Dialog.Description>
            Define a reusable search: a query, entity types, and any who / where / when / how / sort filters.
            You can also save whatever you are currently searching from Memory's advanced filters.
          </Dialog.Description>
        </Dialog.Header>

        <div className="max-h-[65vh] space-y-4 overflow-y-auto py-4 pr-1">
          <div className="space-y-2">
            <Label htmlFor="create-saved-search-name">Name</Label>
            <Input
              id="create-saved-search-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Work emails this month"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="create-saved-search-description">Description</Label>
            <Textarea
              id="create-saved-search-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Enter search description"
              rows={3}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="create-saved-search-query">Query</Label>
            <Input
              id="create-saved-search-query"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Enter search query"
            />
          </div>

          <div className="space-y-2">
            <Label>Entity Types</Label>
            <EntityTypeFilter modal={true} />
          </div>

          <div className="space-y-2 border-t border-border pt-4">
            <Label>Filters</Label>
            <p className="text-xs text-muted-foreground">
              The who / where / when / how / sort applied whenever this search runs.
            </p>
            <SavedSearchFiltersEditor value={filters} onChange={setFilters} vocabulary={vocabulary} />
          </div>
        </div>

        <Dialog.Footer>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={loading || !name.trim()}>
            {loading ? 'Creating…' : 'Create'}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog>
  );
}

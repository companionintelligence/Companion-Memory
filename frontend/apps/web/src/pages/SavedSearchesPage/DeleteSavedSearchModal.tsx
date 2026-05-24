import { useMutation, type Reference, isReference } from '@apollo/client';
import { Button, Dialog } from '@ci/shadcn';

import { gql } from '@/graphql';

interface Props {
  savedSearchId: string;
  onClose: () => void;
}

const DELETE_SAVED_SEARCH = gql(`
  mutation DeleteSavedSearch($input: DeleteByIdInput!) {
    deleteSavedSearch(input: $input) {
      success
      deletedId
    }
  }
`);

export function DeleteSavedSearchModal({ savedSearchId, onClose }: Props) {
  const [deleteSavedSearch, { loading: deleting }] = useMutation(DELETE_SAVED_SEARCH, {
    update(cache, { data }) {
      const deletedSavedSearchId = data?.deleteSavedSearch?.deletedId;

      if (deletedSavedSearchId) {
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
                edges: existingSavedSearches.edges.filter((edge) => {
                  const edgeNodeId = readField('id', edge.node);

                  return edgeNodeId !== deletedSavedSearchId;
                }),
              };
            },
          },
        });

        const normalizedId = cache.identify({
          id: deletedSavedSearchId,
          __typename: 'SavedSearchType',
        });

        if (normalizedId) {
          cache.evict({ id: normalizedId });
          cache.gc();
        }
      }
    },
  });

  const handleDelete = async () => {
    await deleteSavedSearch({
      variables: {
        input: {
          id: savedSearchId,
        },
      },
    });

    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content className="sm:max-w-[425px]">
        <Dialog.Header>
          <Dialog.Title>Delete Saved Search</Dialog.Title>
          <Dialog.Description>
            Are you sure you want to delete this Saved Search? This action cannot be undone.
          </Dialog.Description>
        </Dialog.Header>
        <Dialog.Footer>
          <Button variant="outline" onClick={onClose} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting ? 'Deleting...' : 'Delete'}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog>
  );
}

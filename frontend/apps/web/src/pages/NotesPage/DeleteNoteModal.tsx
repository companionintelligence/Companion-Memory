import { useMutation, type Reference, isReference } from '@apollo/client';
import { Button, Dialog } from '@ci/shadcn';

import { gql } from '@/graphql';

interface Props {
  noteId: string;
  onClose: () => void;
}

const DELETE_NOTE = gql(`
  mutation DeleteNote($input: DeleteByIdInput!) {
    deleteNote(input: $input) {
      success
      deletedId
    }
  }
`);

export function DeleteNoteModal({ noteId, onClose }: Props) {
  const [deleteNote, { loading: deleting }] = useMutation(DELETE_NOTE, {
    update(cache, { data }) {
      const deletedNoteId = data?.deleteNote?.deletedId;

      if (deletedNoteId) {
        cache.modify({
          fields: {
            notes(
              existingNotes:
                | {
                    edges: { node: Reference }[];
                  }
                | Reference = { edges: [] },
              { readField },
            ) {
              if (isReference(existingNotes)) {
                return existingNotes;
              }

              return {
                ...existingNotes,
                edges: existingNotes.edges.filter((edge) => {
                  const edgeNodeId = readField('id', edge.node);

                  return edgeNodeId !== deletedNoteId;
                }),
              };
            },
          },
        });

        const normalizedId = cache.identify({
          id: deletedNoteId,
          __typename: 'NoteType',
        });

        if (normalizedId) {
          cache.evict({ id: normalizedId });
          cache.gc();
        }
      }
    },
  });

  const handleDelete = async () => {
    await deleteNote({
      variables: {
        input: {
          id: noteId,
        },
      },
    });

    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content className="sm:max-w-[425px]">
        <Dialog.Header>
          <Dialog.Title>Delete note</Dialog.Title>
          <Dialog.Description>
            Are you sure you want to delete this note? This action cannot be undone.
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

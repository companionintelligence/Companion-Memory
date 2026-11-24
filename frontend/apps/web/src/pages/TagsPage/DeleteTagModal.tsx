import { useState } from 'react';

import { useMutation } from '@apollo/client/react';
import { Button, Dialog } from '@ci/shadcn';

import { gql } from '@/graphql';

import { evictTag, type TagListItem } from './tagList';

interface Props {
  tag: TagListItem;
  onClose: () => void;
  onDeleted: () => void;
}

const DELETE_TAG = gql(`
  mutation DeleteTag($input: DeleteByIdInput!) {
    deleteTag(input: $input) {
      success
      deletedId
    }
  }
`);

export function DeleteTagModal({ tag, onClose, onDeleted }: Props) {
  const [deleteTag, { loading: deleting }] = useMutation(DELETE_TAG, {
    update(cache, { data }) {
      // Drop the tag from the normalized cache rather than just this page's
      // query: the Memory explorer's tag filter runs its own `GetTags`, and
      // Apollo prunes dangling references out of the edge lists for us.
      if (data?.deleteTag?.deletedId) {
        evictTag(cache, data.deleteTag.deletedId);
      }
    },
  });
  const [error, setError] = useState<string | null>(null);

  const handleDelete = async () => {
    setError(null);

    try {
      const { data } = await deleteTag({
        variables: {
          input: {
            id: tag.id,
          },
        },
      });

      if (!data?.deleteTag.success) {
        setError('Could not delete this tag. Please try again.');

        return;
      }

      onDeleted();
      onClose();
    } catch {
      // Leave the dialog open on failure — closing it would read as a delete.
      setError('Could not delete this tag. Please try again.');
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content className="sm:max-w-[425px]">
        <Dialog.Header>
          <Dialog.Title>Delete “{tag.label}”?</Dialog.Title>
          <Dialog.Description>
            {tag.entityCount === 0
              ? 'Nothing is tagged with it. This cannot be undone.'
              : `It will be removed from ${
                  tag.entityCount === 1 ? '1 item' : `${tag.entityCount} items`
                }. Those items stay in your memory — they just stop carrying this tag. This cannot be undone.`}
          </Dialog.Description>
        </Dialog.Header>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <Dialog.Footer>
          <Button variant="outline" onClick={onClose} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete tag'}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog>
  );
}

import { isReference, useMutation, type Reference } from '@apollo/client';
import { Button, Dialog } from '@ci/shadcn';

import { gql } from '@/graphql';

interface Props {
  taskId: string;
  onClose: () => void;
}

const DELETE_TASK = gql(`
  mutation DeleteTask($input: DeleteByIdInput!) {
    deleteTask(input: $input) {
      success
      deletedId
    }
  }
`);

export function DeleteTaskModal({ taskId, onClose }: Props) {
  const [deleteTask, { loading: deleting }] = useMutation(DELETE_TASK, {
    // There are no subscriptions in this app, so the cache is updated by hand
    // rather than waiting for a push. Same shape as DeleteNoteModal.
    update(cache, { data }) {
      const deletedTaskId = data?.deleteTask?.deletedId;

      if (!deletedTaskId) {
        return;
      }

      cache.modify({
        fields: {
          tasks(existingTasks: { edges: { node: Reference }[] } | Reference = { edges: [] }, { readField }) {
            if (isReference(existingTasks)) {
              return existingTasks;
            }

            return {
              ...existingTasks,
              edges: existingTasks.edges.filter((edge) => readField('id', edge.node) !== deletedTaskId),
            };
          },
        },
      });

      const normalizedId = cache.identify({ id: deletedTaskId, __typename: 'TaskType' });

      if (normalizedId) {
        cache.evict({ id: normalizedId });
        cache.gc();
      }
    },
  });

  const handleDelete = async () => {
    await deleteTask({ variables: { input: { id: taskId } } });

    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content className="sm:max-w-[425px]">
        <Dialog.Header>
          <Dialog.Title>Delete task</Dialog.Title>
          <Dialog.Description>
            Are you sure you want to delete this task? This action cannot be undone.
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

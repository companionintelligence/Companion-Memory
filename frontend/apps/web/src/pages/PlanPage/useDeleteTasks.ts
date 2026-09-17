import { isReference, useMutation, type Reference } from '@apollo/client';
import { useToast } from '@ci/shadcn';

import { gql } from '@/graphql';

export const DELETE_TASK = gql(`
  mutation DeleteTask($input: DeleteByIdInput!) {
    deleteTask(input: $input) {
      success
      deletedId
    }
  }
`);

/**
 * Deletes plan tasks and evicts them from the cached list. The hook itself
 * never confirms: the per-row trash control is deliberately the decision (one
 * task, one deliberate click), while PlanPage's selection-bar bulk delete
 * confirms in an AlertDialog first, because that path can take out an entire
 * multi-row selection at once. Failures toast instead of opening a dialog.
 */
export function useDeleteTasks() {
  const { toast } = useToast();
  const [deleteTask, { loading: deleting }] = useMutation(DELETE_TASK, {
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

  const deleteTasks = async (taskIds: string[]): Promise<boolean> => {
    const many = taskIds.length > 1;

    try {
      const failed: string[] = [];

      for (const id of taskIds) {
        const { data } = await deleteTask({ variables: { input: { id } } });

        if (!data?.deleteTask?.success) {
          failed.push(id);
        }
      }

      if (failed.length > 0) {
        toast.error(
          failed.length === taskIds.length
            ? many
              ? 'Could not delete these tasks. Please try again.'
              : 'Could not delete this task. Please try again.'
            : `Deleted ${taskIds.length - failed.length} of ${taskIds.length}. The rest could not be deleted — please try again.`,
        );

        return false;
      }

      return true;
    } catch {
      toast.error(
        many
          ? 'Could not delete these tasks. Please try again.'
          : 'Could not delete this task. Please try again.',
      );

      return false;
    }
  };

  return { deleteTasks, deleting };
}

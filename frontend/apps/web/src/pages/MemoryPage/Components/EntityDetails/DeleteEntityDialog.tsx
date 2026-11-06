import { useState } from 'react';

import { useApolloClient, useMutation } from '@apollo/client/react';
import { Button, Dialog, useToast } from '@ci/shadcn';
import { Loader2 } from '@ci/shadcn/icons';

import {
  RESTORE_EVENT,
  type DeleteMutationData,
  type DeleteMutationVariables,
  type DeleteTarget,
} from './deleteTargets';

interface Props {
  /** Which mutation to run and how to describe what it removes. */
  target: DeleteTarget;
  /** Global (GlobalUID) id of the entity being removed. */
  entityId: string;
  /** GraphQL `__typename`, when the entity came from a typed search result. */
  typename?: string;
  /** Human label for the entity, shown in the confirmation. */
  title: string;
  onClose: () => void;
  /** Called once the entity is gone, so the drawer can close itself. */
  onDeleted: () => void;
  /** Called after a successful undo, so the list can pick the entity back up. */
  onRestored: () => void;
}

/**
 * Confirmation for removing a memory object, and — for the types that are
 * tombstoned rather than destroyed — the "Undo" that follows it.
 *
 * The copy deliberately distinguishes the two: a hard delete says the data is
 * gone for good, a soft delete says it can be restored, because the user has no
 * other way to tell which one they are about to do.
 */
export function DeleteEntityDialog({
  target,
  entityId,
  typename,
  title,
  onClose,
  onDeleted,
  onRestored,
}: Props) {
  const client = useApolloClient();
  const { toast } = useToast();
  const [error, setError] = useState<string | null>(null);

  const [runDelete, { loading: deleting }] = useMutation<DeleteMutationData, DeleteMutationVariables>(
    target.document,
  );
  const [runRestore] = useMutation<Record<string, { id: string } | null>, DeleteMutationVariables>(
    RESTORE_EVENT,
  );

  /**
   * Drop the entity from the cached explorer results immediately. `search`
   * edges are plain objects rather than references, so Apollo's dangling-ref
   * cleanup cannot do it for us — the edge has to be filtered out by hand, and
   * only then is the normalized object safe to evict.
   */
  const forgetEntity = () => {
    client.cache.modify({
      fields: {
        search(existing: unknown) {
          if (
            existing == null ||
            typeof existing !== 'object' ||
            !('edges' in existing) ||
            !Array.isArray((existing as { edges: unknown }).edges)
          ) {
            return existing;
          }

          const connection = existing as {
            edges: Array<{ node?: { __ref?: string } }>;
            totalCount?: number;
          };
          const evictedRef = typename ? client.cache.identify({ __typename: typename, id: entityId }) : null;
          const edges = connection.edges.filter((edge) => edge.node?.__ref !== evictedRef);

          if (edges.length === connection.edges.length) {
            return existing;
          }

          return {
            ...connection,
            edges,
            ...(typeof connection.totalCount === 'number'
              ? { totalCount: Math.max(0, connection.totalCount - 1) }
              : {}),
          };
        },
      },
    });

    if (typename) {
      const normalizedId = client.cache.identify({ __typename: typename, id: entityId });

      if (normalizedId) {
        client.cache.evict({ id: normalizedId });
        client.cache.gc();
      }
    }
  };

  const handleRestore = async () => {
    try {
      const result = await runRestore({ variables: { input: { id: entityId } } });

      if (!result.data?.restoreEvent) {
        throw new Error('Restore was rejected');
      }

      onRestored();
      toast.success(`Restored this ${target.noun}.`);
    } catch {
      toast.error(`Couldn't restore this ${target.noun}.`);
    }
  };

  const handleDelete = async () => {
    setError(null);

    try {
      const result = await runDelete({ variables: { input: { id: entityId } } });

      if (!result.data?.[target.field]?.success) {
        throw new Error('Delete was rejected');
      }

      forgetEntity();
      onDeleted();

      toast.success(
        `Deleted ${title ? `“${title}”` : `this ${target.noun}`}.`,
        target.recoverable ? { action: { label: 'Undo', onClick: () => void handleRestore() } } : undefined,
      );
    } catch {
      setError(`Could not delete this ${target.noun}. Please try again.`);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content className="z-[1100] sm:max-w-[425px]">
        <Dialog.Header>
          <Dialog.Title>Delete {target.noun}?</Dialog.Title>
          <Dialog.Description>
            {target.recoverable ? (
              <>
                {title ? (
                  <span className="font-medium text-foreground">“{title}”</span>
                ) : (
                  `This ${target.noun}`
                )}{' '}
                will be removed from your memory and stop appearing in search. You can undo this straight
                after, from the confirmation that appears.
              </>
            ) : (
              <>
                {title ? (
                  <span className="font-medium text-foreground">“{title}”</span>
                ) : (
                  `This ${target.noun}`
                )}{' '}
                will be permanently deleted from your memory, along with its tags and links to other things.
                This cannot be undone.
              </>
            )}
          </Dialog.Description>
        </Dialog.Header>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Dialog.Footer>
          <Button variant="outline" onClick={onClose} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting && <Loader2 className="size-4 animate-spin" />}
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog>
  );
}

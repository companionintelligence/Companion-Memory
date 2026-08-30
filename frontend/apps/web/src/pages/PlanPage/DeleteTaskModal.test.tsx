import { gql as apolloGql, useQuery } from '@apollo/client';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { gql } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { DeleteTaskModal } from './DeleteTaskModal';

const DELETE_TASK = gql(`
  mutation DeleteTask($input: DeleteByIdInput!) {
    deleteTask(input: $input) {
      success
      deletedId
    }
  }
`);

/**
 * A standalone query for this test only, deliberately not the page's full
 * `GET_TASKS` (with its `TaskRowFragment`). `cache.modify`'s `tasks` field
 * function runs for every stored variant of that field name regardless of
 * arguments or which query populated it, so this minimal shape is enough to
 * prove the modal's manual cache surgery — the eviction and the list-edge
 * filter — actually removes the row, not just that the mutation was sent.
 */
const LIST_TASKS = apolloGql(`
  query ListTasksForTest {
    tasks(first: 10) {
      edges {
        node {
          id
          title
        }
      }
    }
  }
`);

interface ListNode {
  id: string;
  title: string;
}

function listMock(nodes: ListNode[]) {
  return {
    request: { query: LIST_TASKS },
    result: {
      data: {
        tasks: {
          __typename: 'TaskConnection',
          edges: nodes.map((n) => ({ __typename: 'TaskEdge', node: { __typename: 'TaskType', ...n } })),
        },
      },
    },
  };
}

function deleteMock(id: string, deletedId: string | null = id) {
  return {
    request: { query: DELETE_TASK, variables: { input: { id } } },
    result: {
      data: { deleteTask: { __typename: 'DeleteTaskPayload', success: Boolean(deletedId), deletedId } },
    },
  };
}

function ListAndModal({
  taskId,
  onClose,
  extraIds = [],
}: {
  taskId: string;
  onClose: () => void;
  extraIds?: string[];
}) {
  const { data } = useQuery<{ tasks: { edges: { node: ListNode }[] } }>(LIST_TASKS);
  const titles = data?.tasks.edges.map((edge) => edge.node.title) ?? [];

  return (
    <>
      <ul>
        {titles.map((title) => (
          <li key={title}>{title}</li>
        ))}
      </ul>
      <DeleteTaskModal taskIds={[taskId, ...extraIds]} onClose={onClose} />
    </>
  );
}

describe('DeleteTaskModal', () => {
  it('asks for confirmation before deleting anything', () => {
    const onClose = vi.fn();
    renderWithProviders(<DeleteTaskModal taskIds={['t1']} onClose={onClose} />, {
      mocks: [deleteMock('t1')],
    });

    expect(screen.getByText('Delete task')).toBeInTheDocument();
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
  });

  it('cancels without sending a delete', () => {
    const onClose = vi.fn();
    // No delete mock supplied: if Cancel triggered a mutation, MockedProvider
    // would surface an unmatched-request error.
    renderWithProviders(<DeleteTaskModal taskIds={['t1']} onClose={onClose} />, { mocks: [] });

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('deletes on confirm and evicts the row from a cached list, leaving the others', async () => {
    const onClose = vi.fn();

    renderWithProviders(<ListAndModal taskId="t1" onClose={onClose} />, {
      mocks: [
        listMock([
          { id: 't1', title: 'Write the migration' },
          { id: 't2', title: 'Review the PR' },
        ]),
        deleteMock('t1'),
      ],
    });

    await screen.findByText('Write the migration');
    expect(screen.getByText('Review the PR')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    // The deleted task's row is gone from the list query the mutation's
    // `update` reached into by hand — the other one is untouched.
    await waitFor(() => expect(screen.queryByText('Write the migration')).not.toBeInTheDocument());
    expect(screen.getByText('Review the PR')).toBeInTheDocument();
  });

  it('shows a busy state while the delete is in flight, then completes', async () => {
    const onClose = vi.fn();

    renderWithProviders(<DeleteTaskModal taskIds={['t1']} onClose={onClose} />, {
      mocks: [{ ...deleteMock('t1'), delay: 20 }],
    });

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    // Apollo flips `loading` synchronously on calling the mutate function, before
    // the (delayed) network response resolves — both buttons must reflect it.
    expect(screen.getByText('Deleting...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeDisabled();
    expect(screen.getByText('Deleting...').closest('button')).toBeDisabled();

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('shows an error and keeps the dialog open — not a silent close — when the delete fails', async () => {
    const onClose = vi.fn();

    renderWithProviders(<DeleteTaskModal taskIds={['t1']} onClose={onClose} />, {
      mocks: [
        {
          request: { query: DELETE_TASK, variables: { input: { id: 't1' } } },
          error: new Error('network down'),
        },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    expect(await screen.findByText(/could not delete this task/i)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    // Ready to retry, not stuck on "Deleting...".
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeEnabled();
  });

  it('asks once before deleting several tasks, then removes each row', async () => {
    const onClose = vi.fn();

    renderWithProviders(<ListAndModal taskId="t1" onClose={onClose} extraIds={['t2']} />, {
      mocks: [
        listMock([
          { id: 't1', title: 'Write the migration' },
          { id: 't2', title: 'Review the PR' },
        ]),
        deleteMock('t1'),
        deleteMock('t2'),
      ],
    });

    expect(await screen.findByText('Delete 2 tasks')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText('Write the migration')).not.toBeInTheDocument());
    expect(screen.queryByText('Review the PR')).not.toBeInTheDocument();
  });

  // ═══ A REFUSED DELETE DOES NOT THROW ═══
  //
  // `TaskResolver.deleteTask` returns `{ success: false }` with no error when
  // the row is missing or not the caller's. The dialog used to ignore every
  // payload and close regardless, so a refusal looked exactly like a delete —
  // and the task came back on the next refetch with nothing said.
  it('stays open and says so when the server refuses the delete', async () => {
    const onClose = vi.fn();

    renderWithProviders(<ListAndModal taskId="t1" onClose={onClose} />, {
      mocks: [listMock([{ id: 't1', title: 'Write the migration' }]), deleteMock('t1', null)],
    });

    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));

    expect(await screen.findByText(/could not delete this task/i)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    // And the row it refused to delete is still on screen.
    expect(screen.getByText('Write the migration')).toBeInTheDocument();
  });

  // The case a bulk delete makes invisible: some rows went, some did not.
  it('names how many survived a partial bulk failure', async () => {
    const onClose = vi.fn();

    renderWithProviders(<ListAndModal taskId="t1" onClose={onClose} extraIds={['t2']} />, {
      mocks: [
        listMock([
          { id: 't1', title: 'Write the migration' },
          { id: 't2', title: 'Review the PR' },
        ]),
        deleteMock('t1'),
        deleteMock('t2', null),
      ],
    });

    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));

    expect(await screen.findByText(/deleted 1 of 2/i)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

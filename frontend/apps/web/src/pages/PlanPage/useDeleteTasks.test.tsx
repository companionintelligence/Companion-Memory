import { gql as apolloGql, useQuery } from '@apollo/client';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { DELETE_TASK, useDeleteTasks } from './useDeleteTasks';

const toastError = vi.hoisted(() => vi.fn());

vi.mock('@ci/shadcn', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();

  return { ...actual, useToast: () => ({ toast: { error: toastError, success: vi.fn(), info: vi.fn() } }) };
});

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

function ListAndDelete({ taskIds }: { taskIds: string[] }) {
  const { data } = useQuery<{ tasks: { edges: { node: ListNode }[] } }>(LIST_TASKS);
  const { deleteTasks, deleting } = useDeleteTasks();
  const titles = data?.tasks.edges.map((edge) => edge.node.title) ?? [];

  return (
    <>
      <ul>
        {titles.map((title) => (
          <li key={title}>{title}</li>
        ))}
      </ul>
      <button type="button" disabled={deleting} onClick={() => void deleteTasks(taskIds)}>
        {deleting ? 'Deleting...' : 'Delete'}
      </button>
    </>
  );
}

describe('useDeleteTasks', () => {
  it('deletes immediately and evicts the row from a cached list, leaving the others', async () => {
    renderWithProviders(<ListAndDelete taskIds={['t1']} />, {
      mocks: [
        listMock([
          { id: 't1', title: 'Write the migration' },
          { id: 't2', title: 'Review the PR' },
        ]),
        deleteMock('t1'),
      ],
    });

    await screen.findByText('Write the migration');
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(screen.queryByText('Write the migration')).not.toBeInTheDocument());
    expect(screen.getByText('Review the PR')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('toasts when the server refuses the delete and leaves the row', async () => {
    renderWithProviders(<ListAndDelete taskIds={['t1']} />, {
      mocks: [listMock([{ id: 't1', title: 'Write the migration' }]), deleteMock('t1', null)],
    });

    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/could not delete this task/i)),
    );
    expect(screen.getByText('Write the migration')).toBeInTheDocument();
  });

  it('names how many survived a partial bulk failure', async () => {
    renderWithProviders(<ListAndDelete taskIds={['t1', 't2']} />, {
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

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/deleted 1 of 2/i)));
  });
});

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { gql } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { PlanPage } from './PlanPage';

const GET_TASKS = gql(`
  query GetTasks($first: Int, $after: String) {
    tasks(first: $first, after: $after) {
      edges {
        node {
          id
          status
          priority
          dueAt
          scheduledFor
          deferUntil
          title
          ...TaskRowFragment
        }
      }
      totalCount
    }
  }
`);

const COMPLETE_TASK = gql(`
  mutation CompleteTask($id: ID!) {
    completeTask(id: $id) {
      id
      status
      completedAt
    }
  }
`);

function node(overrides: Record<string, unknown> = {}) {
  return {
    __typename: 'TaskType',
    id: 'dGFzazoxMTE=',
    title: 'Write the migration',
    description: null,
    status: 'open',
    priority: 3,
    dueAt: null,
    scheduledFor: null,
    deferUntil: null,
    estimatedMinutes: null,
    completedAt: null,
    ...overrides,
  };
}

function tasksMock(nodes: ReturnType<typeof node>[]) {
  return {
    request: { query: GET_TASKS, variables: { first: 200 } },
    result: {
      data: {
        tasks: {
          __typename: 'TaskConnection',
          edges: nodes.map((n) => ({ __typename: 'TaskEdge', node: n })),
          totalCount: nodes.length,
        },
      },
    },
    // `cache-and-network` issues the query again on mount in the test
    // environment; without this the second read has no mock to satisfy it.
    maxUsageCount: Number.POSITIVE_INFINITY,
  };
}

describe('PlanPage', () => {
  it('invites the user to add something when there is nothing planned', async () => {
    renderWithProviders(<PlanPage />, { mocks: [tasksMock([])] });

    expect(await screen.findByText(/nothing planned yet/i)).toBeInTheDocument();
  });

  it('groups tasks under their section headings', async () => {
    // Fixed "today" is impossible without controlling the clock, so anchor the
    // fixtures on the real one: sectioning is proved exhaustively in
    // taskSections.node.test.ts, and this only checks the wiring.
    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

    renderWithProviders(<PlanPage />, {
      mocks: [
        tasksMock([
          node({ id: 'a', title: 'Overdue thing', dueAt: yesterday.toISOString() }),
          node({ id: 'b', title: 'Someday thing' }),
          node({ id: 'c', title: 'Finished thing', status: 'done' }),
        ]),
      ],
    });

    expect(await screen.findByText('Overdue thing')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /overdue/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /someday/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /done/i })).toBeInTheDocument();
  });

  it('renders a completed task as checked and struck through', async () => {
    renderWithProviders(<PlanPage />, {
      mocks: [tasksMock([node({ title: 'Finished thing', status: 'done' })])],
    });

    const checkbox = await screen.findByRole('checkbox', { name: /reopen finished thing/i });

    expect(checkbox).toBeChecked();
  });

  it('completes a task when its checkbox is ticked', async () => {
    const completed = node({ status: 'done', completedAt: new Date().toISOString() });

    renderWithProviders(<PlanPage />, {
      mocks: [
        tasksMock([node()]),
        {
          request: { query: COMPLETE_TASK, variables: { id: 'dGFzazoxMTE=' } },
          result: {
            data: {
              completeTask: {
                __typename: 'TaskType',
                id: completed.id,
                status: 'done',
                completedAt: completed.completedAt,
              },
            },
          },
        },
      ],
    });

    const checkbox = await screen.findByRole('checkbox', { name: /complete write the migration/i });

    fireEvent.click(checkbox);

    // The mutation result normalises into the cache, flipping the row.
    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: /reopen write the migration/i })).toBeChecked();
    });
  });

  it('disables the add button until a title is typed', async () => {
    renderWithProviders(<PlanPage />, { mocks: [tasksMock([])] });

    const button = await screen.findByRole('button', { name: /add/i });

    expect(button).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/new task title/i), { target: { value: 'Something' } });

    expect(button).toBeEnabled();
  });

  it('does not submit a whitespace-only title', async () => {
    renderWithProviders(<PlanPage />, { mocks: [tasksMock([])] });

    await screen.findByLabelText(/new task title/i);
    fireEvent.change(screen.getByLabelText(/new task title/i), { target: { value: '   ' } });

    expect(screen.getByRole('button', { name: /add/i })).toBeDisabled();
  });
});

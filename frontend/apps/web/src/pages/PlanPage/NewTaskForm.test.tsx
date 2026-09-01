import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { gql } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { NewTaskForm } from './NewTaskForm';

const CREATE_TASK = gql(`
  mutation CreateTask($input: CreateTaskInput!) {
    createTask(input: $input) {
      success
      task {
        id
        ...TaskRowFragment
      }
    }
  }
`);

function taskNode(overrides: Record<string, unknown> = {}) {
  return {
    __typename: 'TaskType',
    id: 'new-task-1',
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

function createMock(title: string, response: { success: boolean; task?: unknown }) {
  return {
    request: { query: CREATE_TASK, variables: { input: { title } } },
    result: {
      data: {
        createTask: { __typename: 'CreateTaskPayload', task: null, ...response },
      },
    },
  };
}

async function typeAndSubmit(title: string) {
  fireEvent.change(screen.getByLabelText(/new task title/i), { target: { value: title } });
  fireEvent.click(screen.getByRole('button', { name: /add/i }));
}

describe('NewTaskForm', () => {
  it('creates a task with the trimmed title, clears the field, and notifies the list', async () => {
    const onCreated = vi.fn();

    renderWithProviders(<NewTaskForm onCreated={onCreated} />, {
      mocks: [createMock('Write the migration', { success: true, task: taskNode() })],
    });

    // Leading/trailing whitespace is trimmed before it ever reaches the mutation —
    // the mock only matches the trimmed variable, so a raw send would 404 here.
    await typeAndSubmit('  Write the migration  ');

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText(/new task title/i)).toHaveValue('');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/new task title/i)).toHaveFocus());
  });

  it('does not submit a blank or whitespace-only title', () => {
    const onCreated = vi.fn();
    // No mock registered: a send here would surface as an unmatched-request error.
    renderWithProviders(<NewTaskForm onCreated={onCreated} />, { mocks: [] });

    fireEvent.click(screen.getByRole('button', { name: /add/i }));
    expect(onCreated).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/new task title/i), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: /add/i }));
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('shows an error and keeps the title in the box when the server refuses the write', async () => {
    // The resolver reports a refused write as `success: false` rather than
    // throwing — the form has to check the payload, not just catch.
    const onCreated = vi.fn();

    renderWithProviders(<NewTaskForm onCreated={onCreated} />, {
      mocks: [createMock('Bad task', { success: false })],
    });

    await typeAndSubmit('Bad task');

    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.t be saved/i);
    expect(onCreated).not.toHaveBeenCalled();
    // Not cleared — losing what was typed on a refusal would make the user retype it.
    expect(screen.getByLabelText(/new task title/i)).toHaveValue('Bad task');
  });

  it('shows an error and keeps the title in the box on a network failure', async () => {
    const onCreated = vi.fn();

    renderWithProviders(<NewTaskForm onCreated={onCreated} />, {
      mocks: [
        {
          request: { query: CREATE_TASK, variables: { input: { title: 'Offline task' } } },
          error: new Error('network down'),
        },
      ],
    });

    await typeAndSubmit('Offline task');

    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.t be saved/i);
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/new task title/i)).toHaveValue('Offline task');
  });

  it('disables the input and button while the create is in flight', async () => {
    renderWithProviders(<NewTaskForm onCreated={vi.fn()} />, {
      mocks: [{ ...createMock('Slow task', { success: true, task: taskNode() }), delay: 20 }],
    });

    await typeAndSubmit('Slow task');

    // Apollo flips `loading` synchronously on calling the mutate function.
    expect(screen.getByLabelText(/new task title/i)).toBeDisabled();
    expect(screen.getByRole('button', { name: /add/i })).toBeDisabled();

    await waitFor(() => expect(screen.getByLabelText(/new task title/i)).toBeEnabled());
  });

  it('clears a previous error once a retry succeeds', async () => {
    const onCreated = vi.fn();

    renderWithProviders(<NewTaskForm onCreated={onCreated} />, {
      mocks: [
        createMock('Retry me', { success: false }),
        createMock('Retry me', { success: true, task: taskNode({ title: 'Retry me' }) }),
      ],
    });

    await typeAndSubmit('Retry me');
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: /add/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

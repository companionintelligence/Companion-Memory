import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { gql } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { EditTaskModal } from './EditTaskModal';

const UPDATE_TASK = gql(`
  mutation UpdateTask($input: UpdateTaskInput!) {
    updateTask(input: $input) {
      success
      task {
        id
        ...TaskRowFragment
      }
    }
  }
`);

const TASK = {
  id: 'dGFzazoxMTE=',
  title: 'Write the migration',
  description: 'First draft',
  dueAt: null,
  estimatedMinutes: 30,
};

function updatedNode() {
  return {
    __typename: 'TaskType' as const,
    id: TASK.id,
    title: 'Write the migration notes',
    description: 'First draft',
    status: 'open',
    priority: 3,
    parentId: null,
    dueAt: null,
    scheduledFor: null,
    deferUntil: null,
    estimatedMinutes: 45,
    completedAt: null,
  };
}

describe('EditTaskModal', () => {
  it('opens with the current title and notes', () => {
    renderWithProviders(<EditTaskModal task={TASK} onClose={vi.fn()} />, { mocks: [] });

    expect(screen.getByRole('dialog', { name: /edit task/i })).toBeInTheDocument();
    const titleField = screen.getByLabelText(/^title$/i);

    expect(titleField.tagName).toBe('TEXTAREA');
    expect(titleField).toHaveValue('Write the migration');
    expect(screen.getByLabelText(/^notes$/i)).toHaveValue('First draft');
    expect(screen.getByLabelText(/^minutes$/i)).toHaveValue(30);
  });

  it('cancels without sending an update', () => {
    const onClose = vi.fn();
    renderWithProviders(<EditTaskModal task={TASK} onClose={onClose} />, { mocks: [] });

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('saves a new title and estimate', async () => {
    const onClose = vi.fn();
    const onSaved = vi.fn();

    renderWithProviders(<EditTaskModal task={TASK} onClose={onClose} onSaved={onSaved} />, {
      mocks: [
        {
          request: {
            query: UPDATE_TASK,
            variables: {
              input: {
                id: TASK.id,
                title: 'Write the migration notes',
                description: 'First draft',
                dueAt: null,
                estimatedMinutes: 45,
              },
            },
          },
          result: {
            data: {
              updateTask: {
                __typename: 'UpdateTaskPayload',
                success: true,
                task: updatedNode(),
              },
            },
          },
        },
      ],
    });

    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: 'Write the migration notes' } });
    fireEvent.change(screen.getByLabelText(/^minutes$/i), { target: { value: '45' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('refuses a blank title', () => {
    renderWithProviders(<EditTaskModal task={TASK} onClose={vi.fn()} />, { mocks: [] });

    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: '   ' } });

    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });
});

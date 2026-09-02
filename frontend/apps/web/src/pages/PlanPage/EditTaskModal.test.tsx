import { fireEvent, screen, waitFor } from '@testing-library/react';
import { GraphQLError } from 'graphql';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { EditTaskModal, UPDATE_TASK } from './EditTaskModal';

const TASK = {
  id: 'dGFzazoxMTE=',
  title: 'Write the migration',
  description: 'First draft',
  dueAt: null,
  estimatedMinutes: 30,
};

function updatedTask(title = 'Write the migration notes') {
  return {
    __typename: 'TaskType' as const,
    id: TASK.id,
    title,
    description: 'First draft',
    status: 'open',
    priority: 3,
    parentId: null,
    dueAt: null,
    scheduledFor: null,
    placedOnCalendar: false,
    deferUntil: null,
    estimatedMinutes: 45,
    completedAt: null,
  };
}

function updateMock(title: string, extra: { errors?: GraphQLError[] } = {}) {
  return {
    request: {
      query: UPDATE_TASK,
      variables: {
        input: {
          id: TASK.id,
          title,
          description: 'First draft',
          dueAt: null,
          estimatedMinutes: 45,
        },
      },
    },
    result: {
      errors: extra.errors,
      data: {
        updateTask: {
          __typename: 'UpdateTaskPayload',
          success: true,
          task: updatedTask(title),
        },
      },
    },
  };
}

describe('EditTaskModal', () => {
  it('opens with the current title and notes', () => {
    renderWithProviders(<EditTaskModal task={TASK} onClose={vi.fn()} />, { mocks: [] });

    expect(screen.getByRole('dialog', { name: /edit task/i })).toBeInTheDocument();
    const titleField = screen.getByLabelText(/^title$/i);

    expect(titleField.tagName).toBe('TEXTAREA');
    expect(titleField).toHaveValue('Write the migration');
    expect(titleField).toHaveClass('break-all');
    expect(titleField).toHaveClass('field-sizing-fixed');
    expect(screen.getByLabelText(/^notes$/i)).toHaveValue('First draft');
    expect(screen.getByLabelText(/^minutes$/i)).toHaveValue(30);
  });

  it('closes without sending when nothing changed', async () => {
    const onClose = vi.fn();
    const onSaved = vi.fn();

    renderWithProviders(<EditTaskModal task={TASK} onClose={onClose} onSaved={onSaved} />, { mocks: [] });

    fireEvent.click(screen.getByRole('button', { name: /^done$/i }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('autosaves a title change without closing', async () => {
    const onClose = vi.fn();
    const onSaved = vi.fn();

    renderWithProviders(<EditTaskModal task={TASK} onClose={onClose} onSaved={onSaved} />, {
      mocks: [updateMock('Write the migration notes')],
    });

    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: 'Write the migration notes' } });
    fireEvent.change(screen.getByLabelText(/^minutes$/i), { target: { value: '45' } });

    await waitFor(() => expect(onSaved).toHaveBeenCalled(), { timeout: 2000 });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/^saved$/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('treats a successful write as saved even when Apollo reports field errors', async () => {
    const onSaved = vi.fn();

    renderWithProviders(<EditTaskModal task={TASK} onClose={vi.fn()} onSaved={onSaved} />, {
      mocks: [
        updateMock('Write the migration notes', {
          errors: [new GraphQLError('Cannot query field placedOnCalendar')],
        }),
      ],
    });

    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: 'Write the migration notes' } });
    fireEvent.change(screen.getByLabelText(/^minutes$/i), { target: { value: '45' } });

    await waitFor(() => expect(onSaved).toHaveBeenCalled(), { timeout: 2000 });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(/^saved$/i)).toBeInTheDocument();
  });

  it('does not save a blank title', async () => {
    const onSaved = vi.fn();

    renderWithProviders(<EditTaskModal task={TASK} onClose={vi.fn()} onSaved={onSaved} />, { mocks: [] });

    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: '   ' } });

    expect(await screen.findByRole('alert')).toHaveTextContent(/title is required/i);
    expect(onSaved).not.toHaveBeenCalled();
  });
});

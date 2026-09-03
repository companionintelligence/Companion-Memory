import { fireEvent, screen, waitFor } from '@testing-library/react';
import { GraphQLError } from 'graphql';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { EditTaskModal, UPDATE_TASK } from './EditTaskModal';

const toastError = vi.hoisted(() => vi.fn());

// Sonner renders nothing without a mounted `<Toaster>`, which this dialog does
// not own — same shim PlanPage.test.tsx uses to assert a toast fired.
vi.mock('@ci/shadcn', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();

  return { ...actual, useToast: () => ({ toast: { error: toastError, success: vi.fn(), info: vi.fn() } }) };
});

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
  beforeEach(() => {
    toastError.mockClear();
  });

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

  // ═══ CLOSING USED TO THROW THE EDIT AWAY ═══
  //
  // `persist` refuses an invalid draft without touching the network, but Done
  // called `onClose()` regardless, so the dialog unmounted with the error still
  // inside it: every unsaved change gone, and no way for the user to learn the
  // edit had not saved.
  it('stays open when Done is pressed on an invalid draft', async () => {
    const onClose = vi.fn();
    const onSaved = vi.fn();

    renderWithProviders(<EditTaskModal task={TASK} onClose={onClose} onSaved={onSaved} />, { mocks: [] });

    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: /^done$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/title is required/i);
    await waitFor(() => expect(screen.getByRole('dialog', { name: /edit task/i })).toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/^title$/i)).toHaveValue('   ');
  });

  // Escape and the backdrop share `onOpenChange` with Done, so they share the
  // same refusal.
  it('stays open when Escape is pressed on an invalid draft', async () => {
    const onClose = vi.fn();

    renderWithProviders(<EditTaskModal task={TASK} onClose={onClose} />, { mocks: [] });

    fireEvent.change(screen.getByLabelText(/^minutes$/i), { target: { value: '0' } });
    fireEvent.keyDown(screen.getByRole('dialog', { name: /edit task/i }), { key: 'Escape' });

    expect(await screen.findByRole('alert')).toHaveTextContent(/positive number/i);
    await waitFor(() => expect(screen.getByRole('dialog', { name: /edit task/i })).toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
  });

  // ═══ …AND THEN USED TO TRAP THE USER IN IT ═══
  //
  // Holding the dialog open on ANY refusal caught the failed SAVE too. Done,
  // Escape, the backdrop and the X all funnel through one `onOpenChange`, so an
  // offline user had no exit from this dialog at all short of reloading the
  // page. A draft the user can fix is worth staying open for; a network that is
  // gone is not.
  it('lets the user out when the save fails, and says the change was not kept', async () => {
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
                estimatedMinutes: 30,
              },
            },
          },
          error: new Error('offline'),
          maxUsageCount: Number.POSITIVE_INFINITY,
        },
      ],
    });

    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: 'Write the migration notes' } });
    fireEvent.click(screen.getByRole('button', { name: /^done$/i }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/couldn't be saved/i));
    expect(onSaved).not.toHaveBeenCalled();
  });
});

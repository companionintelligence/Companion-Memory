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

// The title-only edit the failure tests make: minutes stay at the task's 30.
const RETITLE_INPUT = {
  id: TASK.id,
  title: 'Write the migration notes',
  description: 'First draft',
  dueAt: null,
  estimatedMinutes: 30,
};

// The debounced autosave keeps firing at the unchanged draft, so the failure
// mock has to answer more than once; the success mock is consumed by whichever
// attempt comes first, which is why the retry test lets the autosave fail on
// its own instead of racing it with a click.
function retitleFails(maxUsageCount = Number.POSITIVE_INFINITY) {
  return {
    request: { query: UPDATE_TASK, variables: { input: RETITLE_INPUT } },
    error: new Error('offline'),
    maxUsageCount,
  };
}

function retitleSucceeds() {
  return {
    request: { query: UPDATE_TASK, variables: { input: RETITLE_INPUT } },
    result: {
      data: {
        updateTask: {
          __typename: 'UpdateTaskPayload',
          success: true,
          task: updatedTask('Write the migration notes'),
        },
      },
    },
  };
}

// The second edit of the overlap test. Its save is sent later than the first
// one's and answers sooner, so the two attempts resolve out of order.
const SECOND_INPUT = { ...RETITLE_INPUT, title: 'Write the migration notes twice' };

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

  // ═══ …AND THEN THE OTHER TWO WAYS TO GET THE FAILED SAVE WRONG ═══
  //
  // Closing on a failed save threw the user's edit away for a network blip — a
  // toast said so, but the words were gone. Holding the dialog open instead
  // trapped them: Done, Escape, the backdrop and the X all funnel through one
  // `onOpenChange`, so an offline user had no exit but a page reload. So the
  // failure keeps the draft AND grows its own exits: retry, or discard.
  it('keeps the dialog and the typed values when the save fails', async () => {
    const onClose = vi.fn();
    const onSaved = vi.fn();

    renderWithProviders(<EditTaskModal task={TASK} onClose={onClose} onSaved={onSaved} />, {
      mocks: [retitleFails()],
    });

    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: 'Write the migration notes' } });
    fireEvent.click(screen.getByRole('button', { name: /^done$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't be saved/i);
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: /edit task/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/^title$/i)).toHaveValue('Write the migration notes');
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /discard changes and close/i })).toBeInTheDocument();
  });

  it('closes on discard after a failed save', async () => {
    const onClose = vi.fn();

    renderWithProviders(<EditTaskModal task={TASK} onClose={onClose} />, { mocks: [retitleFails()] });

    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: 'Write the migration notes' } });
    fireEvent.click(screen.getByRole('button', { name: /^done$/i }));

    fireEvent.click(await screen.findByRole('button', { name: /discard changes and close/i }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/discarded/i));
  });

  it('saves and clears the failure when the retry succeeds', async () => {
    const onClose = vi.fn();
    const onSaved = vi.fn();

    renderWithProviders(<EditTaskModal task={TASK} onClose={onClose} onSaved={onSaved} />, {
      // Fails once, then succeeds: the autosave takes the first, Try again the second.
      mocks: [retitleFails(1), retitleSucceeds()],
    });

    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: 'Write the migration notes' } });

    fireEvent.click(await screen.findByRole('button', { name: /try again/i }, { timeout: 2000 }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(/^saved$/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^done$/i })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  // ═══ …AND THE THIRD: A FAILED SAVE THAT SILENCES THE VALIDATION ERROR ═══
  //
  // The failure panel used to take the whole slot, so once a save had failed
  // the inline validation message never rendered again for the life of the
  // dialog: the title could go blank with nothing said, and Try again then
  // refused for a reason the user could not see anywhere.
  it('still shows the validation error after a save has failed', async () => {
    const onClose = vi.fn();

    renderWithProviders(<EditTaskModal task={TASK} onClose={onClose} />, { mocks: [retitleFails()] });

    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: 'Write the migration notes' } });
    fireEvent.click(screen.getByRole('button', { name: /^done$/i }));
    await screen.findByText(/couldn't be saved/i);

    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: '   ' } });

    expect(await screen.findByText(/title is required/i)).toBeInTheDocument();
    // The failure has not gone anywhere — both refusals are live, and the panel
    // has to say both or the user is told half of why they are stuck.
    expect(screen.getByText(/couldn't be saved/i)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('says why Try again does nothing on an invalid draft', async () => {
    const onClose = vi.fn();
    const onSaved = vi.fn();

    renderWithProviders(<EditTaskModal task={TASK} onClose={onClose} onSaved={onSaved} />, {
      mocks: [retitleFails()],
    });

    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: 'Write the migration notes' } });
    fireEvent.click(screen.getByRole('button', { name: /^done$/i }));
    await screen.findByRole('button', { name: /try again/i });

    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(await screen.findByText(/title is required/i)).toBeInTheDocument();
    expect(await screen.findByText(/nothing was sent/i)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/^title$/i)).toHaveValue('   ');
  });

  // Two saves overlap whenever the user keeps typing while one is in flight.
  // The failure flag belongs to the newest attempt: an older one answering last
  // must not raise "couldn't be saved" over a draft that did save.
  it('ignores a stale failure that lands after a newer save succeeded', async () => {
    const onSaved = vi.fn();

    renderWithProviders(<EditTaskModal task={TASK} onClose={vi.fn()} onSaved={onSaved} />, {
      mocks: [
        {
          request: { query: UPDATE_TASK, variables: { input: RETITLE_INPUT } },
          error: new Error('offline'),
          delay: 900,
        },
        {
          request: { query: UPDATE_TASK, variables: { input: SECOND_INPUT } },
          result: {
            data: {
              updateTask: {
                __typename: 'UpdateTaskPayload',
                success: true,
                task: updatedTask(SECOND_INPUT.title),
              },
            },
          },
        },
      ],
    });

    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: RETITLE_INPUT.title } });
    // Wait until the first save is actually on the wire, then supersede it.
    await screen.findByText(/^saving…$/i, undefined, { timeout: 2000 });
    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: SECOND_INPUT.title } });

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1), { timeout: 2000 });

    // Long enough for the first save's rejection to arrive after the second's success.
    await new Promise((resolve) => setTimeout(resolve, 900));

    expect(screen.queryByText(/couldn't be saved/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
    expect(screen.getByText(/^saved$/i)).toBeInTheDocument();
  }, 10000);

  // Escape must not be swallowed while the save is failing — a dialog that
  // ignores the key reads as broken, and the user never learns why it will not
  // close or that discarding is right there.
  it('points Escape at the two exits instead of ignoring it', async () => {
    const onClose = vi.fn();

    renderWithProviders(<EditTaskModal task={TASK} onClose={onClose} />, { mocks: [retitleFails()] });

    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: 'Write the migration notes' } });
    fireEvent.click(screen.getByRole('button', { name: /^done$/i }));
    await screen.findByRole('button', { name: /discard changes and close/i });

    fireEvent.keyDown(screen.getByRole('dialog', { name: /edit task/i }), { key: 'Escape' });

    expect(await screen.findByText(/try again, or discard your changes to close/i)).toBeInTheDocument();
    const discard = screen.getByRole('button', { name: /discard changes and close/i });

    expect(discard).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(discard);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

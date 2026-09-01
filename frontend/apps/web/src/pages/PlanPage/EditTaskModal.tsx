import { useCallback, useEffect, useRef, useState } from 'react';

import { useMutation } from '@apollo/client';
import { Button, Dialog, Input, Label, Textarea } from '@ci/shadcn';

import { gql } from '@/graphql';

export type EditableTask = {
  id: string;
  title: string;
  description?: string | null;
  dueAt?: string | null;
  estimatedMinutes?: number | null;
};

interface Props {
  task: EditableTask;
  onClose: () => void;
  onSaved?: () => void;
}

export const UPDATE_TASK = gql(`
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

const SAVE_MS = 450;

type Draft = {
  title: string;
  description: string;
  dueDate: string;
  estimated: string;
};

function toDateInput(iso: string | null | undefined): string {
  if (!iso) {
    return '';
  }

  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

function dueAtFromInput(value: string): string | null {
  if (!value) {
    return null;
  }

  const [year, month, day] = value.split('-').map(Number);

  if (!year || !month || !day) {
    return null;
  }

  return new Date(year, month - 1, day, 12).toISOString();
}

function draftFromTask(task: EditableTask): Draft {
  return {
    title: task.title,
    description: task.description ?? '',
    dueDate: toDateInput(task.dueAt),
    estimated: task.estimatedMinutes != null ? String(task.estimatedMinutes) : '',
  };
}

function draftsEqual(left: Draft, right: Draft): boolean {
  return (
    left.title === right.title &&
    left.description === right.description &&
    left.dueDate === right.dueDate &&
    left.estimated === right.estimated
  );
}

function validateDraft(draft: Draft): string | null {
  if (!draft.title.trim()) {
    return 'A title is required.';
  }

  const minutes = draft.estimated.trim() ? Number(draft.estimated) : null;

  if (minutes != null && (!Number.isFinite(minutes) || minutes < 1)) {
    return 'Estimated minutes must be a positive number.';
  }

  return null;
}

function inputFromDraft(id: string, draft: Draft) {
  const minutes = draft.estimated.trim() ? Number(draft.estimated) : null;

  return {
    id,
    title: draft.title.trim(),
    description: draft.description.trim() || null,
    dueAt: dueAtFromInput(draft.dueDate),
    estimatedMinutes: minutes,
  };
}

export function EditTaskModal({ task, onClose, onSaved }: Props) {
  const [draft, setDraft] = useState<Draft>(() => draftFromTask(task));
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [updateTask] = useMutation(UPDATE_TASK, { errorPolicy: 'all' });
  const lastSaved = useRef<Draft>(draftFromTask(task));
  const persistRef = useRef<(next: Draft) => Promise<boolean>>(async () => false);

  const persist = useCallback(
    async (next: Draft): Promise<boolean> => {
      const invalid = validateDraft(next);

      if (invalid) {
        setError(invalid);
        setStatus('idle');

        return false;
      }

      if (draftsEqual(next, lastSaved.current)) {
        return true;
      }

      setError(null);
      setStatus('saving');

      try {
        const { data } = await updateTask({
          variables: { input: inputFromDraft(task.id, next) },
        });

        // The write is the source of truth. Apollo can still throw field errors
        // on the returned task; those used to surface as "couldn't be saved"
        // after the title was already on the server.
        if (!data?.updateTask.success) {
          setError("That task couldn't be saved. Try again.");
          setStatus('idle');

          return false;
        }

        lastSaved.current = next;
        setStatus('saved');
        onSaved?.();

        return true;
      } catch {
        setError("That task couldn't be saved. Try again.");
        setStatus('idle');

        return false;
      }
    },
    [onSaved, task.id, updateTask],
  );

  persistRef.current = persist;

  useEffect(() => {
    const invalid = validateDraft(draft);

    if (invalid) {
      setError(invalid);
      setStatus('idle');

      return;
    }

    if (draftsEqual(draft, lastSaved.current)) {
      return;
    }

    setError(null);
    const timer = window.setTimeout(() => {
      void persistRef.current(draft);
    }, SAVE_MS);

    return () => window.clearTimeout(timer);
  }, [draft]);

  const handleClose = async () => {
    await persistRef.current(draft);
    onClose();
  };

  const patch = (partial: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...partial }));
    setStatus('idle');
  };

  return (
    <Dialog open onOpenChange={(open) => !open && void handleClose()}>
      <Dialog.Content className="sm:max-w-[425px]">
        <Dialog.Header>
          <Dialog.Title>Edit task</Dialog.Title>
          <Dialog.Description>
            Changes save as you type. Close when you are done.
          </Dialog.Description>
        </Dialog.Header>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-task-title">Title</Label>
            <Textarea
              id="edit-task-title"
              value={draft.title}
              onChange={(e) => patch({ title: e.target.value })}
              autoFocus
              rows={4}
              className="min-h-20 resize-y"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-task-description">Notes</Label>
            <Textarea
              id="edit-task-description"
              value={draft.description}
              onChange={(e) => patch({ description: e.target.value })}
              rows={3}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="edit-task-due">Due</Label>
              <Input
                id="edit-task-due"
                type="date"
                value={draft.dueDate}
                onChange={(e) => patch({ dueDate: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="edit-task-estimate">Minutes</Label>
              <Input
                id="edit-task-estimate"
                type="number"
                min={1}
                inputMode="numeric"
                value={draft.estimated}
                onChange={(e) => patch({ estimated: e.target.value })}
              />
            </div>
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : ' '}
            </p>
          )}

          <Dialog.Footer>
            <Button type="button" onClick={() => void handleClose()}>
              Done
            </Button>
          </Dialog.Footer>
        </div>
      </Dialog.Content>
    </Dialog>
  );
}

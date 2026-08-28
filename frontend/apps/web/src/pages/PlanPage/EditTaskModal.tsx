import { useState, type FormEvent } from 'react';

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

export function EditTaskModal({ task, onClose, onSaved }: Props) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? '');
  const [dueDate, setDueDate] = useState(toDateInput(task.dueAt));
  const [estimated, setEstimated] = useState(
    task.estimatedMinutes != null ? String(task.estimatedMinutes) : '',
  );
  const [error, setError] = useState<string | null>(null);
  const [updateTask, { loading }] = useMutation(UPDATE_TASK);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();

    const trimmed = title.trim();

    if (!trimmed) {
      setError('A title is required.');

      return;
    }

    const minutes = estimated.trim() ? Number(estimated) : null;

    if (minutes != null && (!Number.isFinite(minutes) || minutes < 1)) {
      setError('Estimated minutes must be a positive number.');

      return;
    }

    setError(null);

    try {
      const { data } = await updateTask({
        variables: {
          input: {
            id: task.id,
            title: trimmed,
            description: description.trim() || null,
            dueAt: dueAtFromInput(dueDate),
            estimatedMinutes: minutes,
          },
        },
      });

      if (!data?.updateTask.success) {
        setError("That task couldn't be saved. Try again.");

        return;
      }

      onSaved?.();
      onClose();
    } catch {
      setError("That task couldn't be saved. Try again.");
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content className="sm:max-w-[425px]">
        <Dialog.Header>
          <Dialog.Title>Edit task</Dialog.Title>
          <Dialog.Description>
            Change the title, notes, due date, or how long it should take.
          </Dialog.Description>
        </Dialog.Header>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-task-title">Title</Label>
            <Input
              id="edit-task-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={loading}
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-task-description">Notes</Label>
            <Textarea
              id="edit-task-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={loading}
              rows={3}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="edit-task-due">Due</Label>
              <Input
                id="edit-task-due"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                disabled={loading}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="edit-task-estimate">Minutes</Label>
              <Input
                id="edit-task-estimate"
                type="number"
                min={1}
                inputMode="numeric"
                value={estimated}
                onChange={(e) => setEstimated(e.target.value)}
                disabled={loading}
              />
            </div>
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <Dialog.Footer>
            <Button type="button" variant="outline" onClick={onClose} disabled={loading}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading || title.trim().length === 0}>
              {loading ? 'Saving…' : 'Save'}
            </Button>
          </Dialog.Footer>
        </form>
      </Dialog.Content>
    </Dialog>
  );
}

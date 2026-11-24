import { useState, type FormEvent } from 'react';

import { useMutation } from '@apollo/client/react';
import { Button, Dialog, Input, Label } from '@ci/shadcn';

import { gql } from '@/graphql';

export type EditableEvent = {
  id: string;
  title?: string | null;
  startTime: string;
  endTime?: string | null;
  taskId?: string | null;
};

interface Props {
  event: EditableEvent;
  onClose: () => void;
  onSaved?: () => void;
}

const UPDATE_PLAN_DAY_EVENT = gql(`
  mutation UpdatePlanDayEvent($input: UpdateEventInput!) {
    updateEvent(input: $input) {
      id
      title
      startTime
      endTime
      eventType
      taskId
      status
    }
  }
`);

const UPDATE_LINKED_TASK = gql(`
  mutation UpdatePlanDayEventTask($input: UpdateTaskInput!) {
    updateTask(input: $input) {
      success
      task {
        id
        title
        scheduledFor
        estimatedMinutes
      }
    }
  }
`);

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function toLocalInput(iso: string | null | undefined): string {
  if (!iso) {
    return '';
  }

  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value: string): Date {
  const [datePart, timePart] = value.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = (timePart ?? '00:00').split(':').map(Number);

  return new Date(year, month - 1, day, hour, minute);
}

function localDateOf(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function EditEventModal({ event, onClose, onSaved }: Props) {
  const [title, setTitle] = useState(event.title ?? '');
  const [start, setStart] = useState(toLocalInput(event.startTime));
  const [end, setEnd] = useState(toLocalInput(event.endTime));
  const [error, setError] = useState<string | null>(null);
  const [updateEvent, { loading: savingEvent }] = useMutation(UPDATE_PLAN_DAY_EVENT);
  const [updateTask, { loading: savingTask }] = useMutation(UPDATE_LINKED_TASK);
  const loading = savingEvent || savingTask;

  const handleSubmit = async (submit: FormEvent) => {
    submit.preventDefault();

    const trimmed = title.trim();

    if (!trimmed) {
      setError('A title is required.');

      return;
    }

    if (!start) {
      setError('A start time is required.');

      return;
    }

    const startAt = fromLocalInput(start);
    const endAt = end ? fromLocalInput(end) : null;

    if (endAt && endAt.getTime() <= startAt.getTime()) {
      setError('End has to be after start.');

      return;
    }

    setError(null);

    try {
      const result = await updateEvent({
        variables: {
          input: {
            id: event.id,
            title: trimmed,
            startTime: startAt.toISOString(),
            endTime: endAt ? endAt.toISOString() : null,
          },
        },
      });

      if (!result.data?.updateEvent) {
        setError("That calendar item couldn't be saved. Try again.");

        return;
      }

      if (event.taskId) {
        const minutes = endAt
          ? Math.max(1, Math.round((endAt.getTime() - startAt.getTime()) / 60_000))
          : null;

        await updateTask({
          variables: {
            input: {
              id: event.taskId,
              title: trimmed,
              scheduledFor: localDateOf(startAt),
              estimatedMinutes: minutes,
            },
          },
        });
      }

      onSaved?.();
      onClose();
    } catch {
      setError("That calendar item couldn't be saved. Try again.");
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content className="sm:max-w-[425px]">
        <Dialog.Header>
          <Dialog.Title>Edit calendar item</Dialog.Title>
          <Dialog.Description>Change the title or when this sits on the day.</Dialog.Description>
        </Dialog.Header>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-event-title">Title</Label>
            <Input
              id="edit-event-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={loading}
              autoFocus
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="edit-event-start">Starts</Label>
              <Input
                id="edit-event-start"
                type="datetime-local"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                disabled={loading}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="edit-event-end">Ends</Label>
              <Input
                id="edit-event-end"
                type="datetime-local"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
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
            <Button type="submit" disabled={loading || title.trim().length === 0 || !start}>
              {loading ? 'Saving…' : 'Save'}
            </Button>
          </Dialog.Footer>
        </form>
      </Dialog.Content>
    </Dialog>
  );
}

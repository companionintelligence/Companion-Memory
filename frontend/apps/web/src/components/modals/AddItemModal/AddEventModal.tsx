import { useState, type FormEvent } from 'react';

import { useMutation } from '@apollo/client';
import { Button } from '@ci/shadcn';

import {
  EventForm,
  emptyEventDraft,
  eventDraftToInput,
  validateEventDraft,
  type EventDraftProblem,
} from '@/components/EventForm';
import { ResponsiveDialog } from '@/components/ResponsiveDialog';
import { gql } from '@/graphql';

const CREATE_EVENT = gql(`
  mutation CreateEvent($input: CreateEventInput!) {
    createEvent(input: $input) {
      id
      title
      description
      startTime
      endTime
      eventType
      locationName
    }
  }
`);

interface Props {
  open?: boolean;
  onClose?: (open?: boolean) => void;
  /** Called after a successful create — lists refetch here; there is no connection to write into. */
  onCreated?: () => void;
}

export function AddEventModal({ open, onClose, onCreated }: Props) {
  const [draft, setDraft] = useState(emptyEventDraft);
  const [problem, setProblem] = useState<EventDraftProblem | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [createEvent, { loading }] = useMutation(CREATE_EVENT);

  const reset = () => {
    // A fresh draft, not the one this modal opened with: emptyEventDraft dates
    // itself from "now", and the next event is more likely to be near now than
    // near whenever this dialog was first mounted.
    setDraft(emptyEventDraft());
    setProblem(null);
    setSubmitError(null);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const invalid = validateEventDraft(draft);

    if (invalid) {
      setProblem(invalid);

      return;
    }

    setProblem(null);
    setSubmitError(null);

    try {
      await createEvent({ variables: { input: eventDraftToInput(draft) } });

      onCreated?.();
      reset();
      onClose?.(false);
    } catch (error) {
      // Keep the dialog open with the user's input intact — a rejected write is
      // worth fixing, not worth losing the whole draft over.
      setSubmitError(error instanceof Error ? error.message : 'Failed to create event.');
    }
  };

  const handleCancel = () => {
    reset();
    onClose?.(false);
  };

  return (
    <ResponsiveDialog open={open} onOpenChange={onClose}>
      <ResponsiveDialog.Content className="max-h-[85vh] overflow-hidden sm:max-w-2xl">
        <ResponsiveDialog.Header>
          <ResponsiveDialog.Title>Add Event</ResponsiveDialog.Title>
        </ResponsiveDialog.Header>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-col gap-4">
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <EventForm value={draft} onChange={setDraft} problem={problem} disabled={loading} />
          </div>

          {submitError && (
            <p role="alert" className="text-sm text-destructive">
              {submitError}
            </p>
          )}

          <ResponsiveDialog.Footer className="flex gap-2 justify-end">
            <Button type="button" variant="outline" onClick={handleCancel} disabled={loading}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? 'Adding…' : 'Add'}
            </Button>
          </ResponsiveDialog.Footer>
        </form>
      </ResponsiveDialog.Content>
    </ResponsiveDialog>
  );
}

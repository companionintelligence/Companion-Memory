import { useState, type FormEvent } from 'react';

import { useMutation } from '@apollo/client';
import { Button } from '@ci/shadcn';

import {
  PlaceForm,
  emptyPlaceDraft,
  placeDraftToInput,
  validatePlaceDraft,
  type PlaceDraftProblem,
} from '@/components/PlaceForm';
import { ResponsiveDialog } from '@/components/ResponsiveDialog';
import { gql } from '@/graphql';

const CREATE_PLACE = gql(`
  mutation CreatePlace($input: CreatePlaceInput!) {
    createPlace(input: $input) {
      id
      name
      description
      placeKind
      latitude
      longitude
    }
  }
`);

interface Props {
  open?: boolean;
  onClose?: (open?: boolean) => void;
  /** Called after a successful create — lists refetch here; there is no connection to write into. */
  onCreated?: () => void;
}

export function AddPlaceModal({ open, onClose, onCreated }: Props) {
  const [draft, setDraft] = useState(emptyPlaceDraft);
  const [problem, setProblem] = useState<PlaceDraftProblem | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [createPlace, { loading }] = useMutation(CREATE_PLACE);

  const reset = () => {
    setDraft(emptyPlaceDraft());
    setProblem(null);
    setSubmitError(null);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const invalid = validatePlaceDraft(draft);

    if (invalid) {
      setProblem(invalid);

      return;
    }

    setProblem(null);
    setSubmitError(null);

    try {
      await createPlace({ variables: { input: placeDraftToInput(draft) } });

      onCreated?.();
      reset();
      onClose?.(false);
    } catch (error) {
      // Keep the dialog open with the user's input intact — an unknown place
      // kind is rejected server-side and is worth fixing, not losing.
      setSubmitError(error instanceof Error ? error.message : 'Failed to create place.');
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
          <ResponsiveDialog.Title>Add Place</ResponsiveDialog.Title>
          <ResponsiveDialog.Description>
            Save a spot from where you are, or type an address.
          </ResponsiveDialog.Description>
        </ResponsiveDialog.Header>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-col gap-4">
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <PlaceForm value={draft} onChange={setDraft} problem={problem} disabled={loading} />
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

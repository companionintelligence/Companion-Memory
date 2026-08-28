import { useState, type FormEvent } from 'react';

import { useMutation } from '@apollo/client';
import { Button } from '@ci/shadcn';

import { PersonForm, composedName, emptyPersonDraft, personDraftToInput } from '@/components/PersonForm';
import { ResponsiveDialog } from '@/components/ResponsiveDialog';
import { gql } from '@/graphql';

const CREATE_PERSON = gql(`
  mutation CreatePerson($input: CreatePersonInput!) {
    createPerson(input: $input) {
      success
      person {
        id
        name
        description
      }
    }
  }
`);

interface Props {
  open?: boolean;
  onClose?: (open?: boolean) => void;
}

export function AddPersonModal({ open, onClose }: Props) {
  const [draft, setDraft] = useState(emptyPersonDraft);
  const [nameError, setNameError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [createPerson, { loading }] = useMutation(CREATE_PERSON);

  const reset = () => {
    setDraft(emptyPersonDraft());
    setNameError(null);
    setSubmitError(null);
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    // A person with no name is unreachable in every list that renders one, so
    // require *something* — the name parts count (composedName falls back).
    if (composedName(draft) === '') {
      setNameError('Enter a name');

      return;
    }

    setNameError(null);
    setSubmitError(null);

    try {
      await createPerson({ variables: { input: personDraftToInput(draft) } });

      reset();
      onClose?.(false);
    } catch (error) {
      // Keep the dialog open with the user's input intact: a rejected contact
      // method (already claimed by another person) is worth fixing, not losing.
      setSubmitError(error instanceof Error ? error.message : 'Failed to create person.');
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
          <ResponsiveDialog.Title>Add Person</ResponsiveDialog.Title>
        </ResponsiveDialog.Header>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-col gap-4">
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <PersonForm value={draft} onChange={setDraft} nameError={nameError} disabled={loading} />
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

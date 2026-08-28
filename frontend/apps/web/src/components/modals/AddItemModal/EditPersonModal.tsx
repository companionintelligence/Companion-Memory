import { useState, type FormEvent } from 'react';

import { useMutation, useQuery } from '@apollo/client';
import { Button, Skeleton } from '@ci/shadcn';

import {
  PersonForm,
  composedName,
  emptyPersonDraft,
  personDraftFrom,
  personDraftToInput,
  type PersonDraft,
} from '@/components/PersonForm';
import { ResponsiveDialog } from '@/components/ResponsiveDialog';
import { gql, useFragment } from '@/graphql';

/**
 * Everything the person editor reads and writes back. Kept as one document so
 * the mutation's response refreshes exactly the fields the form owns — Apollo
 * then updates every list rendering the same person without a refetch.
 */
export const PERSON_EDITOR_FIELDS = gql(`
  fragment PersonEditorFields on PersonType {
    id
    name
    description
    firstName
    middleName
    lastName
    nickname
    pronouns
    gender
    birthDate
    jobTitle
    organization
    department
    website
    avatarUrl
    addresses {
      label
      streetAddress
      streetAddress2
      city
      region
      postalCode
      country
      isPrimary
      formatted
    }
    identifiers {
      kind
      value
      rawValue
      label
      isPrimary
    }
  }
`);

const GET_PERSON_FOR_EDIT = gql(`
  query GetPersonForEdit($id: ID!) {
    person(id: $id) {
      ...PersonEditorFields
    }
  }
`);

/** Exported so other person-editing surfaces (e.g. Self, which embeds the form inline rather than behind this modal) can reuse the exact same mutation. */
export const UPDATE_PERSON = gql(`
  mutation UpdatePersonProfile($input: UpdatePersonInput!) {
    updatePerson(input: $input) {
      success
      person {
        ...PersonEditorFields
      }
    }
  }
`);

interface Props {
  /** GlobalUID-encoded person id. */
  personId: string;
  open?: boolean;
  onClose?: (open?: boolean) => void;
  onSaved?: () => void;
}

export function EditPersonModal({ personId, open, onClose, onSaved }: Props) {
  const [draft, setDraft] = useState<PersonDraft>(emptyPersonDraft);
  const [nameError, setNameError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const { data, loading: loadingPerson } = useQuery(GET_PERSON_FOR_EDIT, {
    variables: { id: personId },
    skip: !open,
    // The drawer/page that opened this may hold a thinner cached person; read
    // through so the form never seeds from a partial record.
    fetchPolicy: 'cache-and-network',
  });

  // `useFragment` is a compile-time unmask, not a hook — the query already
  // fetched these fields; this just types them.
  const person = useFragment(PERSON_EDITOR_FIELDS, data?.person);

  // Seed the editor ONCE per opening, as soon as the person's persisted values
  // are available. Deliberately not an effect keyed on `person`: under
  // cache-and-network that object is a fresh reference on every render, and
  // re-seeding from it would wipe whatever the user had typed.
  const [seededFor, setSeededFor] = useState<string | null>(null);

  if (open && person != null && seededFor !== personId) {
    setSeededFor(personId);
    setDraft(personDraftFrom(person));
    setNameError(null);
    setSubmitError(null);
  }

  if (!open && seededFor !== null) {
    // Re-open shows the saved values again rather than the abandoned edit.
    setSeededFor(null);
  }

  const [updatePerson, { loading: saving }] = useMutation(UPDATE_PERSON);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (composedName(draft) === '') {
      setNameError('Enter a name');

      return;
    }

    setNameError(null);
    setSubmitError(null);

    try {
      const result = await updatePerson({
        variables: { input: { id: personId, ...personDraftToInput(draft) } },
      });

      // The resolver reports a rejected write (wrong owner, missing row) in the
      // payload rather than throwing, so a silent no-op would look like a save.
      if (!result.data?.updatePerson.success) {
        throw new Error('Update was rejected');
      }

      onSaved?.();
      onClose?.(false);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Failed to save changes.');
    }
  };

  return (
    <ResponsiveDialog open={open} onOpenChange={onClose}>
      {/* z-[1100] clears the entity drawer's z-[1000] Sheet.Content: this modal
          also opens from inside that drawer, and at the default z-50 it would
          render behind it. */}
      <ResponsiveDialog.Content
        className="z-[1100] max-h-[85vh] overflow-hidden sm:max-w-2xl"
        overlayClassName="z-[1100]"
      >
        <ResponsiveDialog.Header>
          <ResponsiveDialog.Title>Edit Person</ResponsiveDialog.Title>
        </ResponsiveDialog.Header>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-col gap-4">
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {person == null && loadingPerson ? (
              <div className="flex flex-col gap-3">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-2/3" />
              </div>
            ) : (
              <PersonForm value={draft} onChange={setDraft} nameError={nameError} disabled={saving} />
            )}
          </div>

          {submitError && (
            <p role="alert" className="text-sm text-destructive">
              {submitError}
            </p>
          )}

          <ResponsiveDialog.Footer className="flex gap-2 justify-end">
            <Button type="button" variant="outline" onClick={() => onClose?.(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || person == null}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </ResponsiveDialog.Footer>
        </form>
      </ResponsiveDialog.Content>
    </ResponsiveDialog>
  );
}

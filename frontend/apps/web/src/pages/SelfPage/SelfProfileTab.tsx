import { useEffect, useRef, useState } from 'react';

import { useMutation, useQuery } from '@apollo/client';
import { GlobalUID, usePageTitle } from '@ci/common';
import { Card } from '@ci/shadcn';

import { PageContent } from '@/components/layout';
import { PERSON_EDITOR_FIELDS, UPDATE_PERSON } from '@/components/modals/AddItemModal/EditPersonModal';
import {
  PersonForm,
  composedName,
  emptyPersonDraft,
  personDraftFrom,
  personDraftToInput,
  type PersonDraft,
} from '@/components/PersonForm';
import { gql, useFragment } from '@/graphql';
import { useCurrentUser } from '@/hooks';
import { AboutYouSection } from '@/pages/SettingsPage/sections/AboutYouSection';
import { AccountSection } from '@/pages/SettingsPage/sections/AccountSection';

import { ConnectionsSection } from './sections/ConnectionsSection';
import { LifeDetailsSection } from './sections/LifeDetailsSection';

const GET_SELF_PROFILE = gql(`
  query GetSelfProfile($id: ID!) {
    person(id: $id) {
      ...PersonEditorFields
    }
  }
`);

/** Debounce between the last keystroke and the autosave firing. */
const AUTOSAVE_DEBOUNCE_MS = 900;

/**
 * Name, birthday, gender, pronouns and "about" all live on the Person entity
 * every user is already linked to (`me.entity`) — the same record `PersonForm`
 * edits for everyone else in the graph. It sits inline here rather than
 * behind the modal `PersonPage`/`PersonDetails` still use: this page IS the
 * identity surface, so there's no "open" to gate it behind — those other two
 * call sites are visiting someone else's record and keep the modal.
 */
export function SelfProfileTab() {
  usePageTitle('Self - Companion Intelligence');

  const { user } = useCurrentUser();
  const entityId = user?.entity?.id ?? null;
  // `entityId` is GlobalUID-encoded (what GraphQL person queries expect);
  // EntityRelationshipCards/AddRelationshipModal work in raw graph entity ids.
  const rawEntityId = entityId ? GlobalUID.parse('person', entityId) : null;

  const { data } = useQuery(GET_SELF_PROFILE, {
    variables: { id: entityId ?? '' },
    skip: !entityId,
    // The editable draft below needs the freshest record, not a thinner
    // cached fragment some other query left behind — same reasoning
    // EditPersonModal's own query carries.
    fetchPolicy: 'cache-and-network',
  });
  const profile = useFragment(PERSON_EDITOR_FIELDS, data?.person);

  const [draft, setDraft] = useState<PersonDraft>(emptyPersonDraft);
  const [nameError, setNameError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');

  // Seed the editor once the persisted values are available, not on every
  // render: cache-and-network hands back a fresh object each time, and
  // re-seeding from it would wipe whatever the user is mid-typing. Mirrors
  // EditPersonModal's own seed guard.
  const [seededFor, setSeededFor] = useState<string | null>(null);

  // What's actually been persisted, as the exact payload shape a save would
  // send — not re-derived from `profile`, which only updates once Apollo's
  // cache round-trips. Comparing against this (rather than diffing against
  // `profile`) is what lets the autosave effect below know there is nothing
  // new to send, without waiting on that round-trip.
  const lastSavedRef = useRef<string | null>(null);

  if (entityId && profile != null && seededFor !== entityId) {
    setSeededFor(entityId);
    const seeded = personDraftFrom(profile);
    setDraft(seeded);
    lastSavedRef.current = JSON.stringify(personDraftToInput(seeded));
    setNameError(null);
    setSubmitError(null);
  }

  const [updatePerson] = useMutation(UPDATE_PERSON);

  // Autosave: debounce a fixed delay after the last keystroke, skip if
  // nothing actually changed since the last save (covers the initial seed
  // above, which also touches `draft`), and validate reactively instead of
  // on submit since there is no submit button to gate it behind.
  useEffect(() => {
    if (!entityId || seededFor !== entityId) {
      return;
    }

    if (composedName(draft) === '') {
      setNameError('Enter a name');

      return;
    }

    setNameError(null);

    const input = personDraftToInput(draft);
    const key = JSON.stringify(input);

    if (key === lastSavedRef.current) {
      return;
    }

    const timer = setTimeout(() => {
      setSaveState('saving');
      setSubmitError(null);

      updatePerson({ variables: { input: { id: entityId, ...input } } })
        .then((result) => {
          // The resolver reports a rejected write (wrong owner, missing row)
          // in the payload rather than throwing, so a silent no-op would
          // otherwise look like a save.
          if (!result.data?.updatePerson.success) {
            throw new Error('Update was rejected');
          }

          lastSavedRef.current = key;
          setSaveState('saved');
        })
        .catch((error: unknown) => {
          setSubmitError(error instanceof Error ? error.message : 'Failed to save changes.');
          setSaveState('idle');
        });
    }, AUTOSAVE_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [draft, entityId, seededFor, updatePerson]);

  // Fades the "Saved" note back to nothing rather than leaving it stuck once
  // the next edit doesn't happen to change `saveState` again.
  useEffect(() => {
    if (saveState !== 'saved') {
      return;
    }

    const timer = setTimeout(() => setSaveState('idle'), 2000);

    return () => clearTimeout(timer);
  }, [saveState]);

  return (
    <PageContent>
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
        {entityId && (
          <Card className="py-0">
            <Card.Content className="px-4">
              <div className="flex flex-col gap-3">
                {saveState !== 'idle' && (
                  <span className="self-end text-xs text-muted-foreground" aria-live="polite">
                    {saveState === 'saving' ? 'Saving…' : 'Saved'}
                  </span>
                )}

                {/* No autofocus: unlike the modal call sites, this form is
                    just part of the page. Grabbing focus on mount scrolled
                    the phone past the heading into the middle of the form
                    and opened the keyboard over it. */}
                <PersonForm
                  value={draft}
                  onChange={setDraft}
                  nameError={nameError}
                  autoFocusName={false}
                />

                {submitError && (
                  <p role="alert" className="text-sm text-destructive">
                    {submitError}
                  </p>
                )}
              </div>
            </Card.Content>
          </Card>
        )}

        <LifeDetailsSection />

        {rawEntityId && <ConnectionsSection entityId={rawEntityId} />}

        <AboutYouSection />

        <AccountSection />
      </div>
    </PageContent>
  );
}

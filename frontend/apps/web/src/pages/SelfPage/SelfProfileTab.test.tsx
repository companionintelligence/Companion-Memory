/**
 * SelfProfileTab: the person editor sits inline on this page rather than
 * behind EditPersonModal (see that file for why the other two call sites
 * still use it), and autosaves on change rather than through a Save button —
 * covers seeding, autosave, the empty-name guard, and a rejected write,
 * mirroring EditPersonModal.test.tsx's own coverage of the same underlying
 * mutation. The four sibling sections are stubbed out: each has its own test
 * file and its own unrelated data dependencies.
 */
import type { MockedResponse } from '@apollo/client/testing';
import { fireEvent, screen } from '@testing-library/react';
import { GraphQLError } from 'graphql';
import { describe, expect, it, vi } from 'vitest';

import { gql } from '@/graphql';
import { mockQuery } from '@/test/gql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { SelfProfileTab } from './SelfProfileTab';

vi.mock('./sections/LifeDetailsSection', () => ({ LifeDetailsSection: () => <div>LifeDetailsSection</div> }));
vi.mock('./sections/ConnectionsSection', () => ({ ConnectionsSection: () => <div>ConnectionsSection</div> }));
vi.mock('@/pages/SettingsPage/sections/AboutYouSection', () => ({
  AboutYouSection: () => <div>AboutYouSection</div>,
}));
vi.mock('@/pages/SettingsPage/sections/AccountSection', () => ({
  AccountSection: () => <div>AccountSection</div>,
}));

const ENTITY_ID = 'cGVyc29uOjQy';

vi.mock('@/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks')>()),
  useCurrentUser: () => ({ user: { name: 'Test User', entity: { id: ENTITY_ID } } }),
}));

const GET_SELF_PROFILE = gql(`
  query GetSelfProfile($id: ID!) {
    person(id: $id) {
      ...PersonEditorFields
    }
  }
`);

const UPDATE_PERSON = gql(`
  mutation UpdatePersonProfile($input: UpdatePersonInput!) {
    updatePerson(input: $input) {
      success
      person {
        ...PersonEditorFields
      }
    }
  }
`);

function personRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: ENTITY_ID,
    name: 'Jamie Rivera',
    description: null,
    firstName: 'Jamie',
    middleName: null,
    lastName: 'Rivera',
    nickname: null,
    pronouns: null,
    gender: null,
    birthDate: null,
    jobTitle: null,
    organization: null,
    department: null,
    website: null,
    avatarUrl: null,
    addresses: [],
    identifiers: [],
    ...overrides,
    __typename: 'PersonType' as const,
  };
}

function getSelfProfileMock(person: ReturnType<typeof personRecord>) {
  return mockQuery(
    GET_SELF_PROFILE,
    { id: ENTITY_ID },
    { person },
    // cache-and-network re-issues the query in the test environment.
    { maxUsageCount: Number.POSITIVE_INFINITY },
  );
}

async function renderTab(person = personRecord(), extraMocks: MockedResponse[] = []) {
  renderWithProviders(<SelfProfileTab />, { mocks: [getSelfProfileMock(person), ...extraMocks] });

  await screen.findByLabelText('First name');
}

describe('SelfProfileTab — the inline person editor', () => {
  it('seeds the form from the loaded self entity, with no modal/Edit trigger', async () => {
    await renderTab(personRecord({ firstName: 'Jamie', lastName: 'Rivera', jobTitle: 'Engineer' }));

    expect(screen.getByLabelText('Last name')).toHaveValue('Rivera');
    expect(screen.getByLabelText('Job title')).toHaveValue('Engineer');
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  // The modal call sites focus First name on open; this one must not. It is
  // just part of the page, and grabbing focus on mount scrolled the phone past
  // the heading into the middle of the form with the keyboard over it.
  it('does not steal focus into the form when the page opens', async () => {
    await renderTab();

    expect(screen.getByLabelText('First name')).not.toHaveFocus();
  });

  it('renders the other Self sections around the inline form', async () => {
    await renderTab();

    for (const label of ['LifeDetailsSection', 'ConnectionsSection', 'AboutYouSection', 'AccountSection']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('blocks autosave with no name anywhere in the draft, and never calls the mutation', async () => {
    // No UPDATE_PERSON mock supplied: if the empty-name guard failed, Apollo
    // would have nothing to answer the mutation with and the request would
    // surface as an unhandled error instead of quietly never firing.
    await renderTab(personRecord({ name: '', firstName: '', lastName: '', nickname: '' }));

    fireEvent.change(screen.getByLabelText('First name'), { target: { value: '' } });

    expect(await screen.findByText('Enter a name')).toBeInTheDocument();
  });

  it('autosaves after a debounced pause and shows a confirmation, staying on the page', async () => {
    await renderTab(personRecord(), [
      {
        request: { query: UPDATE_PERSON },
        variableMatcher: (variables: { input: unknown }) =>
          (variables.input as { jobTitle?: string }).jobTitle === 'Staff Engineer',
        result: {
          data: { updatePerson: { success: true, person: personRecord({ jobTitle: 'Staff Engineer' }) } },
        },
      } as unknown as MockedResponse,
    ]);

    fireEvent.change(screen.getByLabelText('Job title'), { target: { value: 'Staff Engineer' } });

    expect(await screen.findByText('Saved', {}, { timeout: 3000 })).toBeInTheDocument();
    // Still on the page, form still there — there is no dialog to close.
    expect(screen.getByLabelText('Job title')).toBeInTheDocument();
  });

  it('shows a real error when the resolver reports a rejected write', async () => {
    await renderTab(personRecord(), [
      {
        request: { query: UPDATE_PERSON },
        variableMatcher: () => true,
        result: { data: { updatePerson: { success: false, person: null } } },
      } as unknown as MockedResponse,
    ]);

    fireEvent.change(screen.getByLabelText('Job title'), { target: { value: 'Staff Engineer' } });

    expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent(/update was rejected/i);
  });

  it('shows a real error when the request itself fails', async () => {
    await renderTab(personRecord(), [
      {
        request: { query: UPDATE_PERSON },
        variableMatcher: () => true,
        error: new Error('network down'),
      } as unknown as MockedResponse,
    ]);

    fireEvent.change(screen.getByLabelText('Job title'), { target: { value: 'Staff Engineer' } });

    expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent(/network down/i);
  });
});

describe('SelfProfileTab — a number the server will not store', () => {
  const EXTENSION = '212-555-0148 x31';

  type Input = { contacts?: Array<{ value: string }>; jobTitle?: string; description?: string };

  /** Longer than two autosave debounces (900 ms): time enough for a retry to have fired. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 2_000));

  it('points at the row, stops re-sending it, and saves once it is kept in a note', async () => {
    const attempts: Input[] = [];

    await renderTab(personRecord(), [
      {
        request: { query: UPDATE_PERSON },
        variableMatcher: (variables: { input: Input }) =>
          (variables.input.contacts ?? []).some((contact) => contact.value === EXTENSION),
        maxUsageCount: Number.POSITIVE_INFINITY,
        result: (variables: { input: Input }) => {
          attempts.push(variables.input);

          return {
            errors: [
              new GraphQLError(`"${EXTENSION}" includes an extension`, {
                extensions: {
                  code: 'BAD_USER_INPUT',
                  details: {
                    refusedContacts: [{ kind: 'phone', value: EXTENSION, label: null, reason: 'extension' }],
                  },
                },
              }),
            ],
          };
        },
      } as unknown as MockedResponse,
      {
        request: { query: UPDATE_PERSON },
        variableMatcher: (variables: { input: Input }) =>
          (variables.input.contacts ?? []).length === 0 &&
          variables.input.description === 'Phone: 212-555-0148 x31',
        result: {
          data: {
            updatePerson: { success: true, person: personRecord({ description: 'Phone: 212-555-0148 x31' }) },
          },
        },
      } as unknown as MockedResponse,
    ]);

    fireEvent.click(screen.getByRole('button', { name: /Add phone/ }));
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: EXTENSION } });

    expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent(
      'includes an extension',
    );
    expect(screen.getByLabelText('Phone number')).toHaveAttribute('aria-invalid', 'true');

    // An edit elsewhere would only be refused over the same number again.
    fireEvent.change(screen.getByLabelText('Job title'), { target: { value: 'Staff Engineer' } });
    await settle();
    expect(attempts).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: /Keep it in a note/ }));

    expect(await screen.findByText('Saved', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not retry a failed save in a loop when nothing was refused', async () => {
    let calls = 0;

    await renderTab(personRecord(), [
      {
        request: { query: UPDATE_PERSON },
        variableMatcher: () => true,
        maxUsageCount: Number.POSITIVE_INFINITY,
        result: () => {
          calls += 1;

          return { errors: [new GraphQLError('Internal server error')] };
        },
      } as unknown as MockedResponse,
    ]);

    fireEvent.change(screen.getByLabelText('Job title'), { target: { value: 'Staff Engineer' } });

    expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent(
      'Internal server error',
    );
    await settle();
    expect(calls).toBe(1);
  });
});

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { gql } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { OAuthSection } from './OAuthSection';

const GET_PROVIDERS = gql(`
  query GetProviders {
    providers {
      edges {
        cursor
        node {
          id
          name
          description
          logoUrl
          localOnly
          appSetupUrl
          authType
          scopes
          providerKeys {
            id
            clientId
            hasClientSecret
            clientSecretHint
          }
        }
      }
    }
  }
`);

const CREATE_PROVIDER_KEY = gql(`
  mutation CreateProviderKey($input: CreateProviderKeyInput!) {
    createProviderKey(input: $input) {
      id
      providerId
      clientId
      hasClientSecret
      clientSecretHint
      userId
    }
  }
`);

const UPDATE_PROVIDER_KEY = gql(`
  mutation UpdateProviderKey($id: ID!, $input: UpdateProviderKeyInput!) {
    updateProviderKey(id: $id, input: $input) {
      id
      clientId
      hasClientSecret
      clientSecretHint
    }
  }
`);

const DELETE_PROVIDER_KEY = gql(`
  mutation DeleteProviderKey($id: ID!) {
    deleteProviderKey(id: $id)
  }
`);

interface ProviderFixture {
  id: string;
  name: string;
  providerKeys?: {
    id: string;
    clientId: string;
    hasClientSecret: boolean;
    clientSecretHint: string | null;
  } | null;
}

function providersMock(providers: ProviderFixture[]) {
  return {
    request: { query: GET_PROVIDERS },
    result: {
      data: {
        providers: {
          __typename: 'ProviderConnection',
          edges: providers.map((p) => ({
            __typename: 'ProviderEdge',
            cursor: p.id,
            node: {
              __typename: 'ProviderType',
              id: p.id,
              name: p.name,
              description: null,
              logoUrl: null,
              localOnly: false,
              appSetupUrl: null,
              authType: 'oauth2',
              scopes: [],
              providerKeys: p.providerKeys ? { __typename: 'ProviderKeyType', ...p.providerKeys } : null,
            },
          })),
        },
      },
    },
  };
}

const BASE_PROVIDERS: ProviderFixture[] = [
  { id: 'prov-facebook', name: 'Facebook' },
  { id: 'prov-github', name: 'GitHub' },
  { id: 'prov-google', name: 'Google' },
  { id: 'prov-microsoft', name: 'Microsoft' },
  { id: 'prov-spotify', name: 'Spotify' },
];

/** Scope queries to one provider's card, since every card repeats the same field labels. */
function providerCard(name: string): HTMLElement {
  const card = screen.getByText(name).closest('[data-slot="card"]');

  if (!card) {
    throw new Error(`no card found for ${name}`);
  }

  return card as HTMLElement;
}

describe('OAuthSection', () => {
  it('renders a card per provider with masked credential fields', async () => {
    renderWithProviders(<OAuthSection />, { mocks: [providersMock(BASE_PROVIDERS)] });

    await screen.findByText('Google');
    const google = providerCard('Google');

    expect(within(google).getByLabelText('Client ID')).toHaveAttribute('type', 'password');
    expect(within(google).getByLabelText('Client Secret')).toHaveAttribute('type', 'password');
  });

  it('toggles a field between masked and visible independently per field', async () => {
    renderWithProviders(<OAuthSection />, { mocks: [providersMock(BASE_PROVIDERS)] });

    await screen.findByText('Google');
    const google = providerCard('Google');

    fireEvent.click(within(google).getByRole('button', { name: /show client id/i }));
    expect(within(google).getByLabelText('Client ID')).toHaveAttribute('type', 'text');
    // The secret field is untouched by revealing the client ID.
    expect(within(google).getByLabelText('Client Secret')).toHaveAttribute('type', 'password');

    fireEvent.click(within(google).getByRole('button', { name: /hide client id/i }));
    expect(within(google).getByLabelText('Client ID')).toHaveAttribute('type', 'password');
  });

  it('offers no Save button until both fields of a new key are filled in', async () => {
    renderWithProviders(<OAuthSection />, { mocks: [providersMock(BASE_PROVIDERS)] });

    await screen.findByText('Google');
    const google = providerCard('Google');

    expect(within(google).queryByRole('button', { name: /save credentials/i })).not.toBeInTheDocument();

    fireEvent.change(within(google).getByLabelText('Client ID'), { target: { value: 'client-abc' } });
    expect(within(google).queryByRole('button', { name: /save credentials/i })).not.toBeInTheDocument();

    fireEvent.change(within(google).getByLabelText('Client Secret'), { target: { value: 'secret-xyz' } });
    expect(within(google).getByRole('button', { name: /save credentials/i })).toBeInTheDocument();
  });

  it('creates a provider key for a provider with none yet, using the id looked up from the providers query', async () => {
    let createVariables: unknown;

    renderWithProviders(<OAuthSection />, {
      mocks: [
        providersMock(BASE_PROVIDERS),
        {
          request: {
            query: CREATE_PROVIDER_KEY,
            variables: {
              input: { providerId: 'prov-google', clientId: 'client-abc', clientSecret: 'secret-xyz' },
            },
          },
          result: () => {
            createVariables = {
              providerId: 'prov-google',
              clientId: 'client-abc',
              clientSecret: 'secret-xyz',
            };

            return {
              data: {
                createProviderKey: {
                  __typename: 'ProviderKeyType',
                  id: 'pk-google',
                  providerId: 'prov-google',
                  clientId: 'client-abc',
                  hasClientSecret: true,
                  clientSecretHint: '-xyz',
                  userId: 'u1',
                },
              },
            };
          },
        },
      ],
    });

    await screen.findByText('Google');
    const google = providerCard('Google');

    fireEvent.change(within(google).getByLabelText('Client ID'), { target: { value: 'client-abc' } });
    fireEvent.change(within(google).getByLabelText('Client Secret'), { target: { value: 'secret-xyz' } });
    fireEvent.click(within(google).getByRole('button', { name: /save credentials/i }));

    await waitFor(() => expect(createVariables).toBeDefined());

    // Once the key exists, the field pair reads as saved (no dangling Save
    // button) and a Delete control appears for it.
    await waitFor(() =>
      expect(within(google).queryByRole('button', { name: /save credentials/i })).not.toBeInTheDocument(),
    );
    expect(within(google).getByRole('button', { name: /delete stored credentials/i })).toBeInTheDocument();
  });

  it('updates an existing provider key by its id, not by re-creating it', async () => {
    let updateCalled: { id: unknown; input: unknown } | undefined;

    renderWithProviders(<OAuthSection />, {
      mocks: [
        providersMock([
          {
            id: 'prov-google',
            name: 'Google',
            providerKeys: {
              id: 'pk-google',
              clientId: 'old-id',
              hasClientSecret: true,
              clientSecretHint: 'cret',
            },
          },
        ]),
        {
          request: {
            query: UPDATE_PROVIDER_KEY,
            // The secret field was left blank, so the stored secret is kept: it
            // is not re-sent, and the client never had it to re-send.
            variables: { id: 'pk-google', input: { clientId: 'new-id' } },
          },
          result: () => {
            updateCalled = { id: 'pk-google', input: { clientId: 'new-id' } };

            return {
              data: {
                updateProviderKey: {
                  __typename: 'ProviderKeyType',
                  id: 'pk-google',
                  clientId: 'new-id',
                  hasClientSecret: true,
                  clientSecretHint: 'cret',
                },
              },
            };
          },
        },
      ],
    });

    await screen.findByText('Google');
    // The fields are seeded from the query result in an effect, one render after the card appears.
    await waitFor(() =>
      expect(within(providerCard('Google')).getByLabelText('Client ID')).toHaveValue('old-id'),
    );
    const google = providerCard('Google');

    fireEvent.change(within(google).getByLabelText('Client ID'), { target: { value: 'new-id' } });
    fireEvent.click(within(google).getByRole('button', { name: /save credentials/i }));

    await waitFor(() => expect(updateCalled).toBeDefined());
  });

  it('deletes a stored key after confirmation, clearing the fields and closing the dialog', async () => {
    renderWithProviders(<OAuthSection />, {
      mocks: [
        providersMock([
          {
            id: 'prov-google',
            name: 'Google',
            providerKeys: {
              id: 'pk-google',
              clientId: 'the-id',
              hasClientSecret: true,
              clientSecretHint: 'cret',
            },
          },
        ]),
        {
          request: { query: DELETE_PROVIDER_KEY, variables: { id: 'pk-google' } },
          result: { data: { deleteProviderKey: true } },
        },
      ],
    });

    await screen.findByText('Google');
    // The fields are seeded from the query result in an effect, one render after the card appears.
    await waitFor(() =>
      expect(within(providerCard('Google')).getByLabelText('Client ID')).toHaveValue('the-id'),
    );
    const google = providerCard('Google');

    expect(within(google).getByLabelText('Client ID')).toHaveValue('the-id');

    fireEvent.click(within(google).getByRole('button', { name: /delete stored credentials/i }));

    expect(screen.getByText('Delete OAuth Keys')).toBeInTheDocument();
    expect(screen.getByText(/delete the oauth keys for google/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(screen.queryByText('Delete OAuth Keys')).not.toBeInTheDocument());
    expect(within(providerCard('Google')).getByLabelText('Client ID')).toHaveValue('');
    expect(within(providerCard('Google')).getByLabelText('Client Secret')).toHaveValue('');
    expect(
      within(providerCard('Google')).queryByRole('button', { name: /delete stored credentials/i }),
    ).not.toBeInTheDocument();
  });

  it('cancelling the delete confirmation leaves the stored key untouched', async () => {
    renderWithProviders(<OAuthSection />, {
      mocks: [
        providersMock([
          {
            id: 'prov-google',
            name: 'Google',
            providerKeys: {
              id: 'pk-google',
              clientId: 'the-id',
              hasClientSecret: true,
              clientSecretHint: 'cret',
            },
          },
        ]),
        // No DELETE_PROVIDER_KEY mock: an unexpected send would surface as an
        // unmatched-request error from MockedProvider.
      ],
    });

    await screen.findByText('Google');
    // The fields are seeded from the query result in an effect, one render after the card appears.
    await waitFor(() =>
      expect(within(providerCard('Google')).getByLabelText('Client ID')).toHaveValue('the-id'),
    );
    fireEvent.click(
      within(providerCard('Google')).getByRole('button', { name: /delete stored credentials/i }),
    );

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(screen.queryByText('Delete OAuth Keys')).not.toBeInTheDocument();
    expect(within(providerCard('Google')).getByLabelText('Client ID')).toHaveValue('the-id');
  });

  it('never shows a stored secret: the field is empty with a hint placeholder and a keep-or-replace note', async () => {
    renderWithProviders(<OAuthSection />, {
      mocks: [
        providersMock([
          {
            id: 'prov-google',
            name: 'Google',
            providerKeys: {
              id: 'pk-google',
              clientId: 'the-id',
              hasClientSecret: true,
              clientSecretHint: 'cret',
            },
          },
        ]),
      ],
    });

    await screen.findByText('Google');
    // The fields are seeded from the query result in an effect, one render after the card appears.
    await waitFor(() =>
      expect(within(providerCard('Google')).getByLabelText('Client ID')).toHaveValue('the-id'),
    );
    const google = providerCard('Google');
    const secret = within(google).getByLabelText('Client Secret');

    expect(secret).toHaveValue('');
    expect(secret).toHaveAttribute('placeholder', '••••••••cret');
    expect(within(google).getByText(/a secret is stored and is never shown/i)).toBeInTheDocument();
    // Revealing the field reveals nothing, because nothing was ever sent.
    fireEvent.click(within(google).getByRole('button', { name: /show client secret/i }));
    expect(secret).toHaveValue('');
    // Nothing to save until something changes.
    expect(within(google).queryByRole('button', { name: /save credentials/i })).not.toBeInTheDocument();
  });

  it('replaces the stored secret only when a new one is typed', async () => {
    let updateCalled: { id: unknown; input: unknown } | undefined;

    renderWithProviders(<OAuthSection />, {
      mocks: [
        providersMock([
          {
            id: 'prov-google',
            name: 'Google',
            providerKeys: {
              id: 'pk-google',
              clientId: 'the-id',
              hasClientSecret: true,
              clientSecretHint: 'cret',
            },
          },
        ]),
        {
          request: {
            query: UPDATE_PROVIDER_KEY,
            variables: { id: 'pk-google', input: { clientId: 'the-id', clientSecret: 'brand-new-secret' } },
          },
          result: () => {
            updateCalled = {
              id: 'pk-google',
              input: { clientId: 'the-id', clientSecret: 'brand-new-secret' },
            };

            return {
              data: {
                updateProviderKey: {
                  __typename: 'ProviderKeyType',
                  id: 'pk-google',
                  clientId: 'the-id',
                  hasClientSecret: true,
                  clientSecretHint: 'cret',
                },
              },
            };
          },
        },
      ],
    });

    await screen.findByText('Google');
    // The fields are seeded from the query result in an effect, one render after the card appears.
    await waitFor(() =>
      expect(within(providerCard('Google')).getByLabelText('Client ID')).toHaveValue('the-id'),
    );
    const google = providerCard('Google');

    fireEvent.change(within(google).getByLabelText('Client Secret'), {
      target: { value: 'brand-new-secret' },
    });
    fireEvent.click(within(google).getByRole('button', { name: /save credentials/i }));

    await waitFor(() => expect(updateCalled).toBeDefined());
    // The typed secret is cleared from the field after saving; the hint takes over again.
    await waitFor(() =>
      expect(within(providerCard('Google')).getByLabelText('Client Secret')).toHaveValue(''),
    );
  });

  it('flags a half-filled pair for an existing key, and does not blame the field the user is still typing into', async () => {
    renderWithProviders(<OAuthSection />, {
      mocks: [
        providersMock([
          {
            id: 'prov-google',
            name: 'Google',
            providerKeys: {
              id: 'pk-google',
              clientId: 'the-id',
              hasClientSecret: true,
              clientSecretHint: 'cret',
            },
          },
        ]),
      ],
    });

    await screen.findByText('Google');
    // The fields are seeded from the query result in an effect, one render after the card appears.
    await waitFor(() =>
      expect(within(providerCard('Google')).getByLabelText('Client ID')).toHaveValue('the-id'),
    );
    const google = providerCard('Google');

    fireEvent.change(within(google).getByLabelText('Client ID'), { target: { value: '' } });

    expect(within(google).getByText('Client ID is required')).toBeInTheDocument();
    // A save that would leave the pair half-empty is refused outright, not just discouraged.
    expect(within(google).getByRole('button', { name: /save credentials/i })).toBeDisabled();
  });
});

import type { MockedResponse } from '@apollo/client/testing';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { GraphQLError } from 'graphql';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { ACCEPT_PEER_INVITE, CREATE_PEER_INVITE, MY_PEER_INVITES } from './asksOperations';
import { PeerInvites } from './PeerInvites';

function invite(overrides: Record<string, unknown> = {}) {
  return {
    __typename: 'PeerInvite',
    id: 'inv-1',
    label: 'for Sam',
    inviterName: 'Alice',
    status: 'pending',
    createdAt: '2026-11-19T10:00:00.000Z',
    expiresAt: '2026-11-20T10:00:00.000Z',
    usedAt: null,
    ...overrides,
  };
}

const invitesOk = (rows: unknown[]): MockedResponse => ({
  request: { query: MY_PEER_INVITES },
  result: { data: { myPeerInvites: rows } },
});

const repeated = (mock: MockedResponse, times = 3) => Array.from({ length: times }, () => mock);

function renderInvites(mocks: readonly MockedResponse[], onLinked = vi.fn()) {
  renderWithProviders(<PeerInvites onLinked={onLinked} />, { mocks, route: '/asks' });

  return onLinked;
}

describe('PeerInvites', () => {
  it('shows a new code once, and says it is shown only once', async () => {
    renderInvites([
      ...repeated(invitesOk([])),
      {
        request: { query: CREATE_PEER_INVITE, variables: { input: { name: undefined, label: 'for Sam' } } },
        result: {
          data: {
            createPeerInvite: {
              __typename: 'CreatePeerInvitePayload',
              success: true,
              code: 'cmi1.abc',
              invite: invite(),
            },
          },
        },
      },
    ]);

    fireEvent.change(screen.getByLabelText(/Who it is for/), { target: { value: 'for Sam' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make an invite' }));

    expect(await screen.findByDisplayValue('cmi1.abc')).toBeInTheDocument();
    expect(screen.getByText(/only time it is shown/)).toBeInTheDocument();
  });

  it('lists invites still waiting, with a way to withdraw them', async () => {
    renderInvites(repeated(invitesOk([invite(), invite({ id: 'inv-2', status: 'used', label: 'old' })])));

    expect(await screen.findByText('for Sam')).toBeInTheDocument();
    expect(screen.queryByText('old')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Withdraw' })).toBeInTheDocument();
  });

  it('links with a pasted code and tells the page to re-read its links', async () => {
    const onLinked = renderInvites([
      ...repeated(invitesOk([])),
      {
        request: {
          query: ACCEPT_PEER_INVITE,
          variables: { input: { code: 'cmi1.xyz', displayName: undefined } },
        },
        result: {
          data: {
            acceptPeerInvite: {
              __typename: 'AcceptPeerInvitePayload',
              success: true,
              peerLink: {
                __typename: 'PeerLinkType',
                id: 'link-1',
                peerHandle: 'alice',
                displayName: 'Alice',
                trustTier: 'stranger',
                linkedByKey: true,
                safetyCode: '1234 5678 9012',
              },
            },
          },
        },
      },
    ]);

    fireEvent.change(screen.getByPlaceholderText('cmi1.…'), { target: { value: '  cmi1.xyz  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));

    expect(await screen.findByText(/Linked with Alice, as Stranger/)).toBeInTheDocument();
    expect(screen.getByText('1234 5678 9012')).toBeInTheDocument();
    expect(screen.getByText(/compare these numbers with them on a call or in person/)).toBeInTheDocument();
    await waitFor(() => expect(onLinked).toHaveBeenCalledTimes(1));
  });

  it('shows the server’s reason when an invite cannot be used', async () => {
    const onLinked = renderInvites([
      ...repeated(invitesOk([])),
      {
        request: {
          query: ACCEPT_PEER_INVITE,
          variables: { input: { code: 'cmi1.used', displayName: undefined } },
        },
        result: { errors: [new GraphQLError('This invite has expired, was already used, or was withdrawn')] },
      },
    ]);

    fireEvent.change(screen.getByPlaceholderText('cmi1.…'), { target: { value: 'cmi1.used' } });
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));

    expect(await screen.findByText(/already used, or was withdrawn/)).toBeInTheDocument();
    expect(onLinked).not.toHaveBeenCalled();
  });
});

describe('PeerInvites — your key', () => {
  it('asks before making a new key, then says who could not be told and offers to try again', async () => {
    const { ROTATE_PEER_KEY } = await import('./asksOperations');
    const onRotated = renderInvites([
      ...repeated(invitesOk([])),
      {
        request: { query: ROTATE_PEER_KEY },
        result: {
          data: {
            rotatePeerKey: {
              __typename: 'PeerKeyRotationPayload',
              success: true,
              notified: ['bob'],
              unreachable: ['carol'],
            },
          },
        },
      },
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Make a new key' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, make a new key' }));

    expect(await screen.findByText('Told 1 of 2.')).toBeInTheDocument();
    expect(screen.getByText(/Could not reach carol/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tell them again' })).toBeInTheDocument();
    await waitFor(() => expect(onRotated).toHaveBeenCalled());
  });
});

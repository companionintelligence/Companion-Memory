import { peersRevokeCommand } from '../../commands/peers/revoke';
import { GraphQLApiError } from '../../graphqlClient';
import { harness } from '../support/harness';

describe('ci peers revoke', () => {
  it('revokes the link', async () => {
    const ctx = harness(
      {},
      {
        revokePeerLink: async (id) => ({
          success: true,
          peerLink: {
            id,
            peerHandle: 'alice@portal.example',
            displayName: null,
            memoryEndpoint: 'https://alice.example',
            status: 'revoked',
            trustTier: 'peer',
            personEntityId: null,
            avatarUrl: null,
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:00.000Z',
            revokedAt: '2026-08-02T00:00:00.000Z',
          },
        }),
      },
    );

    await peersRevokeCommand(ctx, 'pl_1');

    expect(ctx.term.text()).toBe('Revoked alice@portal.example.');
  });

  it('does not swallow an auth failure', async () => {
    const ctx = harness(
      {},
      {
        revokePeerLink: async () => {
          throw new GraphQLApiError('FORBIDDEN', 'not your link', 'revokePeerLink');
        },
      },
    );

    await expect(peersRevokeCommand(ctx, 'pl_1')).rejects.toMatchObject({ status: 403 });
  });
});

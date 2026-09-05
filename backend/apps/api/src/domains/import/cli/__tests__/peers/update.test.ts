import { peersUpdateCommand } from '../../commands/peers/update';
import { GraphQLApiError } from '../../graphqlClient';
import { peerLinkFixture } from '../support/fixtures';
import { harness } from '../support/harness';

describe('ci-import peers update', () => {
  it('changes the tier', async () => {
    const seen: unknown[] = [];
    const ctx = harness(
      {},
      {
        updatePeerLink: async (input) => {
          seen.push(input);

          return { success: true, peerLink: peerLinkFixture({ id: input.id, trustTier: 'trusted' }) };
        },
      },
    );

    await peersUpdateCommand(ctx, 'pl_1', { tier: 'trusted' });

    expect(seen).toEqual([{ id: 'pl_1', displayName: undefined, trustTier: 'trusted' }]);
    expect(ctx.term.text()).toContain('tier trusted');
  });

  it('refuses an empty update before making a call', async () => {
    const ctx = harness({}, {});

    await expect(peersUpdateCommand(ctx, 'pl_1')).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('Nothing to update'),
    });
  });

  it('rejects an unknown --tier before making a call', async () => {
    const ctx = harness({}, {});

    await expect(peersUpdateCommand(ctx, 'pl_1', { tier: 'bestie' })).rejects.toMatchObject({ exitCode: 2 });
  });

  it('surfaces a not-found from the server rather than inventing one', async () => {
    const ctx = harness(
      {},
      {
        updatePeerLink: async () => {
          throw new GraphQLApiError('NOT_FOUND', 'Peer link pl_9 not found', 'updatePeerLink');
        },
      },
    );

    await expect(peersUpdateCommand(ctx, 'pl_9', { tier: 'peer' })).rejects.toMatchObject({
      status: 404,
      message: 'Peer link pl_9 not found',
    });
  });
});

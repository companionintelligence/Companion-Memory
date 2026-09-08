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

  describe('--peer-issuer / --peer-subject', () => {
    it('sends the pair through to updatePeerLink', async () => {
      const seen: unknown[] = [];
      const ctx = harness(
        {},
        {
          updatePeerLink: async (input) => {
            seen.push(input);

            return { success: true, peerLink: peerLinkFixture({ id: input.id }) };
          },
        },
      );

      await peersUpdateCommand(ctx, 'pl_1', {
        peerIssuer: 'https://portal.example',
        peerSubject: 'alice-box-a',
      });

      expect(seen).toEqual([
        {
          id: 'pl_1',
          displayName: undefined,
          trustTier: undefined,
          peerIssuer: 'https://portal.example',
          peerSubject: 'alice-box-a',
        },
      ]);
    });

    it('refuses half a pair before making a call, in both directions', async () => {
      for (const half of [
        { peerIssuer: 'https://portal.example' },
        { peerSubject: 'alice-box-a' },
      ] as const) {
        const ctx = harness({}, {});

        await expect(peersUpdateCommand(ctx, 'pl_1', half)).rejects.toMatchObject({
          exitCode: 2,
          message: expect.stringContaining('--peer-issuer and --peer-subject must be given together'),
        });
      }
    });

    it('counts a binding as something to update — it is not an empty update', async () => {
      // Regression guard on the "Nothing to update" gate: it predates these
      // flags and listed only --tier and --display-name, so binding an identity
      // and nothing else would have been refused before it left the terminal.
      const ctx = harness(
        {},
        { updatePeerLink: async (input) => ({ success: true, peerLink: peerLinkFixture({ id: input.id }) }) },
      );

      await expect(
        peersUpdateCommand(ctx, 'pl_1', {
          peerIssuer: 'https://portal.example',
          peerSubject: 'alice-box-a',
        }),
      ).resolves.toBeUndefined();
    });
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

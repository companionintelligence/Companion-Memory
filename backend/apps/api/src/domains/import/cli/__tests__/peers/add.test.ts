import { peersAddCommand } from '../../commands/peers/add';
import { GraphQLApiError } from '../../graphqlClient';
import { peerLinkFixture } from '../support/fixtures';
import { harness } from '../support/harness';

describe('ci-import peers add', () => {
  it('links a peer at the narrowest default tier when none is given', async () => {
    const seen: unknown[] = [];
    const ctx = harness(
      {},
      {
        createPeerLink: async (input) => {
          seen.push(input);

          return {
            success: true,
            peerLink: peerLinkFixture({
              peerHandle: input.peerHandle,
              displayName: input.displayName ?? null,
              memoryEndpoint: input.memoryEndpoint,
              trustTier: 'stranger',
            }),
          };
        },
      },
    );

    await peersAddCommand(ctx, 'alice@portal.example', 'https://alice.example:3030');

    expect(seen).toEqual([
      {
        peerHandle: 'alice@portal.example',
        memoryEndpoint: 'https://alice.example:3030',
        displayName: undefined,
        trustTier: undefined,
      },
    ]);
    expect(ctx.term.text()).toContain('Linked alice@portal.example');
  });

  it('rejects an unknown --tier before making a call', async () => {
    const ctx = harness({}, {});

    await expect(
      peersAddCommand(ctx, 'alice@portal.example', 'https://alice.example:3030', { tier: 'bff' }),
    ).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining('--tier must be one of') });
  });

  it('surfaces the server’s own refusal rather than a generic failure', async () => {
    const ctx = harness(
      {},
      {
        createPeerLink: async () => {
          throw new GraphQLApiError('BAD_USER_INPUT', 'memoryEndpoint must be a valid URL', 'createPeerLink');
        },
      },
    );

    await expect(peersAddCommand(ctx, 'alice@portal.example', 'not-a-url')).rejects.toMatchObject({
      status: 400,
      message: 'memoryEndpoint must be a valid URL',
    });
  });

  it('does not swallow an auth failure', async () => {
    const ctx = harness(
      {},
      {
        createPeerLink: async () => {
          throw new GraphQLApiError('UNAUTHENTICATED', 'no key', 'createPeerLink');
        },
      },
    );

    await expect(
      peersAddCommand(ctx, 'alice@portal.example', 'https://alice.example:3030'),
    ).rejects.toMatchObject({ status: 401, message: 'no key' });
  });
});

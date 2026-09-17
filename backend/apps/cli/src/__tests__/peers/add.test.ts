import { peersAddCommand } from '../../commands/peers/add';
import { GraphQLApiError } from '../../graphqlClient';
import { peerLinkFixture } from '../support/fixtures';
import { harness } from '../support/harness';

describe('ci peers add', () => {
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

  /**
   * `--peer-issuer` / `--peer-subject` are the pair `PeerAskService.resolveLink`
   * matches an INBOUND ask on. Without them a link is outbound-only, which is
   * what every link this command could create used to be.
   */
  describe('--peer-issuer / --peer-subject', () => {
    it('sends the pair through to createPeerLink', async () => {
      const seen: unknown[] = [];
      const ctx = harness(
        {},
        {
          createPeerLink: async (input) => {
            seen.push(input);

            return { success: true, peerLink: peerLinkFixture({ peerHandle: input.peerHandle }) };
          },
        },
      );

      await peersAddCommand(ctx, 'alice@portal.example', 'https://alice.example:3030', {
        peerIssuer: 'https://portal.example',
        peerSubject: 'alice-box-a',
      });

      expect(seen).toEqual([
        {
          peerHandle: 'alice@portal.example',
          memoryEndpoint: 'https://alice.example:3030',
          displayName: undefined,
          trustTier: undefined,
          peerIssuer: 'https://portal.example',
          peerSubject: 'alice-box-a',
        },
      ]);
    });

    it('refuses half a pair before making a call, in both directions', async () => {
      // Half a pair can never match: `findActiveByPeerIdentity` filters on both
      // columns. Accepting `--peer-issuer` alone would print "Linked alice…"
      // over a link that is still inert for inbound asks.
      for (const half of [
        { peerIssuer: 'https://portal.example' },
        { peerSubject: 'alice-box-a' },
      ] as const) {
        const ctx = harness({}, {});

        await expect(
          peersAddCommand(ctx, 'alice@portal.example', 'https://alice.example:3030', half),
        ).rejects.toMatchObject({
          exitCode: 2,
          message: expect.stringContaining('--peer-issuer and --peer-subject must be given together'),
        });
      }
    });

    it('surfaces the server’s duplicate-identity refusal rather than a generic failure', async () => {
      // `peer_links_owner_identity_live_uniq`, translated by
      // `PeerLinkService.upsert` into a 409 — the operator needs to be told
      // which of their links already claims the identity, not "500".
      const ctx = harness(
        {},
        {
          createPeerLink: async () => {
            throw new GraphQLApiError(
              'CONFLICT',
              'Another active peer link already claims that (peerIssuer, peerSubject)',
              'createPeerLink',
            );
          },
        },
      );

      await expect(
        peersAddCommand(ctx, 'alice@portal.example', 'https://alice.example:3030', {
          peerIssuer: 'https://portal.example',
          peerSubject: 'alice-box-a',
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining('already claims that (peerIssuer, peerSubject)'),
      });
    });
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

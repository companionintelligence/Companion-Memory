import { peersListCommand } from '../../commands/peers/list';
import { GraphQLApiError } from '../../graphqlClient';
import { peerLinkFixture as link } from '../support/fixtures';
import { harness } from '../support/harness';

describe('ci-import peers list', () => {
  it('prints every peer link, revoked ones included', async () => {
    const ctx = harness(
      {},
      {
        myPeerLinks: async () => [
          link(),
          link({
            id: 'pl_2',
            peerHandle: 'bob@portal.example',
            status: 'revoked',
            revokedAt: '2026-08-02T00:00:00.000Z',
          }),
        ],
      },
    );

    await peersListCommand(ctx);

    const text = ctx.term.text();

    expect(text).toContain('alice@portal.example');
    expect(text).toContain('bob@portal.example');
    expect(text).toContain('revoked');
  });

  it('emits the raw list under --json', async () => {
    const ctx = harness({}, { myPeerLinks: async () => [link()] });

    await peersListCommand(ctx, { json: true });

    expect(JSON.parse(ctx.term.text())[0].peerHandle).toBe('alice@portal.example');
  });

  it('says so when there are none yet', async () => {
    const ctx = harness({}, { myPeerLinks: async () => [] });

    await peersListCommand(ctx);

    expect(ctx.term.text()).toContain('peers add');
  });

  it('does not swallow an auth failure from the appliance', async () => {
    const ctx = harness(
      {},
      {
        myPeerLinks: async () => {
          throw new GraphQLApiError('UNAUTHENTICATED', 'the api key was rejected', 'myPeerLinks');
        },
      },
    );

    await expect(peersListCommand(ctx)).rejects.toMatchObject({ status: 401 });
  });
});

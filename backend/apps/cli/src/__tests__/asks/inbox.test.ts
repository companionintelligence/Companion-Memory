import { asksInboxCommand } from '../../commands/asks/inbox';
import { GraphQLApiError } from '../../graphqlClient';
import { askFixture } from '../support/fixtures';
import { harness } from '../support/harness';

describe('ci asks inbox', () => {
  it('prints what is waiting for review', async () => {
    const ctx = harness({}, { askInbox: async () => [askFixture({ peerHandle: 'alice@portal.example' })] });

    await asksInboxCommand(ctx);

    const text = ctx.term.text();

    expect(text).toContain('alice@portal.example');
    expect(text).toContain('content');
    expect(text).toContain('delivered');
  });

  it('says so when the inbox is empty', async () => {
    const ctx = harness({}, { askInbox: async () => [] });

    await asksInboxCommand(ctx);

    expect(ctx.term.text()).toContain('Nothing waiting');
  });

  it('emits the raw list under --json', async () => {
    const ctx = harness({}, { askInbox: async () => [askFixture()] });

    await asksInboxCommand(ctx, { json: true });

    expect(JSON.parse(ctx.term.text())[0].id).toBe('ask_1');
  });

  it('does not swallow an auth failure', async () => {
    const ctx = harness(
      {},
      {
        askInbox: async () => {
          throw new GraphQLApiError('UNAUTHENTICATED', 'bad key', 'askInbox');
        },
      },
    );

    await expect(asksInboxCommand(ctx)).rejects.toMatchObject({ status: 401 });
  });
});

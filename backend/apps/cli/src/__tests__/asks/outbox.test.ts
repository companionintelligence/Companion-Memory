import { asksOutboxCommand } from '../../commands/asks/outbox';
import { GraphQLApiError } from '../../graphqlClient';
import { askFixture } from '../support/fixtures';
import { harness } from '../support/harness';

describe('ci asks outbox', () => {
  it('prints what has been sent', async () => {
    const ctx = harness(
      {},
      { askOutbox: async () => [askFixture({ direction: 'outbound', responderId: 'user_3' })] },
    );

    await asksOutboxCommand(ctx);

    expect(ctx.term.text()).toContain('user_3');
  });

  it('says so when nothing has been sent', async () => {
    const ctx = harness({}, { askOutbox: async () => [] });

    await asksOutboxCommand(ctx);

    expect(ctx.term.text()).toContain('Nothing sent yet');
  });

  it('does not swallow an auth failure', async () => {
    const ctx = harness(
      {},
      {
        askOutbox: async () => {
          throw new GraphQLApiError('UNAUTHENTICATED', 'bad key', 'askOutbox');
        },
      },
    );

    await expect(asksOutboxCommand(ctx)).rejects.toMatchObject({ status: 401 });
  });
});

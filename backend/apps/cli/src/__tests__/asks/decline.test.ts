import { asksDeclineCommand } from '../../commands/asks/decline';
import { GraphQLApiError } from '../../graphqlClient';
import { askFixture } from '../support/fixtures';
import { harness } from '../support/harness';

describe('ci asks decline', () => {
  it('declines the ask', async () => {
    const ctx = harness(
      {},
      { declineAsk: async () => ({ success: true, ask: askFixture({ status: 'declined' }) }) },
    );

    await asksDeclineCommand(ctx, 'ask_1');

    expect(ctx.term.text()).toBe('Declined ask_1.');
  });

  it('reports the ask feature being disabled distinctly from a refusal', async () => {
    const ctx = harness({}, { declineAsk: async () => ({ success: false, ask: null }) });

    await expect(asksDeclineCommand(ctx, 'ask_1')).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('feature is disabled'),
    });
  });

  it('does not swallow an auth failure', async () => {
    const ctx = harness(
      {},
      {
        declineAsk: async () => {
          throw new GraphQLApiError('UNAUTHENTICATED', 'bad key', 'declineAsk');
        },
      },
    );

    await expect(asksDeclineCommand(ctx, 'ask_1')).rejects.toMatchObject({ status: 401 });
  });
});

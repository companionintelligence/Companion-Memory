import { asksApproveCommand } from '../../commands/asks/approve';
import { GraphQLApiError } from '../../graphqlClient';
import { askFixture } from '../support/fixtures';
import { harness } from '../support/harness';

describe('ci-import asks approve', () => {
  it('approves the ask', async () => {
    const ctx = harness(
      {},
      { approveAsk: async () => ({ success: true, ask: askFixture({ status: 'answering' }) }) },
    );

    await asksApproveCommand(ctx, 'ask_1');

    expect(ctx.term.text()).toBe('Approved ask_1 — status answering.');
  });

  it('reports the ask feature being disabled distinctly from a refusal', async () => {
    const ctx = harness({}, { approveAsk: async () => ({ success: false, ask: null }) });

    await expect(asksApproveCommand(ctx, 'ask_1')).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('feature is disabled'),
    });
  });

  it('does not swallow an auth failure', async () => {
    const ctx = harness(
      {},
      {
        approveAsk: async () => {
          throw new GraphQLApiError('UNAUTHENTICATED', 'bad key', 'approveAsk');
        },
      },
    );

    await expect(asksApproveCommand(ctx, 'ask_1')).rejects.toMatchObject({ status: 401 });
  });
});

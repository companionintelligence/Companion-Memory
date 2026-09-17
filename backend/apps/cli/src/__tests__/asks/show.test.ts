import { asksShowCommand } from '../../commands/asks/show';
import { GraphQLApiError } from '../../graphqlClient';
import { askAnswerFixture, askFixture } from '../support/fixtures';
import { harness } from '../support/harness';

describe('ci asks show', () => {
  it('shows an unanswered ask without fetching an answer', async () => {
    const ctx = harness(
      {},
      {
        ask: async () => askFixture({ status: 'delivered' }),
        // askAnswer deliberately unstubbed: the harness throws if it is called,
        // which is exactly the assertion — a non-answered ask must not fetch one.
      },
    );

    await asksShowCommand(ctx, 'ask_1');

    expect(ctx.term.text()).toContain('delivered');
  });

  it('fetches and prints the answer once the ask is answered', async () => {
    const ctx = harness(
      {},
      {
        ask: async () => askFixture({ status: 'answered' }),
        askAnswer: async () => askAnswerFixture({ summary: 'Yes, three photos.' }),
      },
    );

    await asksShowCommand(ctx, 'ask_1');

    expect(ctx.term.text()).toContain('Yes, three photos.');
    expect(ctx.term.text()).toContain('disclosed 3');
  });

  it('treats a null ask as a CliError', async () => {
    const ctx = harness({}, { ask: async () => null });

    await expect(asksShowCommand(ctx, 'ask_9')).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('not found'),
    });
  });

  it('does not swallow an auth failure', async () => {
    const ctx = harness(
      {},
      {
        ask: async () => {
          throw new GraphQLApiError('UNAUTHENTICATED', 'bad key', 'ask');
        },
      },
    );

    await expect(asksShowCommand(ctx, 'ask_1')).rejects.toMatchObject({ status: 401 });
  });
});

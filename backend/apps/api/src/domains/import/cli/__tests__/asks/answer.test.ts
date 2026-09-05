import { asksAnswerCommand } from '../../commands/asks/answer';
import type { MemoryGraphQLClient } from '../../graphqlClient';
import { GraphQLApiError } from '../../graphqlClient';
import { askAnswerFixture, askFixture } from '../support/fixtures';
import { harness } from '../support/harness';

type RunAskOptions = Parameters<MemoryGraphQLClient['runAsk']>[1];

describe('ci-import asks answer', () => {
  it('passes --redact as a parsed list and --disclosure-form through to runAsk', async () => {
    const seen: RunAskOptions[] = [];
    const ctx = harness(
      {},
      {
        runAsk: async (_id, options) => {
          seen.push(options ?? {});

          return {
            success: true,
            ask: askFixture({ status: 'answered' }),
            answer: askAnswerFixture({ summary: 'Redacted two items.' }),
            disclosedCount: 1,
            withheldCount: 2,
          };
        },
      },
    );

    await asksAnswerCommand(ctx, 'ask_1', { redact: 'e1, e2', disclosureForm: 'boolean' });

    expect(seen).toEqual([{ redactItemIds: ['e1', 'e2'], disclosureForm: 'boolean' }]);
    expect(ctx.term.text()).toContain('disclosed 1, withheld 2');
    expect(ctx.term.text()).toContain('Redacted two items.');
  });

  it('rejects an unknown --disclosure-form before making a call', async () => {
    const ctx = harness({}, {});

    await expect(asksAnswerCommand(ctx, 'ask_1', { disclosureForm: 'summary' })).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('--disclosure-form must be one of'),
    });
  });

  it('reports the ask feature being disabled distinctly from a refusal', async () => {
    const ctx = harness(
      {},
      {
        runAsk: async () => ({
          success: false,
          ask: null,
          answer: null,
          disclosedCount: null,
          withheldCount: null,
        }),
      },
    );

    await expect(asksAnswerCommand(ctx, 'ask_1')).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('feature is disabled'),
    });
  });

  it('surfaces the server’s refusal when the caller is not the responder', async () => {
    const ctx = harness(
      {},
      {
        runAsk: async () => {
          throw new GraphQLApiError('FORBIDDEN', 'Only the responder may run this ask', 'runAsk');
        },
      },
    );

    await expect(asksAnswerCommand(ctx, 'ask_1')).rejects.toMatchObject({
      status: 403,
      message: 'Only the responder may run this ask',
    });
  });

  it('does not swallow an auth failure', async () => {
    const ctx = harness(
      {},
      {
        runAsk: async () => {
          throw new GraphQLApiError('UNAUTHENTICATED', 'bad key', 'runAsk');
        },
      },
    );

    await expect(asksAnswerCommand(ctx, 'ask_1')).rejects.toMatchObject({ status: 401 });
  });
});

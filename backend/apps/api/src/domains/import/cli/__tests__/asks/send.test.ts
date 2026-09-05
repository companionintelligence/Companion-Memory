import { asksSendCommand } from '../../commands/asks/send';
import { GraphQLApiError } from '../../graphqlClient';
import { askFixture } from '../support/fixtures';
import { harness } from '../support/harness';

describe('ci-import asks send', () => {
  it('submits a local ask with the given responderId, prompt and queryType', async () => {
    const seen: unknown[] = [];
    const ctx = harness(
      {},
      {
        createAsk: async (input) => {
          seen.push(input);

          return { success: true, decision: 'accepted', ask: askFixture({ status: 'delivered' }) };
        },
      },
    );

    await asksSendCommand(ctx, 'user_2', 'Do you have the photos?', {
      queryType: 'content',
      dataClass: 'photos',
    });

    expect(seen).toEqual([
      {
        responderId: 'user_2',
        query: { queryType: 'content', prompt: 'Do you have the photos?', dataClass: 'photos' },
      },
    ]);
    expect(ctx.term.text()).toContain('delivered');
  });

  it('requires --query-type before making a call', async () => {
    const ctx = harness({}, {});

    await expect(asksSendCommand(ctx, 'user_2', 'hi')).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('--query-type is required'),
    });
  });

  it('surfaces the server’s own message for a malformed queryType, verbatim', async () => {
    const ctx = harness(
      {},
      {
        createAsk: async () => {
          throw new GraphQLApiError(
            'BAD_USER_INPUT',
            'queryType must be one of: relationship, content, availability, attribute, identity',
            'createAsk',
          );
        },
      },
    );

    await expect(asksSendCommand(ctx, 'user_2', 'hi', { queryType: 'pictures' })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('queryType must be one of'),
    });
  });

  it('reports the ask feature being disabled distinctly from a refusal', async () => {
    const ctx = harness({}, { createAsk: async () => ({ success: false, decision: null, ask: null }) });

    await expect(asksSendCommand(ctx, 'user_2', 'hi', { queryType: 'content' })).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('feature is disabled'),
    });
  });

  it('does not swallow an auth failure', async () => {
    const ctx = harness(
      {},
      {
        createAsk: async () => {
          throw new GraphQLApiError('UNAUTHENTICATED', 'bad key', 'createAsk');
        },
      },
    );

    await expect(asksSendCommand(ctx, 'user_2', 'hi', { queryType: 'content' })).rejects.toMatchObject({
      status: 401,
    });
  });
});

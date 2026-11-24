import { asksHistoryCommand } from '../../commands/asks/history';
import type { MemoryGraphQLClient } from '../../graphqlClient';
import { GraphQLApiError } from '../../graphqlClient';
import { askAuditFixture } from '../support/fixtures';
import { harness } from '../support/harness';

type HistoryInput = Parameters<MemoryGraphQLClient['askDisclosureHistory']>[0];

describe('ci asks history', () => {
  it('parses --outcome and --limit and forwards them, prints the truncation footer', async () => {
    const seen: HistoryInput[] = [];
    const ctx = harness(
      {},
      {
        askDisclosureHistory: async (input) => {
          seen.push(input);

          return { rows: [askAuditFixture()], truncated: true };
        },
      },
    );

    await asksHistoryCommand(ctx, { outcome: 'answered,declined', limit: '10' });

    expect(seen).toEqual([
      {
        counterpartyKey: undefined,
        outcomes: ['answered', 'declined'],
        from: undefined,
        to: undefined,
        limit: 10,
      },
    ]);
    expect(ctx.term.text()).toContain('(truncated');
  });

  it('rejects a non-numeric --limit before making a call', async () => {
    const ctx = harness({}, {});

    await expect(asksHistoryCommand(ctx, { limit: 'lots' })).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('--limit takes a whole number'),
    });
  });

  it.each(['-3', '0', '1.5'])('rejects --limit %j before making a call', async (limit) => {
    const ctx = harness({}, {});

    await expect(asksHistoryCommand(ctx, { limit })).rejects.toMatchObject({ exitCode: 2 });
  });

  it('says so when there is no history yet', async () => {
    const ctx = harness({}, { askDisclosureHistory: async () => ({ rows: [], truncated: false }) });

    await asksHistoryCommand(ctx);

    expect(ctx.term.text()).toContain('No disclosure history yet.');
  });

  it('does not swallow an auth failure', async () => {
    const ctx = harness(
      {},
      {
        askDisclosureHistory: async () => {
          throw new GraphQLApiError('UNAUTHENTICATED', 'bad key', 'askDisclosureHistory');
        },
      },
    );

    await expect(asksHistoryCommand(ctx)).rejects.toMatchObject({ status: 401 });
  });
});

import { grantsHistoryCommand } from '../../commands/grants/history';
import { GraphQLApiError } from '../../graphqlClient';
import { grantFixture } from '../support/fixtures';
import { harness } from '../support/harness';

describe('ci-import grants history', () => {
  it('lists the whole ledger when no id is given', async () => {
    const rows = [
      grantFixture({ id: 'g1', version: 1, active: false, revocationReason: 'superseded' }),
      grantFixture({ id: 'g2', version: 2, supersedesGrantId: 'g1' }),
      grantFixture({ id: 'g9', queryType: 'availability' }),
    ];
    const ctx = harness({}, { myAskGrantHistory: async () => rows });

    await grantsHistoryCommand(ctx, undefined);

    const text = ctx.term.text();

    expect(text).toContain('g1');
    expect(text).toContain('g2');
    expect(text).toContain('g9');
  });

  it('narrows to one grant’s own chain when an id is given', async () => {
    const rows = [
      grantFixture({ id: 'g1', version: 1, active: false, revocationReason: 'superseded' }),
      grantFixture({ id: 'g2', version: 2, supersedesGrantId: 'g1' }),
      grantFixture({ id: 'g9', queryType: 'availability' }),
    ];
    const ctx = harness({}, { myAskGrantHistory: async () => rows });

    await grantsHistoryCommand(ctx, 'g2', { json: true });

    const parsed = JSON.parse(ctx.term.text()) as Array<{ id: string }>;

    expect(parsed.map((row) => row.id).sort()).toEqual(['g1', 'g2']);
  });

  it('reports no history for an id that never existed, rather than the whole ledger', async () => {
    const ctx = harness({}, { myAskGrantHistory: async () => [grantFixture({ id: 'g1' })] });

    await grantsHistoryCommand(ctx, 'nope');

    expect(ctx.term.text()).toContain('No history found for grant nope');
  });

  it('does not swallow an auth failure', async () => {
    const ctx = harness(
      {},
      {
        myAskGrantHistory: async () => {
          throw new GraphQLApiError('UNAUTHENTICATED', 'bad key', 'myAskGrantHistory');
        },
      },
    );

    await expect(grantsHistoryCommand(ctx, undefined)).rejects.toMatchObject({ status: 401 });
  });
});

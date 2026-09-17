import { grantsRevokeCommand } from '../../commands/grants/revoke';
import { GraphQLApiError } from '../../graphqlClient';
import { grantFixture } from '../support/fixtures';
import { harness } from '../support/harness';

describe('ci grants revoke', () => {
  it('revokes the grant', async () => {
    const ctx = harness(
      {},
      {
        revokeAskGrant: async (id) => ({
          success: true,
          grant: grantFixture({
            id,
            active: false,
            revokedAt: '2026-08-02T00:00:00.000Z',
            revocationReason: 'revoked',
          }),
        }),
      },
    );

    await grantsRevokeCommand(ctx, 'grant_1');

    expect(ctx.term.text()).toBe('Revoked grant grant_1.');
  });

  it('reports the ask feature being disabled distinctly from a refusal', async () => {
    const ctx = harness({}, { revokeAskGrant: async () => ({ success: false, grant: null }) });

    await expect(grantsRevokeCommand(ctx, 'grant_1')).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('feature is disabled'),
    });
  });

  it('does not swallow an auth failure', async () => {
    const ctx = harness(
      {},
      {
        revokeAskGrant: async () => {
          throw new GraphQLApiError('UNAUTHENTICATED', 'bad key', 'revokeAskGrant');
        },
      },
    );

    await expect(grantsRevokeCommand(ctx, 'grant_1')).rejects.toMatchObject({ status: 401 });
  });
});

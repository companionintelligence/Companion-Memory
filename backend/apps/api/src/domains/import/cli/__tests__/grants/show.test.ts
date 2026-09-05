import { grantsShowCommand } from '../../commands/grants/show';
import { GraphQLApiError } from '../../graphqlClient';
import { grantFixture } from '../support/fixtures';
import { harness } from '../support/harness';

describe('ci-import grants show', () => {
  it('prints the grant’s full detail', async () => {
    const ctx = harness({}, { askGrant: async () => grantFixture({ purpose: 'planning a surprise' }) });

    await grantsShowCommand(ctx, 'grant_1');

    const text = ctx.term.text();

    expect(text).toContain('grant_1');
    expect(text).toContain('user:user_1');
    expect(text).toContain('planning a surprise');
  });

  it('treats a null result (not found, or the feature is off) as a CliError rather than printing "undefined"', async () => {
    const ctx = harness({}, { askGrant: async () => null });

    await expect(grantsShowCommand(ctx, 'grant_9')).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('not found'),
    });
  });

  it('does not swallow an auth failure', async () => {
    const ctx = harness(
      {},
      {
        askGrant: async () => {
          throw new GraphQLApiError('UNAUTHENTICATED', 'bad key', 'askGrant');
        },
      },
    );

    await expect(grantsShowCommand(ctx, 'grant_1')).rejects.toMatchObject({ status: 401 });
  });
});

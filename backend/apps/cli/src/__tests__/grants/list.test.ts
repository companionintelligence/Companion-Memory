import { grantsListCommand } from '../../commands/grants/list';
import { GraphQLApiError } from '../../graphqlClient';
import { grantFixture as grant } from '../support/fixtures';
import { harness } from '../support/harness';

describe('ci grants list', () => {
  it('prints active grants with their grantee described either way', async () => {
    const ctx = harness(
      {},
      {
        myAskGrants: async () => [
          grant(),
          grant({ id: 'grant_2', granteeId: null, granteePeerLinkId: 'pl_1', queryType: 'availability' }),
        ],
      },
    );

    await grantsListCommand(ctx);

    const text = ctx.term.text();

    expect(text).toContain('user:user_1');
    expect(text).toContain('peer-link:pl_1');
    expect(text).toContain('content');
    expect(text).toContain('availability');
  });

  it('emits the raw list under --json', async () => {
    const ctx = harness({}, { myAskGrants: async () => [grant()] });

    await grantsListCommand(ctx, { json: true });

    expect(JSON.parse(ctx.term.text())[0].id).toBe('grant_1');
  });

  it('does not swallow an auth failure', async () => {
    const ctx = harness(
      {},
      {
        myAskGrants: async () => {
          throw new GraphQLApiError('UNAUTHENTICATED', 'bad key', 'myAskGrants');
        },
      },
    );

    await expect(grantsListCommand(ctx)).rejects.toMatchObject({ status: 401 });
  });
});

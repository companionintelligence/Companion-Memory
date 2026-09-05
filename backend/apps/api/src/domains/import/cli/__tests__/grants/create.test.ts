import { grantsCreateCommand } from '../../commands/grants/create';
import type { MemoryGraphQLClient } from '../../graphqlClient';
import { GraphQLApiError } from '../../graphqlClient';
import { grantFixture, peerLinkFixture } from '../support/fixtures';
import { harness } from '../support/harness';

type CreateAskGrantInput = Parameters<MemoryGraphQLClient['createAskGrant']>[0];

function grantHarness(createAskGrant: MemoryGraphQLClient['createAskGrant']) {
  return harness({}, { myPeerLinks: async () => [], createAskGrant });
}

describe('ci-import grants create', () => {
  it('resolves a matching peer handle to granteePeerLinkId, never granteeId', async () => {
    const seen: CreateAskGrantInput[] = [];
    const ctx = harness(
      {},
      {
        myPeerLinks: async () => [peerLinkFixture({ id: 'pl_1', peerHandle: 'alice@portal.example' })],
        createAskGrant: async (input) => {
          seen.push(input);

          return { success: true, grant: grantFixture({ granteeId: null, granteePeerLinkId: 'pl_1' }) };
        },
      },
    );

    await grantsCreateCommand(ctx, 'alice@portal.example', 'content');

    expect(seen[0].granteePeerLinkId).toBe('pl_1');
    expect(seen[0].granteeId).toBeUndefined();
  });

  it('falls back to a raw user id when no peer link matches', async () => {
    const seen: CreateAskGrantInput[] = [];
    const ctx = grantHarness(async (input) => {
      seen.push(input);

      return { success: true, grant: grantFixture({ granteeId: 'user_9', granteePeerLinkId: null }) };
    });

    await grantsCreateCommand(ctx, 'user_9', 'content');

    expect(seen[0]).toEqual({
      granteeId: 'user_9',
      granteePeerLinkId: undefined,
      queryType: 'content',
      dataClass: undefined,
      maxDisclosure: undefined,
      mode: 'review',
      purpose: undefined,
    });
  });

  it('defaults --mode to review, matching GrantService.create’s own fallback', async () => {
    const seen: CreateAskGrantInput[] = [];
    const ctx = grantHarness(async (input) => {
      seen.push(input);

      return { success: true, grant: grantFixture({ granteeId: 'user_9', granteePeerLinkId: null }) };
    });

    await grantsCreateCommand(ctx, 'user_9', 'content');

    expect(seen[0].mode).toBe('review');
  });

  it('rejects an unknown --mode before making a call', async () => {
    const ctx = grantHarness(async () => {
      throw new Error('should not be called');
    });

    await expect(grantsCreateCommand(ctx, 'user_9', 'content', { mode: 'sometimes' })).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('--mode must be one of'),
    });
  });

  it('surfaces the server’s own message for a malformed queryType, verbatim', async () => {
    const ctx = grantHarness(async () => {
      throw new GraphQLApiError(
        'BAD_USER_INPUT',
        'queryType must be one of: relationship, content, availability, attribute, identity',
        'createAskGrant',
      );
    });

    await expect(grantsCreateCommand(ctx, 'user_9', 'photos-2')).rejects.toMatchObject({
      status: 400,
      message: 'queryType must be one of: relationship, content, availability, attribute, identity',
    });
  });

  it('reports the ask feature being disabled distinctly from a refusal', async () => {
    const ctx = grantHarness(async () => ({ success: false, grant: null }));

    await expect(grantsCreateCommand(ctx, 'user_9', 'content')).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('feature is disabled'),
    });
  });

  it('does not swallow an auth failure', async () => {
    const ctx = grantHarness(async () => {
      throw new GraphQLApiError('UNAUTHENTICATED', 'bad key', 'createAskGrant');
    });

    await expect(grantsCreateCommand(ctx, 'user_9', 'content')).rejects.toMatchObject({ status: 401 });
  });
});

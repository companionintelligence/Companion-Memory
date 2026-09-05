import { grantsUpdateCommand } from '../../commands/grants/update';
import type { MemoryGraphQLClient } from '../../graphqlClient';
import { GraphQLApiError } from '../../graphqlClient';
import { grantFixture } from '../support/fixtures';
import { harness } from '../support/harness';

type UpdateAskGrantInput = Parameters<MemoryGraphQLClient['updateAskGrant']>[1];

describe('ci-import grants update', () => {
  it('omits every dimension the caller did not touch — never sends an explicit null for it', async () => {
    const seen: UpdateAskGrantInput[] = [];
    const ctx = harness(
      {},
      {
        updateAskGrant: async (_id, input) => {
          seen.push(input);

          return { success: true, grant: grantFixture({ mode: 'block', version: 2 }) };
        },
      },
    );

    // Only --mode is touched. A grant created earlier with --max-disclosure
    // summary must not have that ceiling silently cleared by this call — see
    // `UpdateAskGrantInput`'s own schema docstring for the bug this guards.
    await grantsUpdateCommand(ctx, 'grant_1', { mode: 'block' });

    expect(seen[0]).toEqual({
      mode: 'block',
      dataClass: undefined,
      maxDisclosure: undefined,
      purpose: undefined,
      expiresAt: undefined,
      clearExpiry: undefined,
    });
    // Not merely absent from a `toEqual` match — genuinely `undefined`, which is
    // what makes `JSON.stringify` drop the key entirely rather than send `null`.
    expect(seen[0].maxDisclosure).toBeUndefined();
    expect(JSON.stringify(seen[0])).not.toContain('maxDisclosure');
  });

  it('passes --max-disclosure through when the caller does touch it', async () => {
    const seen: UpdateAskGrantInput[] = [];
    const ctx = harness(
      {},
      {
        updateAskGrant: async (_id, input) => {
          seen.push(input);

          return { success: true, grant: grantFixture() };
        },
      },
    );

    await grantsUpdateCommand(ctx, 'grant_1', { maxDisclosure: 'summary' });

    expect(seen[0].maxDisclosure).toBe('summary');
  });

  it('refuses both --expires-at and --clear-expiry at once, before making a call', async () => {
    const ctx = harness({}, {});

    await expect(
      grantsUpdateCommand(ctx, 'grant_1', { expiresAt: '2027-01-01T00:00:00.000Z', clearExpiry: true }),
    ).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining('not both') });
  });

  it('refuses an update that touches nothing', async () => {
    const ctx = harness({}, {});

    await expect(grantsUpdateCommand(ctx, 'grant_1')).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('Nothing to update'),
    });
  });

  it('rejects an unknown --max-disclosure before making a call', async () => {
    const ctx = harness({}, {});

    await expect(grantsUpdateCommand(ctx, 'grant_1', { maxDisclosure: 'everything' })).rejects.toMatchObject({
      exitCode: 2,
    });
  });

  it('surfaces the server’s refusal when the grant is no longer active', async () => {
    const ctx = harness(
      {},
      {
        updateAskGrant: async () => {
          throw new GraphQLApiError(
            'BAD_USER_INPUT',
            'Grant grant_1 is no longer active and cannot be changed; create a new grant',
            'updateAskGrant',
          );
        },
      },
    );

    await expect(grantsUpdateCommand(ctx, 'grant_1', { mode: 'block' })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('no longer active'),
    });
  });

  it('does not swallow an auth failure', async () => {
    const ctx = harness(
      {},
      {
        updateAskGrant: async () => {
          throw new GraphQLApiError('UNAUTHENTICATED', 'bad key', 'updateAskGrant');
        },
      },
    );

    await expect(grantsUpdateCommand(ctx, 'grant_1', { mode: 'block' })).rejects.toMatchObject({
      status: 401,
    });
  });
});

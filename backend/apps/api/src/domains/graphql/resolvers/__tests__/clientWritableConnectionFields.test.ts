import { GlobalUID } from '../../types/GlobalUID';
import { ConnectionResolver } from '../ConnectionResolver';
import { ConnectionSyncJobResolver } from '../ConnectionSyncJobResolver';

/**
 * Fields a client must not be able to write, even if a request carries them.
 *
 * They are gone from the GraphQL input types, so the schema already rejects them. These tests pin
 * the resolvers too: an object that still has one (a stale client, or an MCP tool that builds the
 * input by hand) must not get it through to the service.
 *
 * - `externalId` on a connection names the provider account. The appliance sends it to CI Portal
 *   to address a stored grant on disconnect, and every account shares Portal's device, so a
 *   writable id let one account aim its disconnect at another account's grant.
 * - `status`, `data`, `cursor` and `nextCursor` on a sync job are the executor's. A "successful"
 *   job with a payload of the caller's making was transformed as provider data, and its media
 *   URLs downloaded.
 */

const ctx = { userId: 'user-1' };

describe('ConnectionResolver.updateConnection', () => {
  it('never passes an externalId to the service', async () => {
    const connectionService = { update: jest.fn(async () => null) };
    const resolver = new ConnectionResolver(
      connectionService as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await resolver.updateConnection(ctx, {
      id: GlobalUID.encode('connection', 'conn-1'),
      name: 'Renamed',
      externalId: 'owners-provider-account-id',
    } as never);

    expect(connectionService.update).toHaveBeenCalledTimes(1);
    expect(connectionService.update.mock.calls[0]).toEqual([
      expect.anything(),
      'conn-1',
      expect.not.objectContaining({ externalId: expect.anything() }),
    ]);
  });
});

describe('ConnectionSyncJobResolver', () => {
  const EXECUTOR_FIELDS = {
    status: 'success',
    data: { photos: [{ id: 'x1', images: [{ source: 'http://169.254.169.254/latest/meta-data/' }] }] },
    cursor: { nextLink: 'https://graph.facebook.com/v19.0/me/posts?after=x' },
    nextCursor: { nextLink: 'https://graph.facebook.com/v19.0/me/posts?after=y' },
  };

  function build() {
    const connectionSyncJobService = {
      create: jest.fn(async () => null),
      update: jest.fn(async () => null),
    };
    const connectionLoader = { load: jest.fn(async () => ({ id: 'conn-1' })) };
    const resolver = new ConnectionSyncJobResolver(
      connectionSyncJobService as never,
      connectionLoader as never,
    );

    return { resolver, connectionSyncJobService };
  }

  const noExecutorFields = expect.not.objectContaining({
    status: expect.anything(),
    data: expect.anything(),
    cursor: expect.anything(),
    nextCursor: expect.anything(),
  });

  it('createConnectionSyncJob does not pass status, data or cursors to the service', async () => {
    const { resolver, connectionSyncJobService } = build();

    await resolver.createConnectionSyncJob(ctx, {
      userId: GlobalUID.encode('user', 'user-1'),
      connectionId: GlobalUID.encode('connection', 'conn-1'),
      endpointName: 'Photos',
      type: 'incremental',
      ...EXECUTOR_FIELDS,
    } as never);

    const [, input] = connectionSyncJobService.create.mock.calls[0] as unknown as [
      unknown,
      Record<string, unknown>,
    ];

    for (const field of Object.keys(EXECUTOR_FIELDS)) {
      expect(input[field]).toBeUndefined();
    }

    expect(input).toEqual(noExecutorFields);
  });

  it('updateConnectionSyncJob does not pass status, data or cursors to the service', async () => {
    const { resolver, connectionSyncJobService } = build();

    await resolver.updateConnectionSyncJob(ctx, {
      id: GlobalUID.encode('connectionSyncJob', 'job-1'),
      ...EXECUTOR_FIELDS,
    } as never);

    const [, , input] = connectionSyncJobService.update.mock.calls[0] as unknown as [
      unknown,
      unknown,
      Record<string, unknown>,
    ];

    for (const field of Object.keys(EXECUTOR_FIELDS)) {
      expect(input[field]).toBeUndefined();
    }
  });
});

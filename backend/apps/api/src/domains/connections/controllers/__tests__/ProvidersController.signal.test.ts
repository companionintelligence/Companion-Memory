import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';

import type { RequestContext } from '@ci/common/context';

import { SignalClient } from '../../clients/SignalClient';
import { ProvidersController } from '../ProvidersController';

/**
 * Connecting Signal (`POST /api/providers/:id` for the one `api_key` provider).
 *
 * The signal-cli REST service is appliance-wide, usually has no authentication of its own, and
 * can hold several numbers, each one person's messages; receiving dequeues them. The connection
 * used to be open to any account and bound to whichever number the service listed first, so a
 * household member could pull, and take, the owner's Signal messages.
 */

const SIGNAL = { id: 'signal-provider-id', name: 'Signal', authType: 'api_key' };
const OWNER_NUMBER = '+15550001111';
const SECOND_NUMBER = '+15550002222';

const ctx = { userId: 'admin-1' } as RequestContext;

function build(options: { admin?: boolean | 'throws'; accounts?: string[]; heldByAnother?: boolean } = {}) {
  const signalClient = Object.create(SignalClient.prototype) as SignalClient;
  const listAccounts = jest
    .spyOn(signalClient, 'listAccounts')
    .mockResolvedValue(options.accounts ?? [OWNER_NUMBER, SECOND_NUMBER]);
  const clientFactory = { getClientByProviderId: jest.fn(() => signalClient) };
  const connectionService = {
    create: jest.fn(async () => ({ id: 'conn-new' })),
    update: jest.fn(async () => ({ id: 'conn-new' })),
    externalAccountHeldByAnotherUser: jest.fn(async () => options.heldByAnother ?? false),
  };
  const providerService = { findById: jest.fn(async () => SIGNAL) };
  const adminGuard = {
    admits: jest.fn(async () => {
      if (options.admin === 'throws') {
        throw new Error('probe failed');
      }

      return options.admin ?? true;
    }),
  };
  const logger = { setContext: jest.fn(), log: jest.fn(), error: jest.fn() };

  const controller = new ProvidersController(
    clientFactory as never,
    {} as never,
    connectionService as never,
    providerService as never,
    {} as never,
    adminGuard as never,
    logger as never,
  );

  return { controller, connectionService, listAccounts };
}

const connect = (controller: ProvidersController, body: Record<string, unknown>, role = 'admin') =>
  controller.connect(ctx, SIGNAL.id, { endpoints: ['Messages'], ...body } as never, { user: { role } });

describe('ProvidersController connecting Signal', () => {
  it.each([
    ['an account that is not an administrator', false],
    ['a caller whose admin check could not be answered', 'throws'],
  ] as const)('refuses %s before asking the service anything', async (_label, admin) => {
    const { controller, connectionService, listAccounts } = build({ admin });

    await expect(connect(controller, { apiKey: 'k', account: OWNER_NUMBER }, 'user')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(listAccounts).not.toHaveBeenCalled();
    expect(connectionService.create).not.toHaveBeenCalled();
  });

  it('requires the number to be named, instead of taking the first one the service lists', async () => {
    const { controller, connectionService } = build();

    await expect(connect(controller, { apiKey: 'k' })).rejects.toBeInstanceOf(BadRequestException);
    expect(connectionService.create).not.toHaveBeenCalled();
  });

  it('refuses a number the service does not hold', async () => {
    const { controller, connectionService } = build({ accounts: [OWNER_NUMBER] });

    await expect(connect(controller, { apiKey: 'k', account: '+15559990000' })).rejects.toThrow(
      'The Signal service does not hold that number.',
    );
    expect(connectionService.create).not.toHaveBeenCalled();
  });

  it('refuses a number another account already connected', async () => {
    const { controller, connectionService } = build({ heldByAnother: true });

    await expect(connect(controller, { apiKey: 'k', account: SECOND_NUMBER })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(connectionService.externalAccountHeldByAnotherUser).toHaveBeenCalledWith(
      'admin-1',
      SIGNAL.id,
      SECOND_NUMBER,
    );
    expect(connectionService.create).not.toHaveBeenCalled();
  });

  it('binds the connection to the named number, as the service spells it', async () => {
    const { controller, connectionService } = build();

    await expect(connect(controller, { apiKey: 'k', account: '+1 (555) 000-2222' })).resolves.toEqual({
      authorizationUrl: '',
    });
    expect(connectionService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ externalId: SECOND_NUMBER, accessToken: 'k', providerId: SIGNAL.id }),
    );
    expect(connectionService.update).toHaveBeenCalledWith(expect.anything(), 'conn-new', { active: true });
  });
});

describe('SignalClient', () => {
  it('never binds a connection with no number to whichever number the service lists first', async () => {
    const client = Object.create(SignalClient.prototype) as SignalClient;
    const listAccounts = jest.spyOn(client, 'listAccounts').mockResolvedValue([OWNER_NUMBER]);

    await expect(
      client.getAccountIdentifier({ externalId: null, accessToken: 'k' } as never),
    ).rejects.toThrow('Signal connection has no number');
    expect(listAccounts).not.toHaveBeenCalled();
    await expect(client.getAccountIdentifier({ externalId: OWNER_NUMBER } as never)).resolves.toBe(
      OWNER_NUMBER,
    );
  });
});

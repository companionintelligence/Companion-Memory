import 'reflect-metadata';

import { ForbiddenException } from '@nestjs/common';

import { FULL_CAPABILITY, REQUIRE_CAPABILITY_KEY } from '@ci/common/decorators';

import { AccountDataController } from '../AccountDataController';

/**
 * An import deletes every row the account owns in every table it restores
 * before it writes the archive back, so an archive with empty tables empties
 * the account. That is the destructive tier: `full` from an api key, and never
 * an installed app's key.
 */
function makeController() {
  const portabilityService = {
    importArchive: jest.fn(async () => ({
      tablesImported: 0,
      rowsImported: 0,
      filesRestored: 0,
      format: 'json',
    })),
    importNdjsonStream: jest.fn(),
  };
  const userService = { findById: jest.fn(async () => ({ id: 'user-1', email: 'owner@example.com' })) };

  return {
    controller: new AccountDataController(portabilityService as never, userService as never),
    portabilityService,
  };
}

const ARCHIVE = {
  version: 1 as const,
  exportedAt: '2026-10-06T00:00:00.000Z',
  userId: '11111111-1111-4111-8111-111111111111',
  profile: null,
  tables: {},
  fileBlobs: [],
};

const installedApp = { apiKeyScopes: [], apiKeyCapability: 'full', apiKeyManagedBy: 'connect' } as never;

describe('AccountDataController imports', () => {
  it.each(['importLegacy', 'importStream'] as const)('%s requires full from an api key', (method) => {
    expect(Reflect.getMetadata(REQUIRE_CAPABILITY_KEY, AccountDataController.prototype[method])).toBe(
      FULL_CAPABILITY,
    );
  });

  it('export stays a read', () => {
    expect(
      Reflect.getMetadata(REQUIRE_CAPABILITY_KEY, AccountDataController.prototype.export),
    ).toBeUndefined();
  });

  it("refuses an installed app's key on the JSON import, before anything is deleted", async () => {
    const { controller, portabilityService } = makeController();

    await expect(
      controller.importLegacy({ userId: 'user-1' } as never, installedApp, {
        confirmEmail: 'owner@example.com',
        archive: ARCHIVE,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(portabilityService.importArchive).not.toHaveBeenCalled();
  });

  it("refuses an installed app's key on the stream import, before anything is read", async () => {
    const { controller, portabilityService } = makeController();
    const req = { ...(installedApp as object), headers: { 'content-type': 'application/x-ndjson' } } as never;

    await expect(
      controller.importStream({ userId: 'user-1' } as never, req, 'owner@example.com'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(portabilityService.importNdjsonStream).not.toHaveBeenCalled();
  });

  it("lets the owner's own key import", async () => {
    const { controller, portabilityService } = makeController();

    await controller.importLegacy(
      { userId: 'user-1' } as never,
      { apiKeyScopes: [], apiKeyCapability: 'full', apiKeyManagedBy: null } as never,
      { confirmEmail: 'owner@example.com', archive: ARCHIVE },
    );

    expect(portabilityService.importArchive).toHaveBeenCalledTimes(1);
  });
});

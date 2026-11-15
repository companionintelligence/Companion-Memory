import { ForbiddenException } from '@nestjs/common';

import type { RequestContext } from '@ci/common/context';
import { READ_CAPABILITY, REQUIRE_CAPABILITY_KEY } from '@ci/common/decorators';
import type { ApiKeyScopedRequest } from '@ci/common/guards';
import type { LoggerService } from '@ci/common/logging';
import type { CommunicationService, UserContextService } from '@ci/domains/memory';

import type { AgentMemoryService } from '../../services/AgentMemoryService';
import type { ForecastContextService } from '../../services/ForecastContextService';
import type { MemoryCompactionService } from '../../services/MemoryCompactionService';
import type { RecallService } from '../../services/RecallService';
import { MemoryController } from '../MemoryController';

/**
 * `POST /memory/drift` answers two requests. Detecting drift reads; marking
 * the matches `conflicted` writes their status. A `read` key reaches the route
 * (commit hooks ship with one), so the write half has to be refused in the
 * handler, by the capability the key actually carries.
 */

const USER_ID = '00000000-0000-4000-8000-000000000001';
const REPORT = { checkedCount: 1, driftedCount: 0, matches: [] };

function makeController() {
  const detectDrift = jest.fn(async () => REPORT);

  const controller = new MemoryController(
    undefined as unknown as UserContextService,
    undefined as unknown as RecallService,
    { detectDrift } as unknown as AgentMemoryService,
    undefined as unknown as CommunicationService,
    undefined as unknown as ForecastContextService,
    undefined as unknown as MemoryCompactionService,
    { setContext: () => undefined } as unknown as LoggerService,
  );

  return { controller, detectDrift };
}

/** What `ApiKeyStrategy` leaves on the request for a memory-scoped key. */
function apiKey(capability: 'read' | 'write' | 'full'): ApiKeyScopedRequest {
  return { apiKeyScopes: ['memory'], apiKeyCapability: capability } as ApiKeyScopedRequest;
}

const context = () => ({ userId: USER_ID }) as RequestContext;

describe('MemoryController POST /memory/drift', () => {
  it('keeps the route itself at read, so a read-only key can still detect drift', async () => {
    expect(Reflect.getMetadata(REQUIRE_CAPABILITY_KEY, MemoryController.prototype.drift)).toBe(
      READ_CAPABILITY,
    );

    const { controller, detectDrift } = makeController();

    await expect(
      controller.drift(context(), apiKey('read'), { changedPaths: ['src/app.ts'] }),
    ).resolves.toEqual(REPORT);
    expect(detectDrift).toHaveBeenCalledWith({ userId: USER_ID }, ['src/app.ts'], {
      markConflicted: undefined,
    });
  });

  it('refuses a read-only key that asks to mark the matches conflicted, before touching anything', async () => {
    const { controller, detectDrift } = makeController();

    const attempt = controller.drift(context(), apiKey('read'), {
      changedPaths: ['src/app.ts'],
      markConflicted: true,
    });

    await expect(attempt).rejects.toBeInstanceOf(ForbiddenException);
    await expect(attempt).rejects.toThrow(/requires "write"/);
    expect(detectDrift).not.toHaveBeenCalled();
  });

  it.each(['write', 'full'] as const)('lets a %s key mark the matches conflicted', async (capability) => {
    const { controller, detectDrift } = makeController();

    await controller.drift(context(), apiKey(capability), {
      changedPaths: ['src/app.ts'],
      markConflicted: true,
    });

    expect(detectDrift).toHaveBeenCalledWith({ userId: USER_ID }, ['src/app.ts'], { markConflicted: true });
  });

  it('lets a signed-in session mark, since it is the user and carries no key capability', async () => {
    const { controller, detectDrift } = makeController();

    await controller.drift(context(), {} as ApiKeyScopedRequest, {
      changedPaths: ['src/app.ts'],
      markConflicted: true,
    });

    expect(detectDrift).toHaveBeenCalledWith({ userId: USER_ID }, ['src/app.ts'], { markConflicted: true });
  });
});

import 'reflect-metadata';

import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { REQUIRE_SCOPES_KEY } from '@ci/common/decorators';
import { type ApiKeyScopedRequest, enforceApiKeyScopes } from '@ci/common/guards';

import { AgentJobsController } from '../AgentJobsController';

/**
 * Who may reach `/v1/agent/jobs`, read off the real controller's metadata and run through the real
 * scope enforcement, so the scope a route declares and the scope a key carries are checked together.
 */
function contextFor(method: keyof AgentJobsController): ExecutionContext {
  return {
    getHandler: () => AgentJobsController.prototype[method],
    getClass: () => AgentJobsController,
  } as unknown as ExecutionContext;
}

const reach = (method: keyof AgentJobsController, scopes: string[] | undefined) => () =>
  enforceApiKeyScopes(new Reflector(), contextFor(method), { apiKeyScopes: scopes } as ApiKeyScopedRequest);

describe('/v1/agent/jobs scope', () => {
  it('is its own scope, not memory', () => {
    expect(Reflect.getMetadata(REQUIRE_SCOPES_KEY, AgentJobsController)).toEqual(['agent-jobs']);
  });

  it.each(['create', 'findByThread', 'findOne', 'packet', 'checkpoint', 'steer'] as const)(
    'a memory-only key (voice speaker, glasses bridge) cannot reach %s',
    (method) => {
      expect(reach(method, ['memory'])).toThrow(ForbiddenException);
    },
  );

  it('the chat-agent tier reaches it', () => {
    expect(reach('packet', ['memory', 'intents', 'mcp', 'agent-jobs'])).not.toThrow();
  });

  it('a session and an unscoped key (the web and mobile apps) are unaffected', () => {
    expect(reach('create', undefined)).not.toThrow();
    expect(reach('steer', [])).not.toThrow();
  });
});

describe('/v1/agent/jobs packet and checkpoint pass who is calling to the service', () => {
  function makeController() {
    const dispatchService = {
      getPacket: jest.fn(async () => ({})),
      checkpoint: jest.fn(async () => ({})),
    };

    return { controller: new AgentJobsController(dispatchService as never), dispatchService };
  }

  const context = { userId: 'user-1' } as never;

  it('the owner signed in', async () => {
    const { controller, dispatchService } = makeController();

    await controller.packet(context, {} as ApiKeyScopedRequest, 'job-1');

    expect(dispatchService.getPacket).toHaveBeenCalledWith({ userId: 'user-1' }, 'job-1', { kind: 'owner' });
  });

  it('the app a connect key was minted for, from provenance and then its name', async () => {
    const { controller, dispatchService } = makeController();

    await controller.checkpoint(
      context,
      {
        apiKeyScopes: ['memory', 'intents', 'mcp', 'agent-jobs'],
        apiKeyManagedBy: 'connect',
        apiKeyName: 'app:ci-openclaw:ci-marketplace',
      } as unknown as ApiKeyScopedRequest,
      'job-1',
      { status: 'completed' },
    );

    expect(dispatchService.checkpoint).toHaveBeenCalledWith(
      { userId: 'user-1' },
      'job-1',
      { status: 'completed' },
      {
        kind: 'api-key',
        connectApp: 'ci-openclaw',
      },
    );
  });

  it('no app at all for a hand-made key, whatever it is named', async () => {
    const { controller, dispatchService } = makeController();

    await controller.packet(
      context,
      {
        apiKeyScopes: [],
        apiKeyManagedBy: null,
        apiKeyName: 'app:ci-openclaw:ci-marketplace',
      } as unknown as ApiKeyScopedRequest,
      'job-1',
    );

    expect(dispatchService.getPacket).toHaveBeenCalledWith({ userId: 'user-1' }, 'job-1', {
      kind: 'api-key',
      connectApp: null,
    });
  });
});

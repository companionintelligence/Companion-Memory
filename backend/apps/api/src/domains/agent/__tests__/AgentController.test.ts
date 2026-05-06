import type { ExecutionContext } from '@nestjs/common';

import { ContextService } from '@ci/common/context';

describe('Agent routes', () => {
  const getCapabilities = jest.fn().mockResolvedValue({
    owner: {
      userId: 'owner-user-id',
      selection: 'configured',
    },
    tools: [],
    resources: [],
    graphql: {
      queryCount: 0,
      mutationCount: 0,
      queries: [],
      mutations: [],
    },
  });
  const getUserContext = jest.fn().mockResolvedValue({ context: { currentUser: { name: 'Owner' } } });

  beforeAll(() => {
    process.env.CI_API_SERVICE_KEY = 'test-agent-service-key';
    process.env.CI_OWNER_USER_ID = 'owner-user-id';
  });

  beforeEach(() => {
    getCapabilities.mockClear();
    getUserContext.mockClear();
  });

  async function createHarness() {
    jest.resetModules();

    const [{ AgentController }, { AgentServiceAuthGuard }] = await Promise.all([
      import('../controllers/AgentController'),
      import('../guards/AgentServiceAuthGuard'),
    ]);
    const controllerDependency = {
      getCapabilities,
      getUserContext,
      searchMemory: jest.fn(),
      readEntityGraph: jest.fn(),
      getRecentActivity: jest.fn(),
      getThread: jest.fn(),
      getDocument: jest.fn(),
    } as unknown as ConstructorParameters<typeof AgentController>[0];
    const ownerService = {
      resolveOwner: jest.fn().mockResolvedValue({
        userId: 'owner-user-id',
        selection: 'configured',
      }),
    } as unknown as ConstructorParameters<typeof AgentServiceAuthGuard>[0];
    const loggerService = {
      setContext: jest.fn(),
      warn: jest.fn(),
    } as unknown as ConstructorParameters<typeof AgentServiceAuthGuard>[1];
    const controller = new AgentController(controllerDependency);
    const guard = new AgentServiceAuthGuard(ownerService, loggerService);

    return {
      controller,
      guard,
    };
  }

  function createExecutionContext(serviceKey?: string) {
    const request: {
      headers: Record<string, string | undefined>;
      user?: {
        id: string;
      };
    } = {
      headers: {
        'x-ci-service-key': serviceKey,
      },
    };

    return {
      request,
      executionContext: {
        getType: () => 'http',
        switchToHttp: () => ({
          getRequest: () => request,
        }),
      } as unknown as ExecutionContext,
    };
  }

  it('returns capabilities with a valid service key', async () => {
    const { controller, guard } = await createHarness();
    const { executionContext } = createExecutionContext('test-agent-service-key');

    await ContextService.run({ traceId: 'test-trace-id' }, async () => {
      await expect(guard.canActivate(executionContext)).resolves.toBe(true);
      await expect(controller.getCapabilities()).resolves.toEqual(
        expect.objectContaining({
          owner: expect.objectContaining({
            userId: 'owner-user-id',
          }),
        }),
      );
    });

    expect(getCapabilities).toHaveBeenCalledTimes(1);
  });

  it('rejects requests without a service key', async () => {
    const { guard } = await createHarness();
    const { executionContext } = createExecutionContext();

    await ContextService.run({ traceId: 'test-trace-id' }, async () => {
      await expect(guard.canActivate(executionContext)).rejects.toMatchObject({
        message: 'Invalid service key',
      });
    });
  });

  it('rejects requests with an invalid service key', async () => {
    const { guard } = await createHarness();
    const { executionContext } = createExecutionContext('wrong-key');

    await ContextService.run({ traceId: 'test-trace-id' }, async () => {
      await expect(guard.canActivate(executionContext)).rejects.toMatchObject({
        message: 'Invalid service key',
      });
    });
  });

  it('injects the configured owner into the read service context', async () => {
    const { controller, guard } = await createHarness();
    const { executionContext, request } = createExecutionContext('test-agent-service-key');

    await ContextService.run({ traceId: 'test-trace-id' }, async () => {
      await guard.canActivate(executionContext);
      await controller.getContext({
        traceId: 'test-trace-id',
        userId: request.user?.id,
      } as unknown as Parameters<typeof controller.getContext>[0]);
    });

    expect(request.user).toEqual({
      id: 'owner-user-id',
    });
    expect(getUserContext).toHaveBeenCalledWith({
      userId: 'owner-user-id',
    });
  });

  it('fails closed when the owner is unavailable', async () => {
    const { AgentServiceAuthGuard } = await import('../guards/AgentServiceAuthGuard');
    const ownerService = {
      resolveOwner: jest.fn().mockResolvedValue({
        userId: null,
        selection: 'unavailable',
      }),
    } as unknown as ConstructorParameters<typeof AgentServiceAuthGuard>[0];
    const loggerService = {
      setContext: jest.fn(),
      warn: jest.fn(),
    } as unknown as ConstructorParameters<typeof AgentServiceAuthGuard>[1];
    const guard = new AgentServiceAuthGuard(ownerService, loggerService);
    const { executionContext } = createExecutionContext('test-agent-service-key');

    await ContextService.run({ traceId: 'test-trace-id' }, async () => {
      await expect(guard.canActivate(executionContext)).rejects.toMatchObject({
        message: 'CI_OWNER_USER_ID is not configured',
      });
    });
  });
});

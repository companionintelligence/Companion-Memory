/* eslint-disable @typescript-eslint/no-explicit-any */
import { IntentsRegistrationService } from '../services/IntentsRegistrationService';

function makeLogger() {
  return { setContext: jest.fn(), debug: jest.fn(), error: jest.fn() } as any;
}

describe('IntentsRegistrationService', () => {
  it('registers the intent provider and demotes its superseded tools at boot', async () => {
    const registerProvider = jest.fn().mockResolvedValue(undefined);
    const markSuperseded = jest.fn();
    const toolRegistry = { registerProvider, markSuperseded } as any;
    const provider = { name: 'intents' } as any;
    const intentRegistry = {
      getSupersededToolNames: () => ['databaseSearch', 'getFamilyMembers'],
    } as any;

    const service = new IntentsRegistrationService(toolRegistry, provider, intentRegistry, makeLogger());
    await service.onModuleInit();

    expect(registerProvider).toHaveBeenCalledWith(provider);
    expect(markSuperseded).toHaveBeenCalledWith(['databaseSearch', 'getFamilyMembers']);
  });

  it('propagates a provider-registration failure', async () => {
    const toolRegistry = {
      registerProvider: jest.fn().mockRejectedValue(new Error('boom')),
      markSuperseded: jest.fn(),
    } as any;
    const intentRegistry = { getSupersededToolNames: () => [] } as any;

    const service = new IntentsRegistrationService(
      toolRegistry,
      { name: 'intents' } as any,
      intentRegistry,
      makeLogger(),
    );

    await expect(service.onModuleInit()).rejects.toThrow('boom');
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
import { ToolsRegistrationService } from '../ToolsRegistrationService';

function makeLogger() {
  return { setContext: jest.fn(), debug: jest.fn(), error: jest.fn() } as any;
}

const provider = { name: 'native' } as any;

function schema(name: string, domain: string) {
  return { name, domain };
}

describe('ToolsRegistrationService', () => {
  it('registers the native provider and passes domain validation for real domains', async () => {
    const registerProvider = jest.fn().mockResolvedValue(undefined);
    const registry = {
      registerProvider,
      getAvailableTools: () => [schema('memory.recall', 'memory'), schema('people.find', 'people')],
    } as any;

    const service = new ToolsRegistrationService(registry, provider, makeLogger());
    await service.onModuleInit();

    expect(registerProvider).toHaveBeenCalledWith(provider);
  });

  it('fails fast when a registered tool declares an unknown domain', async () => {
    const registry = {
      registerProvider: jest.fn().mockResolvedValue(undefined),
      getAvailableTools: () => [schema('weird.thing', 'weird')],
    } as any;

    const service = new ToolsRegistrationService(registry, provider, makeLogger());

    await expect(service.onModuleInit()).rejects.toThrow(/unknown domain/);
  });

  it('propagates a provider-registration failure', async () => {
    const registry = {
      registerProvider: jest.fn().mockRejectedValue(new Error('boom')),
      getAvailableTools: () => [],
    } as any;

    const service = new ToolsRegistrationService(registry, provider, makeLogger());

    await expect(service.onModuleInit()).rejects.toThrow('boom');
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
import { ToolsRegistrationService } from '../ToolsRegistrationService';

function makeLogger() {
  return { setContext: jest.fn(), debug: jest.fn(), error: jest.fn() } as any;
}

const provider = { name: 'native' } as any;

const READ = { access: 'read', sensitivity: 'personal', destructive: false, external: false };

function schema(name: string, domain: string, extra: Record<string, unknown> = {}) {
  return { name, domain, privacy: READ, localCapable: true, ...extra };
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

  /**
   * The one local-capability claim the compiler cannot refute. An intent that calls a third-party
   * service cannot also be servable from on-device data, and shipping that contradiction would
   * publish a manifest promising an offline answer that can only fail — on a device, offline,
   * where no operator sees the failure.
   */
  it('fails fast when a tool claims to be localCapable and external at once', async () => {
    const registry = {
      registerProvider: jest.fn().mockResolvedValue(undefined),
      getAvailableTools: () => [
        schema('media.streamingAvailability', 'media', {
          privacy: { ...READ, external: true },
          localCapable: true,
        }),
      ],
    } as any;

    const service = new ToolsRegistrationService(registry, provider, makeLogger());

    await expect(service.onModuleInit()).rejects.toThrow(/localCapable but its privacy label says/);
  });

  it('accepts an external tool that correctly declares itself not local-capable', async () => {
    const registry = {
      registerProvider: jest.fn().mockResolvedValue(undefined),
      getAvailableTools: () => [
        schema('media.streamingAvailability', 'media', {
          privacy: { ...READ, external: true },
          localCapable: false,
        }),
      ],
    } as any;

    const service = new ToolsRegistrationService(registry, provider, makeLogger());

    await expect(service.onModuleInit()).resolves.toBeUndefined();
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

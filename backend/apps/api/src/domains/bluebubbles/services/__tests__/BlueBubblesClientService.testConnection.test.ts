import { BlueBubblesClientService } from '../BlueBubblesClientService';
import type { BlueBubblesConfigService } from '../BlueBubblesConfigService';

/*
 * "Test connection" can name a server other than the saved one. The saved password is the
 * connector owner's credential for their Mac, and any administrator may run this test, so it must
 * never be sent to an address the caller typed: a different address has to come with its own
 * password.
 */

const SAVED = {
  host: 'owners-mac.local',
  port: 1234,
  useHttps: false,
  password: 'owners-password',
};

function serviceWith(saved: typeof SAVED) {
  const configService = { getOrCreate: jest.fn().mockResolvedValue(saved) };

  return new BlueBubblesClientService(configService as unknown as BlueBubblesConfigService);
}

describe('BlueBubblesClientService.testConnection and the saved password', () => {
  it.each([
    ['host', { host: 'someone-elses-server.example' }],
    ['port', { port: 4321 }],
    ['scheme', { useHttps: true }],
  ])('refuses a different %s without a password of its own', async (_label, override) => {
    const result = await serviceWith(SAVED).testConnection({ ...SAVED, password: undefined, ...override });

    expect(result).toEqual({ ok: false, error: 'Enter the password to test a different server address.' });
  });
});

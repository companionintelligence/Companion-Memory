/*
 * The token endpoint answers 503 unless the environment names both POWERSYNC_URL and
 * POWERSYNC_JWT_SECRET. The other PowerSync suites mock the configuration, so none of
 * them would notice if those names stopped reaching it. This one loads the real module
 * under each combination, and checks that a token it issues verifies against the secret
 * the PowerSync service is given.
 */
import { JwtService } from '@nestjs/jwt';

const PS_KEYS = ['POWERSYNC_URL', 'POWERSYNC_JWT_SECRET', 'POWERSYNC_AUDIENCE'] as const;

const LOCAL_URL = 'http://localhost:18080';
const SECRET = 'powersync-config-test-secret';

interface Loaded {
  config: { powersync: { url: string; jwtSecret: string; audience: string } };
  PowerSyncTokenService: new (jwt: JwtService) => {
    isConfigured(): boolean;
    issueToken(userId: string): { token: string; powersync_url: string };
  };
}

/**
 * Loads the real configuration and the service that reads it, fresh, under `env`.
 *
 * A key left out of `env` is set to the empty string rather than deleted: dotenv only
 * fills keys that are absent, so an empty value keeps a developer's root `.env` (which
 * the test script points at) from leaking in and making this test depend on the machine.
 */
function load(env: Partial<Record<(typeof PS_KEYS)[number], string>>): Loaded {
  const saved = Object.fromEntries(PS_KEYS.map((key) => [key, process.env[key]]));

  try {
    for (const key of PS_KEYS) {
      process.env[key] = env[key] ?? '';
    }

    let loaded!: Loaded;

    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const config = require('@ci/configuration').default;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PowerSyncTokenService } = require('../services/PowerSyncTokenService');

      loaded = { config, PowerSyncTokenService };
    });

    return loaded;
  } finally {
    for (const key of PS_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

describe('PowerSync configuration from the environment', () => {
  it('is unconfigured with neither name set', () => {
    const { config, PowerSyncTokenService } = load({ POWERSYNC_AUDIENCE: 'powersync' });

    expect(config.powersync.url).toBe('');
    expect(config.powersync.jwtSecret).toBe('');
    expect(new PowerSyncTokenService(new JwtService({})).isConfigured()).toBe(false);
  });

  it('stays unconfigured with the URL alone, which is what a .env without the secret gives', () => {
    const { config, PowerSyncTokenService } = load({
      POWERSYNC_URL: LOCAL_URL,
      POWERSYNC_AUDIENCE: 'powersync',
    });

    expect(config.powersync.url).toBe(LOCAL_URL);
    expect(config.powersync.jwtSecret).toBe('');
    expect(new PowerSyncTokenService(new JwtService({})).isConfigured()).toBe(false);
  });

  it('stays unconfigured with the secret alone', () => {
    const { PowerSyncTokenService } = load({
      POWERSYNC_JWT_SECRET: SECRET,
      POWERSYNC_AUDIENCE: 'powersync',
    });

    expect(new PowerSyncTokenService(new JwtService({})).isConfigured()).toBe(false);
  });

  it('is configured with both, and issues a token the same secret and audience verify', () => {
    const { config, PowerSyncTokenService } = load({
      POWERSYNC_URL: LOCAL_URL,
      POWERSYNC_JWT_SECRET: SECRET,
      POWERSYNC_AUDIENCE: 'powersync',
    });
    const service = new PowerSyncTokenService(new JwtService({}));

    expect(service.isConfigured()).toBe(true);
    expect(config.powersync.audience).toBe('powersync');

    const { token, powersync_url } = service.issueToken('user-1');

    expect(powersync_url).toBe(LOCAL_URL);
    expect(new JwtService({}).verify(token, { secret: SECRET, audience: 'powersync' })).toMatchObject({
      sub: 'user-1',
    });
  });
});

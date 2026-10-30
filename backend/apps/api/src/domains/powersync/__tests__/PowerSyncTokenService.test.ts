const mockPowersync = {
  url: '',
  jwtSecret: '',
  audience: 'powersync',
  tokenTtl: '300s',
  jwtKid: 'ci-powersync-hs256',
};

jest.mock('@ci/configuration', () => {
  const actual = jest.requireActual('@ci/configuration').default;

  return {
    __esModule: true,
    default: {
      ...actual,
      get powersync() {
        return mockPowersync;
      },
    },
  };
});

import { ServiceUnavailableException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { POWERSYNC_NOT_CONFIGURED_BODY, PowerSyncTokenService } from '../services/PowerSyncTokenService';

interface DecodedToken {
  header: { kid?: string; alg?: string };
  payload: { sub?: string; aud?: string; parameters?: { cutoff?: string } };
}

describe('PowerSyncTokenService', () => {
  let service: PowerSyncTokenService;

  beforeEach(() => {
    service = new PowerSyncTokenService(new JwtService({}));
    Object.assign(mockPowersync, {
      url: '',
      jwtSecret: '',
      audience: 'powersync',
      tokenTtl: '300s',
      jwtKid: 'ci-powersync-hs256',
    });
  });

  it('is configured only when both the URL and the JWT secret are set', () => {
    expect(service.isConfigured()).toBe(false);

    mockPowersync.url = 'https://ps.test';
    expect(service.isConfigured()).toBe(false);

    mockPowersync.url = '';
    mockPowersync.jwtSecret = 'shh-secret';
    expect(service.isConfigured()).toBe(false);

    mockPowersync.url = 'https://ps.test';
    expect(service.isConfigured()).toBe(true);
  });

  it('throws 503 when PowerSync is not configured', () => {
    expect(() => service.issueToken('user-1')).toThrow(ServiceUnavailableException);
  });

  it('throws the same body the controller answers with, code included', () => {
    let thrown: unknown;

    try {
      service.issueToken('user-1');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ServiceUnavailableException);
    expect((thrown as ServiceUnavailableException).getResponse()).toEqual(POWERSYNC_NOT_CONFIGURED_BODY);
    expect((thrown as ServiceUnavailableException).message).toBe('PowerSync is not configured');
  });

  it('issues a token scoped to the user (sub, aud, kid) when configured', () => {
    mockPowersync.url = 'https://ps.test';
    mockPowersync.jwtSecret = 'shh-secret';

    const { token, powersync_url } = service.issueToken('user-1');

    expect(powersync_url).toBe('https://ps.test');

    const decoded = new JwtService({}).decode(token, { complete: true }) as unknown as DecodedToken;

    expect(decoded.payload.sub).toBe('user-1');
    expect(decoded.payload.aud).toBe('powersync');
    expect(decoded.header.kid).toBe('ci-powersync-hs256');
    expect(decoded.header.alg).toBe('HS256');
    expect(decoded.payload.parameters?.cutoff).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('embeds a client-supplied cutoff in JWT parameters', () => {
    mockPowersync.url = 'https://ps.test';
    mockPowersync.jwtSecret = 'shh-secret';

    const { token } = service.issueToken('user-1', '2026-01-01T00:00:00.000Z');
    const decoded = new JwtService({}).decode(token, { complete: true }) as unknown as DecodedToken;

    expect(decoded.payload.parameters?.cutoff).toBe('2026-01-01T00:00:00.000Z');
  });
});

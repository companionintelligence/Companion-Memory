import { JwtService } from '@nestjs/jwt';
import { SignJWT } from 'jose';

import config from '@ci/configuration';

import {
  DEVICE_ACCESS_TOKEN_PURPOSE,
  DEVICE_ACCESS_TOKEN_TTL_SECONDS,
  looksLikeDeviceAccessToken,
  mintDeviceAccessToken,
  verifyDeviceAccessToken,
} from '../utils/deviceAccessToken';

/**
 * The short-lived token the phone and desktop apps' web page holds instead of the device key.
 * What has to hold: it round-trips to exactly the key it was minted for, it stops at its expiry,
 * an altered or foreign token is refused, and it is never a session.
 */
describe('device access tokens', () => {
  const KEY = { keyId: '019a0000-0000-7000-8000-000000000001', userId: 'owner-1' };

  it('stands for the key it was minted for, until its expiry', async () => {
    const now = Date.now();
    const { token, expiresAtMs } = await mintDeviceAccessToken(KEY, now);

    expect(looksLikeDeviceAccessToken(token)).toBe(true);
    expect(expiresAtMs).toBe((Math.floor(now / 1000) + DEVICE_ACCESS_TOKEN_TTL_SECONDS) * 1000);
    await expect(verifyDeviceAccessToken(token)).resolves.toEqual({ ...KEY, expiresAtMs });
  });

  it('is refused once it has expired', async () => {
    const { token } = await mintDeviceAccessToken(
      KEY,
      Date.now() - (DEVICE_ACCESS_TOKEN_TTL_SECONDS + 5) * 1000,
    );

    await expect(verifyDeviceAccessToken(token)).resolves.toBeNull();
  });

  it('is refused when any part of it was changed', async () => {
    const { token } = await mintDeviceAccessToken(KEY);
    const [header, , signature] = token.split('.');
    const otherKey = Buffer.from(
      JSON.stringify({
        purpose: DEVICE_ACCESS_TOKEN_PURPOSE,
        akid: '019a0000-0000-7000-8000-000000000002',
        sub: 'owner-1',
      }),
    ).toString('base64url');

    await expect(verifyDeviceAccessToken(`${header}.${otherKey}.${signature}`)).resolves.toBeNull();
    await expect(verifyDeviceAccessToken(`${token.slice(0, -2)}xx`)).resolves.toBeNull();
  });

  it('is never a session: the session secret does not verify it', async () => {
    const { token } = await mintDeviceAccessToken(KEY);

    // What `JwtStrategy` (passport-jwt) does with a bearer: verify against the session secret.
    expect(() => new JwtService({}).verify(token, { secret: config.auth.jwt.authTokenSecret })).toThrow();
  });

  it('refuses a token signed with the session secret, even with every claim right', async () => {
    const secret = new TextEncoder().encode(config.auth.jwt.authTokenSecret);
    const forged = await new SignJWT({ purpose: DEVICE_ACCESS_TOKEN_PURPOSE, akid: KEY.keyId })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('ci-server')
      .setAudience('ci-server:device-access')
      .setSubject(KEY.userId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(secret);

    await expect(verifyDeviceAccessToken(forged)).resolves.toBeNull();
  });

  it('refuses a session JWT and a raw key', async () => {
    const session = new JwtService({}).sign({ sub: 'owner-1' }, { secret: config.auth.jwt.authTokenSecret });

    await expect(verifyDeviceAccessToken(session)).resolves.toBeNull();
    expect(looksLikeDeviceAccessToken('a'.repeat(64))).toBe(false);
    await expect(verifyDeviceAccessToken('a'.repeat(64))).resolves.toBeNull();
  });

  it('refuses a key id that is not one Memory mints, before any lookup could see it', async () => {
    const { token } = await mintDeviceAccessToken({ keyId: "x' OR 1=1", userId: 'owner-1' });

    await expect(verifyDeviceAccessToken(token)).resolves.toBeNull();
  });
});

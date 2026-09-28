import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import config from '@ci/configuration';

import { PYTHON_RUN_TOKEN_PURPOSE, PythonFunctionTokenService } from '../services/PythonFunctionTokenService';

/**
 * The per-run credential that replaced the sidecars' copy of AUTH_TOKEN_SECRET.
 * Signed with that same secret so JwtStrategy accepts it as the run's user
 * (the sidecar's GraphQL calls need that), but it names one job, and only the
 * callback guard treats it as proof of anything.
 */
describe('PythonFunctionTokenService', () => {
  const jwt = new JwtService();
  const service = new PythonFunctionTokenService(jwt);
  const claims = { userId: 'user-1', jobId: 'job-1', queue: 'py-fn-hbpe' };

  it('round-trips the run claims, with the user as the JWT subject', () => {
    const token = service.issueRunToken(claims);

    expect(service.verifyCallbackToken(token)).toEqual(claims);
    // What JwtStrategy will read: an ordinary access token for this user.
    const decoded = jwt.decode(token) as Record<string, unknown>;
    expect(decoded.sub).toBe('user-1');
    expect(decoded.purpose).toBe(PYTHON_RUN_TOKEN_PURPOSE);
  });

  it('outlives the job timeout by a margin, and no more', () => {
    const decoded = jwt.decode(service.issueRunToken(claims)) as { iat: number; exp: number };
    const ttl = decoded.exp - decoded.iat;

    expect(ttl).toBeGreaterThan(config.queues.jobTimeoutSeconds);
    expect(ttl).toBeLessThanOrEqual(config.queues.jobTimeoutSeconds + 15 * 60);
  });

  it('refuses an ordinary access token as a callback credential (no run purpose)', () => {
    const accessToken = jwt.sign({ sub: 'user-1' }, { secret: config.auth.jwt.authTokenSecret });

    expect(() => service.verifyCallbackToken(accessToken)).toThrow(UnauthorizedException);
  });

  it('refuses a token signed with any other secret, and garbage', () => {
    const forged = jwt.sign(
      { sub: 'user-1', purpose: PYTHON_RUN_TOKEN_PURPOSE, jobId: 'job-1', queue: 'py-fn-hbpe' },
      { secret: 'not-the-secret' },
    );

    expect(() => service.verifyCallbackToken(forged)).toThrow(UnauthorizedException);
    expect(() => service.verifyCallbackToken('nope')).toThrow(UnauthorizedException);
  });
});

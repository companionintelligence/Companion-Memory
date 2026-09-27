import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import config from '@ci/configuration';

import { PYTHON_RUN_TOKEN_PURPOSE, PythonFunctionTokenService } from '../services/PythonFunctionTokenService';
import { PYTHON_FUNCTION_QUEUE_OPTIONS, PYTHON_FUNCTION_QUEUES, PYTHON_FUNCTION_TARGETS } from '../types';

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

  const ttlFor = (queue: string): number => {
    const decoded = jwt.decode(service.issueRunToken({ ...claims, queue })) as { iat: number; exp: number };

    return decoded.exp - decoded.iat;
  };

  // A deferred run is bounded by its queue's pg-boss expiry, not by the global
  // jobTimeoutSeconds: a token that dies first turns a healthy long run's
  // callback into a 401, and pg-boss then re-runs the whole function at expiry.
  it.each(PYTHON_FUNCTION_TARGETS)(
    "outlives the %s queue's own expiry by a margin, and no more",
    (target) => {
      const { expireInSeconds } = PYTHON_FUNCTION_QUEUE_OPTIONS[target];
      const ttl = ttlFor(PYTHON_FUNCTION_QUEUES[target]);

      expect(ttl).toBeGreaterThan(expireInSeconds);
      expect(ttl).toBeLessThanOrEqual(expireInSeconds + 15 * 60);
    },
  );

  it('covers a backlogged HBPE nightly, which runs far past the global job timeout', () => {
    const ttl = ttlFor('py-fn-hbpe');

    // 4 h labeling budget + the longest measured post-label tail (see types.ts).
    expect(ttl).toBeGreaterThan(4 * 60 * 60 + 12_820);
    expect(ttl).toBeGreaterThan(config.queues.jobTimeoutSeconds + 15 * 60);
  });

  it('refuses to mint for a queue it cannot size', () => {
    expect(() => service.issueRunToken({ ...claims, queue: 'py-fn-nope' })).toThrow(/py-fn-nope/);
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

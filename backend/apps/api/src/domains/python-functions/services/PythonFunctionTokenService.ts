import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import config from '@ci/configuration';

import { PYTHON_FUNCTION_QUEUE_OPTIONS, PYTHON_FUNCTION_QUEUES, PYTHON_FUNCTION_TARGETS } from '../types';

/** Distinguishes a run token from every other JWT this secret signs. */
export const PYTHON_RUN_TOKEN_PURPOSE = 'python_run' as const;

/** Headroom past the queue's pg-boss expiry so a run that finishes at the wire can still report. */
const RUN_TOKEN_GRACE_SECONDS = 15 * 60;

export interface PythonRunClaims {
  userId: string;
  jobId: string;
  queue: string;
}

/**
 * The longest a run on `queue` can still legitimately report: that queue's own
 * pg-boss `expireInSeconds`. A dispatched job is deferred, so nothing else bounds
 * it — not `queues.jobTimeoutSeconds` (2 h), which is only the in-process
 * fallback for queues that declare no expiry. py-fn-hbpe declares 8 h because a
 * backlogged nightly measurably runs past 3 h; a token sized to the global 2 h
 * expired under that healthy run, its callback bounced 401, and pg-boss re-ran
 * the whole pipeline at expiry.
 *
 * The token is minted only once the job is already active — pg-boss's expiry
 * clock is running before the token's starts — so it always outlives the job.
 */
function runWindowSeconds(queue: string): number {
  const target = PYTHON_FUNCTION_TARGETS.find((candidate) => PYTHON_FUNCTION_QUEUES[candidate] === queue);

  if (!target) {
    throw new Error(`Not a python-function queue: ${queue}`);
  }

  return PYTHON_FUNCTION_QUEUE_OPTIONS[target].expireInSeconds;
}

/**
 * The credential a Python sidecar holds for one function run.
 *
 * The sidecars used to hold AUTH_TOKEN_SECRET itself and mint a user token for
 * whatever `user_id` a run request named — so a compromised sidecar (the
 * document parser chews on untrusted files all day) could act as any user
 * against the whole API. Now the dispatcher mints one token per run: a real
 * access token, signed with the same secret `JwtStrategy` verifies, scoped by
 * claims to that job's user, job id and queue, and expiring shortly after its
 * queue would have expired the job. The sidecar echoes it on its GraphQL calls
 * and on the completion callback, and holds nothing that can mint another.
 *
 * `verifyCallbackToken` is what the callback route trusts instead of a user
 * login: it proves the caller was handed THIS job, so it can complete or fail
 * this job and no other.
 */
@Injectable()
export class PythonFunctionTokenService {
  constructor(private readonly jwtService: JwtService) {}

  issueRunToken(claims: PythonRunClaims): string {
    return this.jwtService.sign(
      { purpose: PYTHON_RUN_TOKEN_PURPOSE, jobId: claims.jobId, queue: claims.queue },
      {
        secret: config.auth.jwt.authTokenSecret,
        subject: claims.userId,
        expiresIn: runWindowSeconds(claims.queue) + RUN_TOKEN_GRACE_SECONDS,
      },
    );
  }

  verifyCallbackToken(token: string): PythonRunClaims {
    let payload: { sub?: unknown; purpose?: unknown; jobId?: unknown; queue?: unknown };

    try {
      payload = this.jwtService.verify(token, { secret: config.auth.jwt.authTokenSecret });
    } catch {
      throw new UnauthorizedException('Invalid or expired run token');
    }

    if (
      payload.purpose !== PYTHON_RUN_TOKEN_PURPOSE ||
      typeof payload.sub !== 'string' ||
      typeof payload.jobId !== 'string' ||
      typeof payload.queue !== 'string'
    ) {
      throw new UnauthorizedException('Not a run token');
    }

    return { userId: payload.sub, jobId: payload.jobId, queue: payload.queue };
  }
}

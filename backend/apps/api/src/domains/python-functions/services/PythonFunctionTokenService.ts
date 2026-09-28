import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import config from '@ci/configuration';

/** Distinguishes a run token from every other JWT this secret signs. */
export const PYTHON_RUN_TOKEN_PURPOSE = 'python_run' as const;

/** Headroom past the queue's job timeout so a run that finishes late can still report. */
const RUN_TOKEN_GRACE_SECONDS = 15 * 60;

export interface PythonRunClaims {
  userId: string;
  jobId: string;
  queue: string;
}

/**
 * The credential a Python sidecar holds for one function run.
 *
 * The sidecars used to hold AUTH_TOKEN_SECRET itself and mint a user token for
 * whatever `user_id` a run request named — so a compromised sidecar (the
 * document parser chews on untrusted files all day) could act as any user
 * against the whole API. Now the dispatcher mints one token per run: a real
 * access token, signed with the same secret `JwtStrategy` verifies, scoped by
 * claims to that job's user, job id and queue, and expiring shortly after the
 * job would have timed out. The sidecar echoes it on its GraphQL calls and on
 * the completion callback, and holds nothing that can mint another.
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
        expiresIn: config.queues.jobTimeoutSeconds + RUN_TOKEN_GRACE_SECONDS,
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

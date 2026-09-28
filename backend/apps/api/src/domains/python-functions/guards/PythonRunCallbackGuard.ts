import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import { extractBearerToken } from '@ci/common/guards/bearerToken';

import { type PythonRunClaims, PythonFunctionTokenService } from '../services/PythonFunctionTokenService';

export interface PythonRunCallbackRequest extends Request {
  pythonRun?: PythonRunClaims;
}

/**
 * Admits the completion callback for exactly the run whose token it carries.
 *
 * This route used to sit behind the ordinary auth guard, which meant ANY
 * authenticated principal — a household member's read-only key included —
 * could complete or fail any job id in either queue. A run token is not a user
 * login: it names one job, and the controller refuses a body that names a
 * different one.
 */
@Injectable()
export class PythonRunCallbackGuard implements CanActivate {
  constructor(private readonly tokens: PythonFunctionTokenService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<PythonRunCallbackRequest>();
    const token = extractBearerToken(request.headers.authorization);

    if (!token) {
      throw new UnauthorizedException('Run token required');
    }

    request.pythonRun = this.tokens.verifyCallbackToken(token);

    return true;
  }
}

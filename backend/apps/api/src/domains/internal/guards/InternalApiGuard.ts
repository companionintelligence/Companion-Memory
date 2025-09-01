import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';

import config from '@ci/configuration';

@Injectable()
export class InternalApiGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const internalSecret = request.headers['x-internal-secret'];

    if (!internalSecret || internalSecret !== config.internalSecret) {
      throw new UnauthorizedException('Invalid internal API secret');
    }

    return true;
  }
}

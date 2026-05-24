import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';

import config from '@ci/configuration';

import { CsrfService } from '../services/CsrfService';

const CSRF_COOKIE_NAME = config.auth.cookies.csrfTokenName;
const CSRF_HEADER_NAME = 'x-csrf-token';

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly csrfService: CsrfService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();

    this.csrfService.validateToken(
      req.cookies?.[CSRF_COOKIE_NAME],
      req.headers[CSRF_HEADER_NAME] as string | undefined,
    );

    return true;
  }
}

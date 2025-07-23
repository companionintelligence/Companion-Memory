import type { ExecutionContext } from '@nestjs/common';
import { createParamDecorator } from '@nestjs/common';

import type { RequestWithContext } from '../types';

export const Context = createParamDecorator((data: unknown, ctx: ExecutionContext) => {
  const request: RequestWithContext = ctx.switchToHttp().getRequest();

  return request.context;
});

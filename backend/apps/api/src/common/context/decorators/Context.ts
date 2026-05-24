import { createParamDecorator, InternalServerErrorException } from '@nestjs/common';

import { ContextService } from '../services/ContextService';
import type { RequestContext } from '../types';

export const Context = createParamDecorator((): RequestContext => {
  const context = ContextService.getContext();

  if (context == null) {
    throw new InternalServerErrorException('Request context not found');
  }

  return context;
});

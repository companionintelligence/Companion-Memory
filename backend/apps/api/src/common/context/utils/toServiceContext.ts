import { UnauthorizedException } from '@nestjs/common';

import type { RequestContext, UserServiceContext } from '../types';

const serviceContextCache = new WeakMap<RequestContext, UserServiceContext>();

/**
 * Converts a RequestContext to a ServiceContext. Throws UnauthorizedException
 * if userId is not present.
 *
 * @param context The RequestContext from the current request
 * @returns ServiceContext with guaranteed userId
 * @throws UnauthorizedException if userId is missing
 */
export function toServiceContext(context: RequestContext): UserServiceContext {
  const cached = serviceContextCache.get(context);

  if (cached) {
    return cached;
  }

  if (!context.userId) {
    throw new UnauthorizedException('User authentication required');
  }

  const serviceContext: UserServiceContext = {
    userId: context.userId,
  };

  serviceContextCache.set(context, serviceContext);

  return serviceContext;
}

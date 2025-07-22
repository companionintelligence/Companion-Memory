import type { Request as ExpressRequest } from 'express';

export interface RequestContext {
  requestId?: string;
  userId?: string;
  query?: Record<string, unknown>;
}

export interface RequestWithContext extends ExpressRequest {
  context?: RequestContext;
}

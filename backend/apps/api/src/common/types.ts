export interface RequestContext {
  traceId?: string;
  userId?: string;
}

export interface ServiceContext {
  userId: string;
}

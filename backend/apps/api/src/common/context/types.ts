/**
 * Symbol representing system-level operations (not associated with a specific
 * user). Use this when performing automated tasks, migrations, or system
 * maintenance.
 */
export const SYSTEM_USER = Symbol('SYSTEM_USER');

/**
 * Represents contextual information for a request, such as tracing and user
 * identification.
 */
export interface RequestContext {
  /**
   * Identifier used for tracing requests across services.
   */
  traceId?: string;

  /**
   * Identifier for the authenticated user making the request.
   */
  userId?: string;
}

/**
 * Represents the context for a service operation.
 */
export interface ServiceContext {
  /**
   * The unique identifier of the user performing the operation, or the special
   * value `SYSTEM_USER` for system-initiated actions.
   */
  userId: string | typeof SYSTEM_USER;
}

/**
 * Represents the context for a user-constrainted service operation.
 */
export interface UserServiceContext {
  /**
   * The unique identifier of the user performing the operation.
   */
  userId: string;
}

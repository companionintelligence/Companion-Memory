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

  /**
   * Identifier for the acting principal (see plan 10): the user, agent, or
   * device that initiated the request. For session JWT (the human owner)
   * this equals `userId`. For an API-key request issued to an agent, it
   * is the agent's actor id.
   *
   * Optional during the migration window — services may fall back to
   * `userId` when this is unset.
   */
  actorId?: string;

  /**
   * Kind of the actor (`user`, `agent`, `device`, `household`). Useful for
   * audit and policy decisions without requiring a join.
   */
  actorKind?: 'user' | 'agent' | 'device' | 'household';
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

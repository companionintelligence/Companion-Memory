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
   * `ci.api_keys.id` of the key that authenticated this request, when one did. Absent for a
   * session/JWT caller and for in-process work.
   *
   * WHICH key, not just which user: on a single-owner appliance every agent key resolves to the
   * same account, so `userId` alone cannot say whether a call came from the chat agent, the bulk
   * importer, or a connected MCP client. Stamped by `ApiKeyStrategy.validate` rather than by
   * `RequestContextMiddleware` — the middleware runs before the guards, so at the point it opens
   * the async-local store nothing has authenticated yet and there is no key to name.
   */
  apiKeyId?: string;
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
  /**
   * Set ONLY by the importer's PushStage: the ci_import.import_runs id whose
   * push this write belongs to. The memory services thread it into
   * ci.record_sources so an import run's arrivals are attributable (and an
   * undo-a-run flow can key on it) — docs/design/cross-pipeline-identity.md §5.
   * Absent everywhere else; never used for authorization.
   */
  importRunId?: string;
}

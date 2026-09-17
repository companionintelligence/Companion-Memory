/**
 * The request facts a tool call carries, independent of how the request arrived.
 *
 * A mirror of `RequestContext` in the API's `common/context` — kept here, rather than imported
 * from there, so that this package stays free of the API tree entirely and a CLI or sidecar
 * frontend can build one without pulling in Nest middleware. The two are held identical by a
 * compile-time assertion on the API side (`domains/tools/toolCoreContract.ts`).
 *
 * Every field is optional because every field genuinely can be absent: an in-process background
 * job has no api key, an unauthenticated probe has no user, and a call made outside a request has
 * no trace.
 */
export interface ToolRequestContext {
  /** Joins this call's ledger row to the request's log lines. */
  traceId?: string;

  /** The authenticated user the call is made on behalf of. */
  userId?: string;

  /**
   * `ci.api_keys.id` of the key that authenticated the request, when one did.
   *
   * WHICH key, not merely which user: on a single-owner appliance every agent key resolves to the
   * same account, so `userId` alone cannot say whether a call came from the chat agent, the bulk
   * importer, or a connected MCP client.
   */
  apiKeyId?: string;
}

# MCP Servers

## `ci-mcp`

`ci-mcp` is the external, read-only MCP surface for CI-Server. It is designed for agents running outside the main API process, such as Hub-managed agents that are granted network access to the CI stack.

### Connection

- Internal URL on the CI network: `http://mcp:3091/mcp`
- Auth: `Authorization: Bearer <CI_MCP_AUTH_TOKEN>`
- Health: `GET http://mcp:3091/healthz`

`ci-mcp` joins the private `ci` Docker network managed by this repository:

- `ci`: private CI-Server service network

If Hub needs to reach `ci-mcp` from a separate stack, that cross-stack attachment should be managed from the `ci-os-hub` side by connecting the running `ci-mcp` container or service to `ci-os-hub_network`. CI-Server does not create or own that shared network.

### Discovery

The server is registered explicitly by the host platform. Clients should discover the surface through MCP itself after connecting:

- `tools/list`
- `resources/list`
- `prompts/list`

The capability overview resource is:

- `ci://capabilities/overview`

### Tools

- `search_memory`: Search indexed personal memory with bounded results
- `read_entity_graph`: Read a bounded subgraph around one or more entities
- `get_user_context`: Get the owner context snapshot and dossier
- `get_recent_activity`: Get recent summaries, actions, and timeline items
- `get_thread`: Read one conversation thread with recent messages
- `get_document`: Read file metadata and inline text when directly available

### Resources

- `ci://capabilities/overview`
- `ci://user/context`
- `ci://schema/graphql-summary`
- `ci://entities/{entityId}`
- `ci://threads/{threadId}`

### Prompt

- `ci_memory_usage`: Best-practice guidance for using the CI memory surface

### Upstream API

`ci-mcp` calls the backend service-auth API:

- `GET /agent/v1/capabilities`
- `GET /agent/v1/context`
- `POST /agent/v1/search`
- `POST /agent/v1/graph/read`
- `POST /agent/v1/activity/recent`
- `GET /agent/v1/threads/:id`
- `GET /agent/v1/documents/:id`

Requests are authenticated with `X-CI-Service-Key: <CI_API_SERVICE_KEY>`.

### Owner Resolution

The external agent surface runs as a single CI-Server user.

- Preferred: set `CI_OWNER_USER_ID`
- Fallback: the API resolves the first onboarded user automatically

This fallback exists because the current Hub packaging path does not yet provide a clean per-install owner-id input.

### Hub Registration Example

```json
{
  "name": "ci-mcp",
  "transport": {
    "type": "http",
    "url": "http://mcp:3091/mcp",
    "headers": {
      "Authorization": "Bearer ${CI_MCP_AUTH_TOKEN}"
    }
  }
}
```

### Hub Network Note

Hub-side networking is intentionally out of scope for this repository. The expected deployment model is:

- CI-Server starts `ci-mcp` on its normal `ci` network
- `ci-os-hub` attaches `ci-mcp` to `ci-os-hub_network`
- Hub-managed agent containers join `ci-os-hub_network`

Once that attachment exists, Hub can register `ci-mcp` at the URL that is resolvable from the Hub side, for example `http://mcp:3091/mcp` if the service name is preserved on the shared network.

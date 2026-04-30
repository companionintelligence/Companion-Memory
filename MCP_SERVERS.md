# MCP Servers

## `ci-mcp`

`ci-mcp` is the external, read-only MCP surface for CI-Server. It is designed for agents running outside the main API process, such as Hub-managed agents on the same Docker network.

### Connection

- Internal URL: `http://mcp:3091/mcp` in the local/staging/prod compose stacks
- Auth: `Authorization: Bearer <CI_MCP_AUTH_TOKEN>`
- Health: `GET http://mcp:3091/healthz`

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

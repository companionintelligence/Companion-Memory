# MCP on the appliance

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

CI-Server sits on **both** sides of the Model Context Protocol, and the two sides
are separate domains that happen to share a name:

| | Direction | Domain | Route prefix |
|---|---|---|---|
| **Server** | an agent connects **in** and calls the appliance's tools | `backend/apps/api/src/domains/mcp/` | bare `POST`/`GET`/`DELETE` on `/mcp` |
| **Client** | the appliance connects **out** to servers the owner configured | `backend/apps/api/src/domains/mcp-client/` | `mcp/servers`, `mcp/catalog`, `mcp/test-connection` |

They share one `@Controller('mcp')` path namespace and were deliberately kept
from colliding: `McpController` owns exactly the three bare verbs on `/mcp`
itself, and every client-side route is a sub-path
(`McpServerConfigController.ts:81-91`).

## The documents

- **[server.md](server.md)** — the appliance as an MCP server. Endpoint, auth,
  minting a scoped key, the session lifecycle and its authority signature, what
  is in the tool surface, and the resources.
- **[clients.md](clients.md)** — connect recipes for Claude Code, Claude Desktop
  and Cursor, plus the streamable-HTTP-only caveat and the pending stdio bridge.
- **[external-servers.md](external-servers.md)** — connecting the appliance out
  to third-party MCP servers: the config row, secret storage, the tool-approval
  gate, the schema digest, and the suggested catalog.

Related reference that predates this directory and is still accurate:
[`docs/api/auth-and-conventions.md` §5](../api/auth-and-conventions.md#5-mcp-surface)
covers the server surface inside the wider API reference, with the same
file:line citation convention. This directory is the fuller treatment and the
only place the client side is documented at all.

---

## Where the two sides meet

Neither domain owns the tools. Both go through **`ToolRegistry`**
(`backend/apps/api/src/domains/tools/registry/ToolRegistry.ts`), the
process-global registry that holds every tool from every provider, keyed by its
executable name (dotted intent id with dots turned into underscores —
`memory.recall` is registered and called as `memory_recall`).

```
              ToolRegistry
                    |
     +--------------+--------------+
     |                             |
NativeToolProvider          McpToolProvider
(domains/tools)             (domains/mcp-client)
 curated intents            tools discovered from the
 declared in-repo           owner's external servers
     |                             |
     +--------------+--------------+
                    |
     +--------------+--------------------------+
     |                                          |
McpToolService (domains/mcp)              the chat assistant
 outbound MCP server surface               (in-house dispatcher)
```

Three properties of that meeting point are worth holding on to, because they are
what stop the two directions from becoming one loop:

**1. Outbound is a narrower list than inbound.** `McpToolService` builds its
native half from `ToolRegistry.getOutboundCatalogTools()`
(`McpToolService.ts:272`), not from the full agent-facing list. That method drops
every tool whose provider set `includeInOutboundCatalog = false`
(`ToolRegistry.ts:241-262`) — today exactly one provider does, `McpToolProvider`
(`McpToolProvider.ts:50`). So a tool the appliance discovered on *your* Notion
server is usable by *your* chat assistant and is never republished on the
appliance's own MCP surface. Without that, an agent connecting in could reach
back out through the appliance to a third-party server it was never given
credentials for.

**2. Authorization lives in the registry, not in the transport.**
`capabilityAllows` (`domains/tools/policy/capabilityPolicy.ts:45`) decides
whether a principal at a given capability may run a tool with a given privacy
label, and `ToolRegistry.executeTool` calls it on every execution regardless of
who dispatched. `McpToolService` keeps a pre-check so it can return a specific
403 message (`McpToolService.ts:139-145`), not because it is the only thing
standing there. A future dispatcher cannot skip the rule by not knowing about it.

**3. Ownership is a field on the tool, not a filter in one caller.** A tool
sourced from a user's external server carries `ownerUserId`
(`McpToolProvider.ts:142`), and the registry filters on it per request
(`ToolRegistry.isVisibleTo`, `:215-217`). The registry is process-global and the
MCP-client connection sweep runs outside any request, so there is no user to
filter by at load time; stamping the owner onto the intent is what keeps one
account's configured servers off another account's tool list on a multi-user box.

## Quick orientation by file

Server side (`domains/mcp/`):

| File | What it is |
|---|---|
| `controllers/McpController.ts` | The three HTTP verbs, session map, authority signature, idle reaper |
| `services/McpServerService.ts` | Builds one `McpServer` per session; registers tools and resources |
| `services/McpToolService.ts` | Consolidates GraphQL-derived + native tools; per-caller filtering and the enforcement point |
| `services/GraphQLToolAdapter.ts` | Derives one tool per GraphQL root field and synthesizes its privacy label |
| `services/McpExecutorService.ts` | Builds and runs the GraphQL document for a GraphQL-derived tool call |

Client side (`domains/mcp-client/`):

| File | What it is |
|---|---|
| `entities/McpServerConfigEntity.ts` | One row per configured server; the egress masking |
| `services/McpClientManagerService.ts` | Owns every live connection, the boot sweep, reconnect backoff, `tools/call` routing |
| `services/McpServerConfigService.ts` | CRUD, transport validation, the high-risk re-check, the approval merge |
| `services/McpSecretCodec.ts` | Per-field AES-256-GCM for `env` / `auth` |
| `services/mcpToolDigest.ts` | The pinning primitive: canonicalise, digest, diff |
| `providers/McpToolProvider.ts` | Wraps approved discovered tools as registry tools |
| `catalog/mcpSuggestedCatalog.ts` | The curated suggestion list and the high-risk slug set |

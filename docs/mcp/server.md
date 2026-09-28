# The appliance as an MCP server

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

CI-Server exposes its own tools over the Model Context Protocol so an agent gets
one memory-brain endpoint instead of a hand-written integration per harness.
Everything here is `backend/apps/api/src/domains/mcp/`; citations are
`path:line` against that directory unless stated otherwise.

For the client recipes, see [clients.md](clients.md). For the appliance
connecting *out* to someone else's server, see
[external-servers.md](external-servers.md) — a different domain entirely.

---

## Endpoint

**Bare `/mcp`**, three verbs, one controller: `@Controller('mcp')`
(`controllers/McpController.ts:84`).

| Verb | Purpose |
|---|---|
| `POST /mcp` | Every JSON-RPC message. An `initialize` body with no session header creates a transport and mints a session id; everything after must carry `Mcp-Session-Id` (`:106-163`) |
| `GET /mcp` | Opens the SSE stream for server→client notifications; requires `Mcp-Session-Id` (`:169-184`) |
| `DELETE /mcp` | Terminates the session and closes the transport (`:189-207`) |

Transport is `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk`
(`:1`, `:118-120`). Server identity is name `companion-memory`, version `0.1.0`
(`services/McpServerService.ts:23-24`).

**The route is `/mcp`, not `/api/mcp`.** There is no `setGlobalPrefix` on this
server, so controllers mount at their bare decorator paths. The `/api` segment
every browser and every external client uses is stripped by the edge before the
request reaches Nest — Caddy in the dev stack
(`scripts/dev-stack/index.ts:257`, which routes `/api/mcp` and `/api/mcp/`
through a proxy with immediate flushing so the SSE stream is not buffered), and
nginx in production. So:

- from outside the appliance, connect to `https://<appliance>/api/mcp`;
- from inside the container network or a direct port hit, it is `/mcp` on
  `config.host:config.port` (default `0.0.0.0:3030`).

Point clients at the `/api/mcp` form. It is the one that works through every
deployment.

---

## Auth

Three decorators on the controller class, applied to all three verbs
(`McpController.ts:84-90`):

```
@Controller('mcp')
@UseGuards(JwtOrApiKeyAuthGuard)
@RequireScopes(MCP_SCOPE)
@RequireCapability(READ_CAPABILITY)
```

`MCP_SCOPE` is the string `mcp`
(`backend/apps/api/src/common/decorators/RequireScopes.ts:28`);
`READ_CAPABILITY` is `read`
(`backend/apps/api/src/common/decorators/ApiKeyCapability.ts:23`).

### Accepted credentials

`JwtOrApiKeyAuthGuard` chains three things
(`backend/apps/api/src/common/guards/JwtOrApiKeyAuthGuard.ts:27-62`):

1. a **Portal OIDC bearer**, when `auth.portal.enabled` (it is on by default);
2. a **session access-token JWT** as `Authorization: Bearer <jwt>`;
3. an **API key**, read from `x-api-key` or, failing that, from
   `Authorization: Bearer <key>`
   (`backend/apps/api/src/domains/auth/services/ApiKeyStrategy.ts:13,33-41`).

The bearer form for API keys exists specifically because most MCP clients expose
a single token field and cannot send a custom header. `x-api-key` wins when both
are present — unless it is blank, in which case the bearer form is used, so a
proxy that unconditionally sets the header cannot mask a good credential.

### What the two axes mean here

Scopes decide **which surfaces** a key may reach; capability decides **what it
may do** on them. They are separate on purpose: an empty `scopes` array already
means full surface, so folding verbs into that list would leave no way to say
"reaches everything, may not delete" (`ApiKeyCapability.ts:3-18`).

Scope enforcement is **deny-by-default for scope-limited keys**
(`common/guards/apiKeyScopeEnforcement.ts:87-116`):

| Principal | Effect at `/mcp` |
|---|---|
| Session JWT / Portal bearer (`apiKeyScopes === undefined`) | Full authority; scope axis does not apply |
| API key with an **empty** scope array | Grandfathered full-surface; scope axis does not apply |
| API key with a **non-empty** scope array | Must carry `mcp` or it is refused with 403 |

Capability is opt-in per route and applies to **every** api-key principal
including empty-scope ones (`:132-158`). `read` is the floor for *reaching* the
endpoint — a read-only key must be able to initialize, list tools, and call the
ones that only read. Which tools it may actually run is decided per tool inside
`McpToolService`, which is the only layer with something specific enough to gate
on (the comment at `McpController.ts:87-89` says exactly this).

---

## Minting a key for an agent

Keys are managed at `@Controller('keys')`
(`backend/apps/api/src/domains/auth/controllers/ApiKeyController.ts:86`),
guarded by `JwtOrPortalAuthGuard` — **never** an api key, so a leaked key cannot
mint successors that outlive its revocation (`:80-85`). In the UI that is
Settings → API keys.

Create body (`createApiKeySchema`, `:62-67`):

```json
{
  "name": "hermes-mcp",
  "scopes": ["mcp", "intents"],
  "capability": "read",
  "expires_at": "2027-01-01T00:00:00.000Z"
}
```

- `scopes` is validated against the canonical enum — `memory`, `intents`, `mcp`,
  `capture` (`:53`). A typo would otherwise mint a key that authenticates
  perfectly and is then refused everywhere, which is a miserable thing to debug.
- `capability` is `read` | `write` | `full` (`ApiKeyCapability.ts:19`). Omitted
  on create it defaults to `write` (`:35`) — chosen because `read` makes a
  freshly connected agent look broken rather than restricted, and `full` would
  hand every new key the ability to delete memories.
- Omitting `scopes` entirely mints an **empty-scope** key, which is full-surface.
  That is the grandfathered tier, not a least-privilege one.

### The one combination that looks right and is not

**`mcp` on its own gets you an empty tool list.** A scope-limited key is
confined off the GraphQL data plane, and the native intents are gated behind
`intents` — so a key holding only `mcp` connects, initializes, and sees nothing.
Pair `mcp` with `intents`. The settings UI warns about exactly this
(`frontend/apps/web/src/pages/SettingsPage/sections/ApiKeysSection.tsx:253-258`),
and both chat-agent connect keys already carry both scopes
(`scopesForApp`, verified in
`backend/apps/api/src/domains/auth/__tests__/ConnectService.test.ts:347-348`).

---

## Session lifecycle

An `initialize` POST with no `Mcp-Session-Id` builds a fresh transport, asks
`McpServerService.createServer(req)` for a server, connects the two, and — once
the transport has assigned itself an id — records the session
(`McpController.ts:117-162`). The client echoes that id in the
`Mcp-Session-Id` header on every subsequent request.

Sessions live in an in-process `Map` (`:92`). Consequences:

- they do not survive an API restart, and they are not shared across replicas;
- the map is bounded only by the reaper below.

**Idle TTL is 30 minutes** (`SESSION_TTL_MS`, `:28`), swept by a cron every five
minutes registered as `McpController.reapStaleSessions` (`:237`). The reaper
closes the transport and drops the entry (`:238-250`). It is wrapped by the
repo's own `@Cron` from `@ci/common/schedule` rather than the raw
`@nestjs/schedule` import, so the run is stamped into `ci.cron_runs` and an
operator can tell a healthy appliance from one whose scheduler died — there is a
test that exists solely to keep that true
(`controllers/__tests__/McpController.test.ts:43-49`).

A client that goes quiet for half an hour will find its session gone. The MCP
Streamable HTTP transport treats the 404 it gets back as "re-initialize", so a
well-behaved client recovers on its own.

---

## The authority signature, and why a session is frozen

This is the part of the design worth understanding before touching it.

`McpServerService.createServer(req)` is called **once**, at `initialize`. It
builds the tool list from that request, and every tool handler closes over that
same request object (`McpServerService.ts:87-95`). A session is therefore frozen
to the authority of whoever opened it: not just the tool *catalog*, but the
authority the handlers carry down into the GraphQL resolvers when they execute.

So the session map cannot key on `userId` alone. On a single-owner appliance —
which is the normal deployment — the owner's browser session and an agent's
scope-limited connect key are **the same user**. If `userId` were the whole
check, an agent could present the owner's `Mcp-Session-Id` and inherit a
transport whose GraphQL tools were registered for a full-authority principal.
The agent would not merely see tools it should not; it would execute them with
the owner's authority baked into the captured request.

Each session therefore carries an **authority signature**
(`apiKeyAuthoritySignature`, `McpController.ts:66-80`) — a JSON encoding of:

| Field | Why it is in there |
|---|---|
| `keyId` | Two keys can hold identical scopes. Both chat agents' connect keys do, under one owner. A scopes-only signature would let one agent resume, drive or terminate the other's session. |
| `scopes` (sorted) | So that re-scoping a key retires the sessions that key opened. |
| `capability` | Same reason, for the other axis. Because the session is frozen, a key demoted from `full` to `read` would otherwise keep its old authority — the handlers' captured request still says `full` — until the session expired. Including it means the demotion an operator just made takes effect on the next request instead of up to 30 minutes later. |

Non-api-key principals get a distinct sentinel, `{"principal":"non-api-key"}`
(`:69-73`), rather than sharing a signature with an empty-scope key. Both carry
full authority, but they are not the same authority and should not inherit each
other's sessions.

The encoding is JSON rather than a delimiter join because scope strings are
free-form: a naive `join(',')` collides `['a,b']` with `['a','b']` — two
different authorities, one signature (`:61-64`).

### Why the mismatch is a 404

`resolveSession` is the single check for all three verbs (`:223-235`), so POST,
GET and DELETE cannot drift into disagreeing about who owns a session. A caller
who is not the opener gets **404 Session not found**, not 403. Two reasons:

1. MCP's Streamable HTTP transport reads 404 as "session is gone, re-initialize"
   and 401/403 as an auth failure to retry. A key whose scopes were legitimately
   edited mid-session would otherwise be wedged — unable to resume the old
   session, unable to `DELETE` it, given no signal to open a new one.
2. 404 declines to confirm that someone else's session id exists.

---

## The tool surface

Two sources, consolidated at boot by `McpToolService.onModuleInit`
(`services/McpToolService.ts:33-42`).

### (a) GraphQL-derived

`GraphQLToolAdapter` turns **every** root query field and **every** root mutation
field into a tool (`services/GraphQLToolAdapter.ts:59-84`). Names are
`query_<field>` and `mutation_<field>` (`:99`); argument types become Zod input
schemas. The count scales with the schema automatically, which is the point and
also the reason the privacy labels below are synthesized rather than authored.

Labels (`synthesizePrivacy`, `:117-140`):

- a query is `access: 'read'`, non-destructive;
- a mutation is `access: 'write'` — unless its name starts with `delete`,
  `remove`, `destroy`, `purge` or `drop` (`:34`), in which case it is
  `access: 'delete'` and `destructive: true`;
- everything is `external: false` and `sensitivity: 'personal'`.

Execution goes through `McpExecutorService`, which builds a GraphQL document
from the field's args and return type and runs it against the schema
(`services/McpExecutorService.ts:33-82`). This plane never touches
`ToolRegistry`, so it used to leave no ledger row at all — an MCP client calling
`deleteMemory` was invisible to the surface built to see exactly that.
`McpToolService.recordGraphqlInvocation` now writes it through the registry with
`source: 'graphql'` so there is one emit path rather than two
(`McpToolService.ts:213-240`).

### (b) Native curated intents

Every tool in the shared `ToolRegistry` is a curated intent with a dotted id
(`memory.recall`), advertised under its MCP-safe executable name
(`memory_recall`) via `intentToolName` (`McpToolService.ts:266-292`).

The list comes from `getOutboundCatalogTools()`, not the full agent-facing list,
which excludes tools sourced from the owner's own external MCP servers — see
[README.md](README.md#where-the-two-sides-meet) for why that recursion is closed
deliberately. A native name that collides with a GraphQL-derived one is skipped
with a debug log (`:278-282`).

### Annotations

Every registered tool carries standard MCP annotation hints derived from its
privacy label, so nothing — including auto-wrapped CRUD — reaches a client
unlabelled (`McpServerService.ts:128-135`):

| Hint | Source |
|---|---|
| `readOnlyHint` | `privacy.access === 'read'` |
| `destructiveHint` | `privacy.destructive` |
| `openWorldHint` | `privacy.external` |

These are hints for the client's benefit. They are not the enforcement — see
below.

---

## What a given caller actually sees

`getToolsForRequest` (`McpToolService.ts:80-96`) filters the consolidated list
per request, on the two axes:

| Caller | GraphQL-derived tools | Native intents |
|---|---|---|
| Session JWT / Portal bearer | all, minus capability filter | all, minus capability filter |
| Empty-scope api key | all, minus capability filter | all, minus capability filter |
| Scope-limited key **without** `intents` | none | none |
| Scope-limited key **with** `intents` | none | all, minus capability filter |

Two rules produce that table.

**Scope-limited keys are confined off the GraphQL plane.** The resolvers behind
`/graphql` declare no `@RequireScopes`, so deny-by-default already rejects a
scope-limited key on every one of them. Advertising those tools anyway would
hand the model a catalog where every call fails with an opaque
`Forbidden resource` (`:66-70`).

**Native intents require `intents`, not just `mcp`.** `ToolRegistry` performs no
authorization of its own, and `knowledge.search` alone reads across the whole
personal graph. These tools are the MCP face of the intent catalog, so they
require the same scope the REST catalog at `/api/intents` does — otherwise an
`mcp`-only key, 403'd there, could execute those very intents here (`:71-76`).
`mayRunIntents` (`:105-111`) is the single source of truth for that question, so
the tool filter, the executor and the `intents://catalog` resource cannot
disagree.

**Capability filters what is left.** `capabilityAllows`
(`domains/tools/policy/capabilityPolicy.ts:45-59`):

| Capability | May run |
|---|---|
| `full` | everything |
| `write` | anything that does not remove data |
| `read` | only `access: 'read'` tools |

"Removes data" collapses `access === 'delete'` and `destructive` — both answer
"can this lose data?" with yes, and a level that allowed one but refused the
other would be a distinction no user could act on (`:27-29`).

### Filtering is a courtesy; enforcement is separate

A client can name any tool directly whether or not it was advertised.
`McpToolService.executeTool` re-checks before dispatching (`:127-196`), in a
deliberate order: capability first, because that answer does not depend on which
plane the tool lives on — a read-only key is refused `deleteMemory` whether it
came from the schema or the catalog, and the message should say so rather than
blaming the scope. Below that, `ToolRegistry.executeTool` applies the same rule
for every transport, so MCP's pre-check is about returning a precise 403, not
about being the only lock on the door.

---

## Resources

Two, both registered per session and both gated on the same predicate as the
tools they describe (`McpServerService.ts:33-85`).

| URI | MIME | Who sees it |
|---|---|---|
| `schema://graphql` | `text/plain` | Non-scope-limited callers only |
| `intents://catalog` | `application/json` | Anyone `mayRunIntents` allows |

`schema://graphql` is the full GraphQL SDL. It is withheld from scope-limited
keys because the SDL describes the whole personal knowledge graph, and a key
confined off that data plane cannot call any of it — handing over the schema
would leak the shape of the owner's data for no usable purpose (`:34-37`).

`intents://catalog` is `IntentCatalogService.getManifest()` — schema domains,
entity types, and the curated intents with their privacy labels
(`domains/tools/catalog/IntentCatalogService.ts:42-76`). It exists so that any
MCP client reads one catalog instead of every harness re-implementing the same
integration glue, and so an agent is nudged toward the curated semantic actions
rather than raw CRUD. Gated on the same scope as the intents themselves, so a
key that cannot execute an intent is not handed the catalogue describing them
(`McpServerService.ts:62-65`).

The same manifest is served over REST at `GET /api/agent/intents` and
`GET /api/intents` for non-MCP agents.

---

## Open questions

- **Multi-replica deployments.** The session map is per-process (`:92`), so an
  appliance behind more than one API replica would need sticky routing on
  `Mcp-Session-Id` for sessions to survive. Nothing in this repo configures
  that, and nothing in the code detects its absence. If you are running more
  than one replica, treat this as unverified.

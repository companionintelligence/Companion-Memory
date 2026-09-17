# Connecting the appliance to external MCP servers

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

The other direction. The owner configures third-party MCP servers — a
filesystem server, a GitHub server, a hosted docs server — and the appliance
connects **out** to them, treating their tools as a second provider alongside
its own. Everything here is
`backend/apps/api/src/domains/mcp-client/`; citations are `path:line` against
that directory unless stated otherwise.

This is not the surface an agent connects to. That is [server.md](server.md),
and the two never meet: a tool discovered here is deliberately never
republished there. See [README.md](README.md#where-the-two-sides-meet).

In the UI this is Settings → MCP Servers
(`frontend/apps/web/src/pages/SettingsPage/settingsNav.ts:41`).

---

## The REST surface

`McpServerConfigController` mounts under the same `@Controller('mcp')`
namespace as the protocol endpoint (`controllers/McpServerConfigController.ts:92`),
taking only sub-paths so it cannot collide with the bare verbs
`McpController` owns. Browser-facing paths carry the `/api` prefix the edge
strips.

| Route | Guards | Purpose |
|---|---|---|
| `GET mcp/servers` | Jwt/Portal | The caller's own configs (`:97`) |
| `POST mcp/servers` | Jwt/Portal + **Admin** | Create (`:105`) |
| `PATCH mcp/servers/:id` | Jwt/Portal + **Admin** | Update (`:116`) |
| `DELETE mcp/servers/:id` | Jwt/Portal + **Admin** | Delete, 204 (`:128`) |
| `POST mcp/servers/:id/enable` | Jwt/Portal + **Admin** | Enable (`:137`) |
| `POST mcp/servers/:id/disable` | Jwt/Portal + **Admin** | Disable (`:145`) |
| `POST mcp/servers/:id/approve-tools` | Jwt/Portal + **Admin** | Approve or revoke individual tools (`:157`) |
| `POST mcp/servers/:id/test-connection` | Jwt/Portal + **Admin** | Probe a saved config (`:169`) |
| `POST mcp/test-connection` | Jwt/Portal + **Admin** | Probe an unsaved draft (`:177`) |
| `GET mcp/catalog` | Jwt/Portal | The read-only suggested catalog (`:183`) |

**No route here accepts an API key.** Every one uses `JwtOrPortalAuthGuard` —
a session JWT or a Portal OIDC bearer. The reason is `stdio`: a config with
`transport: 'stdio'` is arbitrary local command execution on the appliance, a
materially bigger capability than an api key should ever reach. The same
rationale governs `ApiKeyController` (`:85-90`).

**`test-connection` is admin-gated too**, on both routes. For a stdio config it
spawns exactly the process a real connect would; it is not a read.

Listing your own configs and browsing the catalog are the only two routes that
do not require admin.

---

## The config row

`ci.mcp_server_configs`, created by
`backend/apps/api/db/postgres/migrations/20260825233943_create_mcp_server_configs.sql`
and extended by `20260826205522_add_approved_tools_to_mcp_server_configs.sql`.
The migrations are the source of truth; `entities/McpServerConfigEntity.ts`
tracks them by hand.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | v7, generated application-side on create |
| `user_id` | uuid | `ON DELETE CASCADE` from `ci.users` |
| `name` | text | Display name |
| `slug` | text | Unique per user; sanitised to `[a-zA-Z0-9_-]`, and one half of every tool's intent id |
| `transport` | text | `stdio` or `http`, CHECK-constrained |
| `command` | text | stdio only; required by a CHECK constraint when transport is stdio |
| `args` | jsonb | Default `[]` |
| `env` | jsonb | `[{key, value, secret, label?}]`; `value` is ciphertext when `secret` |
| `url` | text | http only; required by the same CHECK constraint |
| `auth` | jsonb | `{type, fields[]}`, same entry shape as `env`, secrets encrypted |
| `enabled` | boolean | Default true |
| `source` | text | `user_added` or `catalog` |
| `catalog_slug` | text | Which catalog entry seeded it, when any |
| `discovered_tools` | jsonb | Cache of the last successful `tools/list` |
| `approved_tools` | jsonb | The human grant. `NULL` and `[]` mean different things — see below |
| `connection_status` | text | `disconnected` \| `connecting` \| `connected` \| `error` |
| `last_connected_at` | timestamptz | |
| `last_error` | text | |

This is a row per server rather than a JSONB blob hung off `ci.users` because
connection state is written on every transition by the manager, independently of
whatever else is happening to the user's settings — and because the settings
list view then reads a status badge straight out of the table instead of
live-probing every configured server to render one.

Two CHECK constraints are worth knowing about, because they will reject a write
the application layer forgot to validate: transport must be `stdio` or `http`,
and a stdio row must have a `command` while an http row must have a `url`. A
config missing its transport field is not a draft, it is a config that can never
connect.

### What comes back over the wire

`McpServerConfigEntity.toEgressType` masks every `secret: true` entry in `env`
and `auth.fields` down to `{ value: null, isSet: true }` — never ciphertext,
never plaintext — on every GET, list, create and update response
(`entities/McpServerConfigEntity.ts:92-122`).

That masking is why updates have a merge rule rather than a replace rule: the
client only ever sees `null` for a set secret, so an update handler echoing the
object it just fetched must not blank the secret out. See
`mergeEntriesForUpdate` below.

The egress type also carries a derived `toolApprovals[]` — the per-tool state
computed server-side so the sha256 canonicalisation has exactly one
implementation. A second one in the browser would silently disagree on key
order (`:113-115`).

---

## Secrets

`services/McpSecretCodec.ts`. Per-**field** AES-256-GCM over the `env` and
`auth` JSONB columns, using the same `encrypt`/`decrypt` (`enc:v1:` prefix) and
the same `AUTH_FIELD_ENCRYPTION_KEY` as every other encrypted column in the
codebase (`common/crypto/field-encryption.ts`).

Per-field rather than whole-column deliberately: `env[]` and `auth.fields[]`
each mix genuine secrets (a GitHub token, a database password) with plain values
(a flag, a header name, an allowed path) in the same array. Encrypting the whole
blob would force every plain field through a decrypt just to read something that
was never sensitive (`:8-21`).

| Method | Does |
|---|---|
| `encryptEntries` | Encrypts every `secret: true` entry's plaintext before write. Idempotent — an entry already carrying ciphertext is not double-encrypted (`:31-36`) |
| `decryptEntries` | Back to plaintext, in-process only |
| `encryptAuth` / `decryptAuth` | The same walk over `auth.fields` |
| `mergeEntriesForUpdate` | For any `secret: true` field submitted as `value: null`, keeps the stored ciphertext — "leave unchanged". Anything else, **including an empty string**, is a rotation (`:68-91`) |

A decrypted value exists only inside `McpClientManagerService`, at the moment it
needs the real thing to spawn a stdio process or set an HTTP auth header. It is
never logged and never returned from an API response. The one shared decryption
path is `decryptedDraftFromEntity` (`mapping.ts:12-25`), used by both the real
connect and `test-connection` on a saved config so the two cannot drift on what
"decrypted" means.

`decryptValue` tolerates a plaintext value rather than throwing (`:97-105`) —
defensive against a row written before encryption was wired up, not an expected
steady state.

### HTTP auth shapes

`auth` is modelled as `{type, fields[]}` rather than one interface per type, for
the same reason `env` is an array: each type mixes one secret field with zero or
more plain ones, and a single generic entry list lets the codec, the masking and
the update rule each be written once (`types.ts:171-186`).

Conventional field keys, enforced by the service layer rather than the type, and
turned into headers by `buildAuthHeaders`
(`services/McpClientManagerService.ts:543-574`):

| `type` | Fields | Header sent |
|---|---|---|
| `bearer` | `token` (secret) | `Authorization: Bearer <token>` |
| `basic` | `username`, `password` (secret) | `Authorization: Basic <base64>` |
| `api_key` | `headerName`, `value` (secret) | `<headerName>: <value>` |

A half-configured `bearer` or `api_key` block returns `undefined` rather than a
malformed header, so the connection fails with a clear transport error instead
of a confusing 401 from the far end.

---

## The tool digest, and what it is for

`services/mcpToolDigest.ts`. The problem it solves is stated plainly in the
migration that introduced it: before `approved_tools` existed, `tools/list` ran
on every connect and reconnect, the answer went straight into
`discovered_tools`, and `McpToolProvider` rebuilt the assistant's tool cache
from that column **with nothing to compare it against**. Adding a server was
therefore a standing grant over whatever that server chose to offer later. A
renamed argument, a widened schema, or an entirely new tool appeared in chat
silently.

`computeSchemaDigest` (`:64-68`) is sha256 hex over the tool's *canonicalised*
`inputSchema`. Canonicalisation (`:30-59`) does three things:

- **sorts object keys at every depth**, because JS object key order is insertion
  order and a round-trip through Postgres jsonb does not preserve it;
- **strips `description`, `title`, `$comment` and `examples`** (`:17`) — human
  prose is never a capability, and if prose churn read as drift the UI would cry
  wolf and people would switch the gate off;
- **preserves array order**, because in JSON Schema order is meaning (`required`,
  `enum`, `prefixItems`, `anyOf` branch precedence). Sorting arrays would hide a
  real change.

`undefined` is normalised to `null` up front, because `JSON.stringify` drops
undefined object values but renders undefined array entries as `null`.

The tool **name is not part of the digest** (`:60-63`). The name is the
approval's key; mixing it in would mean a rename could never be reported as
"this tool is new" — it would surface as a changed digest on a name that no
longer exists.

The digest is a contract three call sites must agree on byte for byte: the
provider's intersect, the approve endpoint's "is this still the schema you were
shown" check, and the settings UI's drift badge. That is why it is a standalone
pure function rather than a method on either service.

---

## The approval flow

### States

`buildToolApprovals` (`:99-148`) diffs what the server currently offers against
what was approved, over the union of both:

| State | Meaning |
|---|---|
| `approved` | Offered, approved, and the current schema still digests to the approved value |
| `new` | Offered but never approved. Invisible to chat |
| `schema_changed` | Approved under a different schema. The capability changed, so it is invisible to chat until re-approved |
| `unavailable` | Approved, but the server no longer offers it |
| `legacy` | The row predates the approval gate (`approved_tools IS NULL`); passthrough until the next connect |

`unavailable` entries are included on purpose. An approval the upstream server
has quietly stopped backing is exactly what someone reviewing this screen should
be able to see and clear; omitting it would make the stored grant invisible.

### `NULL` is not `[]`

This distinction is load-bearing and is not a "column added, backfill later" gap
(`20260826205522_add_approved_tools_to_mcp_server_configs.sql`):

- **`NULL`** — a row that predates the migration. `isToolApproved` returns true
  for everything (`:78-89`), so an appliance already using these tools does not
  lose them at deploy. On the next successful connect,
  `McpClientManagerService` grandfathers whatever the server currently offers
  into an explicit set stamped `approvedBy: 'legacy:grandfathered'`
  (`services/McpClientManagerService.ts:164-183`). From that point drift is
  caught.
- **`[]`** — gated with nothing approved. Every config created after the
  migration starts here (`services/McpServerConfigService.ts:85-87`), so a newly
  added server contributes **zero** tools to chat until someone approves them.

No SQL backfill was attempted, deliberately: the digest has to match the
TypeScript canonicalisation byte for byte, and a plpgsql second implementation
would be a second source of truth that silently disagrees.

### Approving

`POST mcp/servers/:id/approve-tools`, body validated by `approveMcpToolsSchema`
(`controllers/McpServerConfigController.ts:67-78`) — at least one of
`approveAll`, `tools`, or `revoke` must be present.

```json
{
  "tools": [
    { "name": "read_file", "schemaDigest": "3f1c…" }
  ]
}
```

`schemaDigest` is **required, not optional**. It is the digest the client was
actually shown, and `approveTools` re-derives it from the schema currently in
`discovered_tools` and rejects a mismatch with a 400
(`services/McpServerConfigService.ts:192-198`). A schema that drifted between
rendering the list and clicking Approve therefore cannot be approved unseen,
which is the exact failure the feature exists to prevent. An approve request
that cannot say which schema it reviewed is not an approval.

Semantics, all covered by
`services/__tests__/McpServerConfigService.approveTools.test.ts`:

- **Merge, not replace.** Naming three tools leaves every other stored approval
  alone, so the settings screen can approve one drifted tool without silently
  revoking the twenty that were fine (`:126-144` in that test).
- **Approving a tool the server does not currently offer is a 400** (`:118-124`).
- **`revoke: ["name"]`** drops entries from the set (`:186-207`).
- **`approveAll`** re-blesses everything currently offered — the escape hatch a
  strict pin needs, because a pin with no one-click path to re-bless a
  legitimately updated upstream server is a pin people turn off. It **preserves
  the original `approvedAt`/`approvedBy` of every tool whose digest did not
  move** (`grandfatherApprovals`, `mcpToolDigest.ts:157-172`), so a bulk
  re-approval after one tool drifted does not rewrite the provenance of the
  other twenty and evaporate the column's audit value on first use
  (`:146-166` in the test).
- **`approveAll` on a `legacy` row** converts it into an explicit grant stamped
  with the approving user (`:168-184`).

Approving calls `manager.onToolApprovalsChanged()`, **not** `onConfigChanged`
(`McpServerConfigService.ts:216`). That rebuilds the assistant's tool set
without tearing down and respawning a working stdio subprocess
(`McpClientManagerService.ts:305-312`).

### Enforcement

`McpToolProvider.getAvailableTools` intersects, per tool, before wrapping
(`providers/McpToolProvider.ts:76-103`). An unapproved or drifted tool is
**absent from the assistant's tool set**, not flagged in it. The behaviour is
pinned by `providers/__tests__/McpToolProvider.approval.test.ts`:

- an approved tool at its current schema is exposed as `mcp.<slug>.<name>`;
- a newly offered unapproved tool is invisible — `canHandle` is false and
  `getTool` returns undefined, not merely a missing schema;
- an approved tool whose `inputSchema` silently widened is withheld;
- a tool whose **description only** changed upstream keeps working, and the new
  description is what chat sees;
- an explicitly empty grant withholds everything;
- a `null` grant passes through;
- a tool already in the provider's cache is dropped from `getTool` as soon as
  its approval stops matching, not merely on the next restart.

### One honest caveat

The provider stamps a uniform pessimistic privacy label on every discovered
tool — `write`, `sensitive`, `destructive`, `external`, `localCapable: false`
(`McpToolProvider.ts:134-135`). It looks like a second gate and is not one.
`apiKeyCapabilityOf` returns `full` whenever `apiKeyScopes === undefined`, which
is exactly what a JWT/session principal is, and browser chat authenticates by
JWT. So on the surface where a drifted tool actually lands, that label filters
nothing (`:35-38`). The approval intersect is the gate. The label is there
because raw `tools/list` carries no privacy metadata at all, and treating an
unknown external tool as anything less than the worst case would be guessing.

---

## Connection lifecycle

`services/McpClientManagerService.ts` owns every live connection: opening the
transport, running `tools/list`, routing `tools/call`, and keeping the row's
status columns honest so the settings list never has to live-probe.

| Constant | Value | Why |
|---|---|---|
| `CONNECT_TIMEOUT_MS` | 8 s (`:50`) | One hung stdio spawn, or a server that never answers `initialize`, must not hang app boot |
| `BOOT_SWEEP_TIMEOUT_MS` | 15 s (`:53`) | Total budget for the boot sweep across every enabled config of every user |
| `INITIAL_BACKOFF_MS` | 2 s (`:45`) | Reconnect backoff doubles: 2 → 4 → 8 … |
| `MAX_BACKOFF_MS` | 60 s (`:47`) | …capped here |

The boot sweep runs from `McpToolsRegistrationService.onModuleInit`, **after**
the provider is registered (`services/McpToolsRegistrationService.ts:161-167`).
That ordering is not incidental: `ToolsModule` cannot import `McpClientModule`
(the latter already needs the former for `ToolRegistry`), and two independent
`onModuleInit` hooks would leave nothing guaranteeing the provider exists before
the first successful connection calls `refreshProvider('mcp')`. Doing both
steps, in order, in one method removes the race rather than papering over it.

A config still connecting when the 15 s budget runs out keeps connecting in the
background and reports in via its own status update whenever it finishes
(`:83-108`).

Every mutation in `McpServerConfigService` ends with `onConfigChanged`, which
disconnects, resets backoff, and reconnects if the config still exists and is
enabled (`:219-242`). The reconnect is fire-and-forget so the HTTP request that
changed the config does not block on a slow stdio spawn.

`callTool` requires a live connection and throws if the server is not currently
connected (`:314-332`) — the `discovered_tools` cache lets the UI and the tool
catalog show something between attempts, but it cannot serve a call.

### Tool naming

A discovered tool becomes the dotted intent id
`mcp.<serverSlug>.<toolName>` (`naming.ts:99-101`), later turned into the
executable name by `intentToolName` (dots → underscores). Both halves are
server-controlled data — a slug a user typed, a raw tool name from someone
else's `tools/list` — so both are sanitised to `[a-zA-Z0-9_-]` before being
spliced into a name that has to survive the executable-name regex and not
collide with a native intent. A duplicate after sanitisation is skipped with a
warning (`McpToolProvider.ts:92-95`).

---

## The suggested catalog

`catalog/mcpSuggestedCatalog.ts`, served read-only at `GET mcp/catalog` to any
signed-in user. It pre-fills the create form; the user still reviews and edits,
and an **admin** still has to be the one who actually adds the server.

Two tiers.

**`normal`** — read/write scoped servers. As written: `filesystem-mcp`,
`github-mcp`, `git-mcp`, `fetch-mcp`, `sqlite-mcp`, `postgres-mcp` (all stdio)
and `context7` (http, `api_key` auth). Entries carry the command and args, an
`env` spec naming which fields are required and which are secret, and — for the
`uvx`-based ones — `requires: { host_software: ['uv'] }`.

**`highRisk`** — full, unsandboxed desktop control: `computer-control-mcp` and
`open-computer-use`. Each carries a mandatory `warning` string shown before
adding. Adding one requires `acknowledgedHighRisk: true` in the create body, and
`McpServerConfigService.create` re-validates that **server-side** against
`HIGH_RISK_CATALOG_SLUGS` regardless of what the client claims to have shown the
user (`services/McpServerConfigService.ts:56-66`). A request forged or replayed
without ever rendering the confirmation UI is still rejected. The UI gate is not
the enforcement.

Note the layering: acknowledging the high-risk warning gates *adding the
server*. It does not approve a single tool. Installing is not the grant; the
approval flow above is.

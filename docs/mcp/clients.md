# Connecting an MCP client to the appliance

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

Recipes for pointing Claude Code, Claude Desktop and Cursor at a running
CI-Server. The endpoint, auth model and tool surface are explained in
[server.md](server.md); this page is the copy-pasteable half.

---

## Read this first: transport

**The appliance speaks streamable HTTP on `/mcp` (or `/api/mcp` behind the gateway), and the `ci` CLI ships a local stdio bridge (`ci mcp serve --stdio`).** `McpController` mounts a
`StreamableHTTPServerTransport`
(`backend/apps/api/src/domains/mcp/controllers/McpController.ts:1,118-120`), while
`backend/apps/cli/src/commands/mcp.ts` bridges newline-delimited JSON-RPC over
stdin/stdout to the appliance's Streamable HTTP endpoint — see
[the stdio bridge section](#the-stdio-bridge-ci-mcp-serve---stdio) below.

Clients that speak Streamable HTTP directly can use the URL + header blocks
below; clients that spawn a local subprocess (such as Claude Desktop stdio
connectors, Goose, or MCP Inspector) can run `ci mcp serve --stdio`.

The JSON shown below is each client's own configuration format, not the
appliance's. Client config schemas change; if a block does not load, check that
client's current documentation for the remote-server syntax rather than assuming
the appliance is wrong. What the appliance requires is fixed and small:

- **URL** `https://<appliance>/api/mcp` (the `/api` prefix is stripped by the
  edge before it reaches Nest — do not remove it from the client config);
- **Credential** an API key, sent as `Authorization: Bearer <key>` or in
  `x-api-key`. Both are read by the same strategy
  (`backend/apps/api/src/domains/auth/services/ApiKeyStrategy.ts:33-41`); the
  bearer form exists because most clients only offer one token field.

## Before you connect: mint the key

Settings → API keys, or `POST /keys`. Give it the **`mcp` and `intents`
scopes**, and the lowest capability the agent actually needs.

`mcp` alone is the trap: a scope-limited key holding only `mcp` authenticates,
initializes, and then sees an empty tool list, because the GraphQL plane is
closed to scope-limited keys and the native intents are gated behind `intents`.
Full reasoning in [server.md](server.md#the-one-combination-that-looks-right-and-is-not).

Capability is the second axis: `read` for an agent that should only look,
`write` to let it record, `full` only if it genuinely needs to delete
(`backend/apps/api/src/common/decorators/ApiKeyCapability.ts:19-25`).

## Smoke-test before configuring a client

Cheaper to debug a curl than a client's log file. A successful `initialize`
returns an `Mcp-Session-Id` header and the server identity.

```bash
curl -i -X POST https://ci-memory.example.com/api/mcp \
  -H "Authorization: Bearer $CI_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke-test","version":"1.0"}}}'
```

Expect `Mcp-Session-Id: <uuid>` in the response headers and
`result.serverInfo = {"name":"companion-memory","version":"0.1.0"}` in the body.

Reading the failures:

| Response | Meaning |
|---|---|
| `401` | The credential was not accepted at all — wrong key, or expired |
| `403 ... missing required scope(s): mcp` | The key is scope-limited and lacks `mcp` |
| `403 ... is "read" and cannot perform this action` | Capability below `read`, which should not happen — `read` is the floor |
| `200` but an empty `tools/list` | Almost always `mcp` without `intents` |

The `Accept` header matters: the streamable HTTP transport needs both
`application/json` and `text/event-stream` offered.

---

## Claude Code

Claude Code reads MCP servers from `.mcp.json` at the project root (checked in,
shared with the team) or from user-level configuration. There is no `.mcp.json`
in this repo today — this would be a new file.

```json
{
  "mcpServers": {
    "companion-memory": {
      "type": "http",
      "url": "https://ci-memory.example.com/api/mcp",
      "headers": {
        "Authorization": "Bearer ${CI_API_KEY}"
      }
    }
  }
}
```

Or add it from the command line, without editing a file:

```bash
claude mcp add --transport http companion-memory https://ci-memory.example.com/api/mcp --header "Authorization: Bearer $CI_API_KEY"
```

Do not commit a real key. Use the environment-variable form and export
`CI_API_KEY` in your shell, the same variable the `ci` CLI already reads
(see [`docs/cli/ci.md`](../cli/ci.md)).

Against a local dev stack the URL is your worktree's Caddy host — `make dev`
prints it, and it looks like `https://<project>.localhost/api/mcp`.

## Claude Desktop

Config file:

```
~/Library/Application Support/Claude/claude_desktop_config.json
```

on macOS, and `%APPDATA%\Claude\claude_desktop_config.json` on Windows.

```json
{
  "mcpServers": {
    "companion-memory": {
      "type": "http",
      "url": "https://ci-memory.example.com/api/mcp",
      "headers": {
        "Authorization": "Bearer <paste the api key>"
      }
    }
  }
}
```

Restart the app after editing; it reads the file at launch.

**Caveat.** Claude Desktop's support for remote servers configured this way has
changed across versions, and some builds expect a custom connector added through
the UI rather than an entry in this file. If the entry does not appear, that is
the likeliest reason — and it is the case the [stdio bridge](#the-stdio-bridge-ci-mcp-serve---stdio)
serves. The appliance side is unaffected either way: it only ever
sees an HTTP request with a credential.

## Cursor

Config file, project-scoped at `.cursor/mcp.json` or global at
`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "companion-memory": {
      "url": "https://ci-memory.example.com/api/mcp",
      "headers": {
        "Authorization": "Bearer <paste the api key>"
      }
    }
  }
}
```

Cursor infers the transport from the presence of `url`. Reload the window after
editing.

---

## The stdio bridge (`ci mcp serve --stdio`)

Implemented in `backend/apps/cli/src/commands/mcp.ts`.

### What it is for

Every client above wants a URL and a header, and the appliance is happy to
provide both. For clients that spawn a local subprocess instead of speaking
Streamable HTTP directly, `ci mcp serve --stdio` presents a stdio MCP server on
stdin/stdout and forwards each JSON-RPC message to `/mcp` (automatically falling
back to `/api/mcp` when behind a gateway prefix), preserving the
`Mcp-Session-Id` header across the session lifecycle and sending `DELETE` on
stdin EOF.

It is a transport shim, not a second server. The session, the authority
signature, the tool filtering and the TTL described in [server.md](server.md) all
still happen on the appliance, driven by whatever key the bridge presents. A
bridge started with a `read`-capability key gets a `read` tool surface; there is
no privilege to be gained by going through it.

### Configuration recipe

```json
{
  "mcpServers": {
    "companion-memory": {
      "command": "ci",
      "args": ["mcp", "serve", "--stdio"],
      "env": {
        "CI_SERVER_URL": "https://ci-memory.example.com",
        "CI_API_KEY": "<paste the api key>"
      }
    }
  }
}
```

You can also pass the global `--server <url>` and `--api-key <key>` flags on the
`ci` command line (`ci --server https://ci-memory.example.com --api-key <key> mcp serve --stdio`).

# 07 — API Scopes & Throttling

> **Status:** draft &nbsp;•&nbsp; **Phase:** P0 &nbsp;•&nbsp; **Critical path:** yes
>
> API-key scopes are stored but not checked. There is no rate limiting. Fix both before external agents can connect at scale.

---

## 1. Summary

`ApiKeyEntity.scopes` is a `text[]` populated at create time and never read. `ApiKeyStrategy.validate` does not consult them. `@nestjs/throttler` is not installed. Every authenticated key can do everything. This is the single fastest way the digital-twin promise breaks — an MCP client with a leaked key can read or destroy the entire graph.

## 2. Current state

```ts
// auth/services/ApiKeyService.ts
async create(...) { /* writes scopes[] */ }

// auth/services/ApiKeyStrategy.ts
async validate(req) {
  const result = await apiKeyService.validateKey(apiKey);
  // ← never reads scopes
}
```

Grep results:
- `grep -rn "Throttle\|RateLimit" backend/apps/api/src` → no matches.
- `grep -rn "REQUIRED_SCOPES\|@Scopes" backend/apps/api/src` → no matches.

## 3. Target state

### 3.1 Scope taxonomy

| Family | Scopes | Notes |
|---|---|---|
| memory | `memory:read`, `memory:read:semantic`, `memory:read:episodic`, `memory:read:procedural`, `memory:write`, `memory:write:semantic`, `memory:delete` | kind-scoped reads, default keys get `memory:read` |
| files | `files:read`, `files:write`, `files:delete` |   |
| chat | `chat:read`, `chat:write`, `chat:stream` |   |
| tools | `tools:invoke:<tool_name>`, `tools:invoke:*` | per-tool granularity |
| skills | `skill:invoke:<skill_name>`, `skill:invoke:*`, `skill:install`, `skill:author` |   |
| profile | `profile:read`, `profile:write` |   |
| devices | `devices:ingest`, `devices:admin` |   |
| admin | `admin:read`, `admin:*` | superuser; required for export/destructive ops |

Wildcards (`memory:*`, `*:read`, `*`) supported via prefix match.

### 3.2 Enforcement

```ts
// common/guards/ScopesGuard.ts
@Injectable()
export class ScopesGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.get<string[]>('scopes', ctx.getHandler()) ?? [];
    if (required.length === 0) return true;
    const apiKey = RequestContext.current()?.apiKey;
    if (!apiKey) return true;        // JWT (user session) — full scope
    return matchScopes(apiKey.scopes, required);
  }
}

// usage:
@Get('/entities/:id')
@Scopes('memory:read')
async getEntity(...) {...}
```

GraphQL resolvers get the same via a `@AuthScope('memory:read')` field directive that the resolver builder reads at schema-compile time.

MCP tools inherit scopes from their GraphQL source (auto-derived) or declare on `BaseTool` (native).

### 3.3 Throttling

`@nestjs/throttler` v6, configured with three layers:

| Layer | Default | Override |
|---|---|---|
| Global per-IP | 600 req/min | infra-level |
| Per-key | 120 req/min | `api_keys.rate_limit_per_minute` |
| Per-tool (writes) | 10 req/min | per-tool override |

Throttle keys are derived from `actor_id` (not IP) so legitimate single-user traffic from many devices isn't punished.

### 3.4 Schema additions

```sql
ALTER TABLE api_keys ADD COLUMN rate_limit_per_minute int DEFAULT 120;
ALTER TABLE api_keys ADD COLUMN rate_limit_burst int DEFAULT 60;
ALTER TABLE api_keys ADD COLUMN last_used_at timestamptz;
ALTER TABLE api_keys ADD COLUMN denied_count int DEFAULT 0;
ALTER TABLE api_keys ADD COLUMN revoked_at timestamptz;

CREATE TABLE auth_denials (
  id uuid PRIMARY KEY,
  actor_id uuid,
  api_key_id uuid,
  required_scopes text[],
  granted_scopes text[],
  route text,
  at timestamptz DEFAULT now()
);
```

### 3.5 Default keys

The SPA-issued key for the local user is `memory:read profile:read chat:read chat:write` — explicitly read-mostly. The user gets a "Create write key" path that requires re-auth and shows a clear "this key can modify your memory" confirmation.

## 4. Branch disposition

| Branch | Role |
|---|---|
| `add-api-keys` | Already merged on main. This plan builds on top of it. |

## 5. Phased steps

| # | Increment |
|---|---|
| 1 | Add `@Scopes(...)` decorator + `ScopesGuard`; opt-in (no enforcement yet) |
| 2 | Annotate every controller route + resolver field with required scopes |
| 3 | Flip enforcement on; keys without the right scope get 403 (with a clear hint) |
| 4 | Install `@nestjs/throttler`; throttle by `actor_id` |
| 5 | Schema: rate-limit columns, `auth_denials` table |
| 6 | UI: scope checkboxes when creating a key; revocation; "denied" log view |
| 7 | MCP integration: tool gating inherits the same guard |

## 6. Risks

| Risk | Mitigation |
|---|---|
| Annotating every route is tedious and error-prone | A CI lint that fails the build if any route has no `@Scopes` (or explicit `@Public`). |
| Wildcards too permissive | Reject `*` on key creation unless `admin:write` present in caller's session. |
| Throttler blocks the user's own SPA | Use `actor_id` not IP; SPA uses session JWT which is treated as a high-budget actor. |
| Scope schema drifts | Single source of truth in `common/scopes.ts`; tests assert every controller route appears. |

## 7. Eval / acceptance

- Lint blocks PRs that add unannotated routes.
- A `memory:read` key receives 403 on a write mutation, logged in `auth_denials`.
- Throttler returns 429 with a `Retry-After` after the configured burst.
- Revoking a key takes effect within one request (no caching).

## 8. Open questions

- Should the throttler be per-route-class (read/write/llm/tool) or per-route? (Lean: class-based with per-tool override for expensive ones.)
- Do we charge LLM-budget against the same rate-limit headroom or a separate one? (Lean: separate; see [04](04-llm-routing.md) cost guardrails.)

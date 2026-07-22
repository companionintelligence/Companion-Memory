# CI-Server API — Authentication, Conventions & MCP Surface

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

Reference documentation for the CI-Server NestJS API: its three authentication mechanisms, the guard model, cross-cutting request conventions, and the Model Context Protocol (MCP) surface. The GraphQL surface is in [graphql.md](graphql.md); the REST controllers in [rest.md](rest.md).

All citations are `path:line` against `backend/apps/api/src`.

---

## 0. Bootstrap & routing at a glance

A single NestJS 10 process listening on `config.host:config.port` (default `0.0.0.0:3030`; `config/default.json:2-3`).

Bootstrap (`main.ts`) is deliberately thin:

- `bodyParser: false` — Nest's built-in parser is disabled (`main.ts:11`); body parsing is delegated to `BodyParserMiddleware` so per-route size limits apply (see [§4.1](#41-request-body-limits)).
- `cookieParser()` is installed globally (`main.ts:17`) so `req.cookies` is populated for the session/CSRF/OIDC flows.
- `express.set('trust proxy', 1)` (`main.ts:21`) — required so `req.secure`, `req.ip`, and `X-Forwarded-*` reflect the fronting proxy (Hub Traefik / Portal Cloudflare tunnel), which drives the `secure` cookie flag and the OIDC callback origin.

**There is no server-side global prefix.** `setGlobalPrefix` is never called. Controllers mount at their bare decorator paths — it is `POST /authenticate`, not `/api/authenticate`. The `/api` segment browsers use is stripped by the frontend proxy before the request reaches Nest (`frontend/apps/web/vite.config.ts:139-148`, `rewrite: p => p.replace(/^\/api/, '')`).

> ⚠️ **Exceptions:** a few controllers hardcode `api/` *into their own path* so the public URL survives the proxy rewrite — `@Controller('api/intents')` and `@Controller('api/maintenance')`. The OIDC callback likewise hardcodes `/api/authenticate/oidc/callback` in the `redirect_uri` (`domains/auth/utils/oidcCallbackUrl.ts:1`) because that URL must be reachable *through* the proxy from the outside. Do not "fix" these to bare paths.

Global cross-cutting wiring lives in the root module (`application.ts`):

| Concern | Registration | Location |
|---|---|---|
| Request-context (AsyncLocalStorage) | `RequestContextMiddleware` on `*` | `application.ts:119` |
| Body parsing + size limits | `BodyParserMiddleware` on `*` | `application.ts:120` |
| Request logging | `RequestLoggerMiddleware` on `*` | `application.ts:121` |
| ID-format validation | `IdFormatGuard` as `APP_GUARD` (global) | `application.ts:103-106` |
| Error normalization | `GlobalExceptionsFilter` as `APP_FILTER` (global) | `application.ts:107-110` |

Note what is **not** global: there is **no global authentication guard** and **no CORS**.

---

## 1. Authentication mechanisms

Three (optionally four) credential types. Two are user-facing (session cookies for the browser SPA, API keys for programmatic clients); OIDC is a browser sign-in flow that mints a session cookie; a fourth, Portal-brokered bearer tokens, is a migration path gated off by default.

### 1.1 JWT session cookies (browser SPA)

The web app authenticates with **two separate JWTs**, each with a distinct job. They are never bridged — this is the single most important fact about the browser auth model.

| Credential | Kind | Lifetime | Where it lives | Secret | Sent as |
|---|---|---|---|---|---|
| **Access token** | JWT | `5m` (`default.json:14`) | In-memory React state — never a cookie/localStorage | `authTokenSecret` | `Authorization: Bearer <token>` |
| **Session token** | JWT | `7d` (`default.json:16`) | httpOnly cookie `sessionToken` | `refreshTokenSecret` | Cookie, automatically same-origin |

The **JWT passport strategy reads only the `Authorization: Bearer` header** — `ExtractJwt.fromAuthHeaderAsBearerToken()` (`domains/auth/services/JwtStrategy.ts:21`). The httpOnly session cookie is **never** copied into an `Authorization` header. The session cookie's *sole* runtime role is to mint fresh access tokens at `/authenticate/refresh` and to end the session at `/authenticate/logout`.

#### Cookie attributes

Both cookies are set through `domains/auth/utils/authCookies.ts`, the single source of truth for their attributes — login, signup, and the OIDC callback all call the same helpers rather than repeating the option blocks:

```ts
// setSessionCookie()
res.cookie(config.auth.cookies.sessionTokenName, sessionToken, {
  httpOnly: true,
  secure: req.secure,        // TLS-derived, NOT hardcoded true
  sameSite: 'lax',
  path: '/',
  maxAge: AUTH_COOKIE_MAX_AGE, // 7d, shared with the csrf cookie
});
```

`AUTH_COOKIE_MAX_AGE` is derived from `auth.jwt.refreshTokenExpiration` and **throws at startup** if that value is not a parseable positive duration: Express treats `maxAge: 0` as an immediate expiry, so a silent fallback would delete both auth cookies on every response and lock every user out.

CSRF cookie (`domains/auth/utils/authCookies.ts` — the single source of truth for its attributes): `httpOnly: false` (JS reads it for the double-submit header), `secure: req.secure`, `sameSite: 'strict'`, `maxAge` matching the session cookie (7d) so the pair lives and dies together — a browser restart no longer strands a valid session behind a missing csrf cookie. Default cookie names (`default.json:29-32`): `sessionToken`, `csrfToken`.

**Stable-token model** (`CsrfService.ensureToken`): a CSRF token identifies a *browser*, not a request. Every issue/render site (`GET /authenticate/csrf`, refresh, the connect-consent and confirm-account pages) **reuses a valid existing cookie** and only mints when the cookie is absent or invalid; rotation happens **only at identity boundaries** — login, signup, OIDC sign-in (fixation hygiene) — and logout clears it. This keeps all tabs and server-rendered forms converged on one token, so a background session refresh can never invalidate a page rendered earlier (the CI-Server#1740 race). CSRF failures on the no-JS consent/confirm forms self-heal with a one-shot 303 back to their GET (re-rendering against the current cookie). The retry is bounded by a `csrf_retry` marker: a second consecutive failure on the connect flow returns the user to CI-Hub with `error=csrf_failed` rather than stranding them, and a failure with no live session goes straight back to the Hub — `connect()` would otherwise bounce a signed-out user onward to the cross-origin OIDC issuer, which the gateway's `form-action 'self'` blocks mid-redirect-chain.

> **Why `secure: req.secure` (not `true`) matters — the plain-HTTP Tailscale case.** Because the flag mirrors the actual connection, cookies still set over plain HTTP (e.g. a `*.ts.net` exposure) rather than being dropped. Combined with `sameSite: 'lax'`, this is what makes Memory login work over unencrypted Tailscale: set `APP_BASE_URL` to the frontend origin, and the lax+non-secure cookie survives the round-trip.
>
> **`secure` depends on the gateway deriving the client's scheme.** `infrastructure/gateway/nginx.conf` listens plain on `8642`, so it used to set `proxy_set_header X-Forwarded-Proto $scheme` and overwrite whatever the edge put there. With `trust proxy 1` that made `req.secure` `false` on *every* request, including HTTPS ones — so `sessionToken` and `csrfToken`, both 7-day persistent, went out without `Secure` on an origin reached over TLS, readable (and writable, giving session/CSRF fixation) by any on-path attacker. The gateway now derives `$client_proto` and forwards *that*. Deployment testing on core-2 showed `X-Forwarded-Proto` alone is not enough: behind the Hub's Cloudflare tunnel the chain is Cloudflare → cloudflared → **Hub Traefik** → gateway, and Traefik overwrites `X-Forwarded-Proto` with its own plain-`http` entrypoint scheme, so it arrives as `http` on a genuine HTTPS request. Cloudflare's `CF-Visitor: {"scheme":"https"}` carries the true client scheme and survives that hop, so `$client_proto` **prefers `CF-Visitor`**, then a correctly-set `X-Forwarded-Proto` (first token, for a non-Cloudflare edge), then `$scheme` (a direct plain-HTTP LAN / Tailscale exposure, which keeps working unencrypted). Two consequences worth remembering: an appliance running an older gateway image still has the gap until it updates, and `resolveOidcOriginBounce` deliberately still compares host only for that reason.

#### Flows — `@Controller('authenticate')` (`SessionController.ts:35`)

| Endpoint | Method | Guard | Purpose |
|---|---|---|---|
| `/authenticate/csrf` | GET (204) | — | Ensure a `csrfToken` cookie (reuses a valid one; idempotent) |
| `/authenticate` | POST (200) | `CsrfGuard` | Login → session cookie + access token; **rotates** csrf |
| `/authenticate/refresh` | POST (200) | `CsrfGuard` | Rotate session token, return a new access token; **reuses** csrf (slides maxAge) |
| `/authenticate/logout` | POST (204) | `CsrfGuard` | Invalidate session, clear both cookies (client must send the double-submit header) |
| `/signup` | POST | `CsrfGuard` | Create account → session cookie + access token; **rotates** csrf |

**Session persistence** (`AuthService.ts:27-51`): the session row stores an **HMAC-SHA256 digest** of the token, IP, and user-agent (keyed by `auth.session.fieldPepper`) — the raw token is never stored. **Refresh with rotation + 30s grace window** (`AuthService.rotateSessionToken`): a valid refresh rotates the session token (old hash → `previous_token`); a token matching the *previous* hash within `session.refreshGracePeriod` yields a new access token without re-rotating, so racing tab refreshes don't invalidate each other.

```bash
# 1. Get a CSRF token (sets csrfToken cookie)
curl -c cookies.txt -i https://ci-memory.example.com/api/authenticate/csrf
# 2. Log in — double-submit the csrfToken value as X-CSRF-Token
CSRF=$(grep csrfToken cookies.txt | awk '{print $7}')
curl -b cookies.txt -c cookies.txt -H "Content-Type: application/json" \
  -H "X-CSRF-Token: $CSRF" \
  -d '{"username":"liam@ci.computer","password":"…"}' \
  https://ci-memory.example.com/api/authenticate
# → { "accessToken": "eyJ…" }   (sessionToken cookie also set)
# 3. Use the access token as a Bearer on GraphQL/REST
curl -H "Authorization: Bearer eyJ…" -H "Content-Type: application/json" \
  -d '{"query":"{ me { id email } }"}' https://ci-memory.example.com/api/graphql
```

### 1.2 API keys (programmatic clients)

Long-lived credentials for non-browser clients (CI-Import-Tools, CI-Connect, mobile App Intents, MCP clients). Passed in the **`x-api-key`** header.

- **Format:** 32 random bytes → 64 lowercase hex chars (`ApiKeyService.ts:13-14,26`). The strategy rejects anything not matching `/^[0-9a-f]{64}$/` before hitting the DB (`ApiKeyStrategy.ts`, `ApiKeyService.ts:105`).
- **Storage:** only a **SHA-256 hash** is stored (`ApiKeyService.hash`, `:129-131`); a 5-char `prefix` is stored clear for identification. The raw key is returned **once** at creation and never again.
- **Validation** (`ApiKeyService.validateKey`, `:104-127`): hash → look up by `hashed_key` → reject if expired → stamp `last_used_at` → return `{ userId }`.
- **Scopes:** a `text[]` column, settable at create/update, **stored/returned but not currently enforced** — an authenticated key acts with its owner's full user scope.

#### `/keys` management — `@Controller('keys')`, **every method `JwtAuthGuard`** (browser-session only; you cannot mint keys with a key)

| Endpoint | Method | Body | Result |
|---|---|---|---|
| `/keys` | POST | `{ name, scopes?, expires_at? }` | Creates key; returns metadata **plus the one-time raw `key`** |
| `/keys` | GET | — | List caller's keys (metadata only) |
| `/keys/:id` | GET/PATCH/DELETE(204) | `{ name?, scopes? }` | Read / update / revoke |

### 1.3 OIDC — "Sign in with CI-Portal"

Browser SSO via authorization-code + **PKCE (S256)**. IdP is **CI-Portal** at the configured issuer (interactive flow uses `oidc.issuerUrl` from `OIDC_ISSUER_URL`; observed authorize host `hub.companionintelligence.com`). CI-Server is a **public client** (`client_id: ci-server`, no secret — `OidcController.ts:171,250`). Controller `@Controller('authenticate/oidc')`, **unguarded** (pre-auth entry point).

| Endpoint | Method | Purpose |
|---|---|---|
| `/authenticate/oidc?redirect=<path>` | GET (302) | Set state/PKCE/redirect cookies, 302 to Portal authorize |
| `/authenticate/oidc/callback` | GET | Exchange code → tokens → userinfo → session |

**Initiate** (`OidcController.ts:118-180`): generate `state` + PKCE `verifier`/`challenge`; set three 10-min cookies — all `httpOnly`, `secure: req.secure`, **`sameSite: 'lax'`**: `oidc_state`, `oidc_pkce`, `oidc_redirect`; 302 to `<issuer>/api/auth/oauth2/authorize` with `client_id=ci-server`, `redirect_uri`, `scope=openid email profile`, `state`, `code_challenge`, `code_challenge_method=S256`.

> `sameSite: 'lax'` on the state/PKCE cookies is required: the browser returns from Portal via a top-level cross-site GET, and `lax` (unlike `strict`) sends cookies on that navigation. With `secure: req.secure`, this is why the flow also works over plain-HTTP Tailscale.

**Callback** (`OidcController.ts:185-359`): reject on `error`/missing/`state` mismatch; POST `<issuer>/api/auth/oauth2/token` (`grant_type=authorization_code` + PKCE `code_verifier`, no secret); GET `/userinfo` → `{ sub, email, name }`; **JIT-provision** the user by email (auto-create with random password; rejected as `signup_code_required` if the signup-code gate is on); issue **the same session + CSRF cookies as local login**; 302 to the validated `oidc_redirect`.

#### `redirect_uri` — `resolveOidcCallbackUrl` + `APP_BASE_URL`

Built by `resolveOidcCallbackUrl` (`domains/auth/utils/oidcCallbackUrl.ts:40-51`): **prefers `config.auth.oidc.publicBaseUrl`** (env **`APP_BASE_URL`**, injected by CI-Hub) → `<APP_BASE_URL>/api/authenticate/oidc/callback`; **falls back to the inbound request origin** (`X-Forwarded-Proto`/`Host`) for local installs. This pins the callback to the app's publicly reachable origin regardless of the inbound host — critical when the app is reached at its `*.localhost` Traefik route.

```
Browser                    CI-Server                         CI-Portal (IdP)
   │  GET /api/authenticate/oidc?redirect=/shared/abc            │
   ├──────────────────────────►│ set oidc_state/pkce/redirect    │
   │  302 → <issuer>/authorize?…code_challenge…                  │
   │◄──────────────────────────┤                                 │
   │  GET authorize?…  ─────────────────────────────────────────►│ (user auth)
   │  302 → <APP_BASE_URL>/api/authenticate/oidc/callback?code&state
   │◄────────────────────────────────────────────────────────────┤
   ├──────────────────────────►│ verify state; POST /token ─────►│
   │                           │ GET /userinfo ─────────────────►│
   │  302 → /shared/abc  ◄──────┤ JIT user, set session+csrf      │
```

### 1.4 (Optional) Portal-brokered bearer tokens

A migration path, **off by default** (`portal.enabled=false`, `PORTAL_OIDC_ENABLED`). When enabled, `JwtOrApiKeyAuthGuard` first verifies an `Authorization: Bearer` as a **Portal-issued JWT** (against the Portal JWKS) and JIT-provisions the user before falling back to the legacy `jwt`/`api-key` strategies (`JwtOrApiKeyAuthGuard.ts:28-46`). A separate Hub forward-auth path (HMAC-signed `X-CI-Hub-User`) also exists, off by default.

---

## 2. Guard model

CI-Server uses **per-controller guards**, not a global auth guard.

- **The only global guard is non-auth:** `IdFormatGuard` (`APP_GUARD`, `application.ts:103-106`) — a *format validator*, rejecting malformed id-shaped params before a handler runs. There is **no global auth `APP_GUARD`**.
- **No `@Public` decorator** exists — auth is opt-*in* per controller, so a route is unauthenticated simply by not declaring a guard. The pre-auth surface is exactly: `/health`, the `authenticate/*` + `signup` + `oidc/*` login endpoints, `/_internal/features/global`, and the `GET /graphql` playground.

### Guard inventory

| Guard | Extends | Accepts | Typical use |
|---|---|---|---|
| `JwtAuthGuard` | `AuthGuard('jwt')` | Access-token bearer only | `/keys`, `/onboarding`, `/_internal` |
| `ApiKeyGuard` | `AuthGuard('api-key')` | `x-api-key` only | `/memory` (agent write API) |
| `JwtOrApiKeyAuthGuard` | `AuthGuard(['jwt','api-key'])` (+ Portal) | Either credential | The default for most resolvers & REST controllers |
| `CsrfGuard` | `CanActivate` | double-submit CSRF token | login / signup / refresh |
| `IdFormatGuard` | `CanActivate` (global) | — | id-param format validation |

`JwtOrApiKeyAuthGuard` **precedence** (`:27-47`): (1) Portal token if enabled; else (2) the passport composite `['jwt','api-key']` — **`jwt` runs first** (Authorization bearer), then **`api-key`** (`x-api-key`). Any one success authenticates; none → `UnauthorizedException`. All passport guards override `getRequest` to unwrap **both HTTP and GraphQL** contexts, so the same guard works on REST controllers and GraphQL resolvers (`:49-68`).

### How `userId` reaches handlers — AsyncLocalStorage

User scoping flows through an **AsyncLocalStorage** request context (`ContextService`), not the request object:

1. `RequestContextMiddleware` opens a store with a fresh `traceId` (emitted as `X-Trace-Id`) per request.
2. On authentication, the strategy calls **`ContextService.set({ userId })`** (`JwtStrategy.ts:41-43`, `ApiKeyStrategy.ts:69-72`, Portal path `:38`) and sets `request.user`.
3. Handlers read it via the **`@Context()`** decorator → `RequestContext` (`{ traceId?, userId? }`).
4. **`toServiceContext(context)`** converts to `UserServiceContext`, throwing `UnauthorizedException` if `userId` is missing; services then constrain every query by `userId` (with a `SYSTEM_USER` bypass for internal/JIT ops). In the MCP path (no ALS store per JSON-RPC message), `userId` is read from `req.user` set by the guard.

---

## 3. CORS

**CORS is not configured anywhere** (`enableCors`/`cors(` = zero hits; the Apollo driver has no `cors` block). By design: the browser talks to the API **same-origin**, issuing relative `/api/*` requests that the fronting proxy forwards after stripping `/api`. No request is cross-origin, so no CORS headers/preflights are needed; the httpOnly `sessionToken` rides along automatically (`credentials: 'include'`).

> **Operational consequence:** exposing the API on a *different* origin than the SPA (e.g. hitting `:3030` directly from a browser app elsewhere) fails preflight — there is no CORS middleware to answer it. Programmatic clients (curl, importer, mobile) are unaffected — they authenticate with `x-api-key`/Bearer and aren't subject to same-origin policy.

---

## 4. Cross-cutting conventions

### 4.1 Request body limits

Nest's parser is off (`main.ts:11`); `BodyParserMiddleware` (on `*`) picks a size limit:

| Route | Limit | Why |
|---|---|---|
| `POST /graphql` (+ `/graphql/*`) | **`10mb`** | importer batch mutations (`BodyParserMiddleware.ts:19,55-57`) |
| `POST /v1/events` | **`10mb`** | CI-Applet perception snapshots ~1MB+ (`:29,58-59`) |
| route with `@BodyLimit(...)` | that value | per-route override (`:44-47`) |
| everything else | `100kb` | default (`:64`) |

The GraphQL/ingest limits are matched **by request path** (`req.baseUrl`/`originalUrl`), not `@BodyLimit` metadata, because Apollo is mounted via `app.use('/graphql', …)` so `req.route` is undefined there. **File uploads** use multipart in `FilesController` and bypass these JSON limits.

### 4.2 Validation — zod, not class-validator

Validation is **zod-based**; `class-validator`/`class-transformer` are **not dependencies**. There is no global `ValidationPipe` — a zod schema is passed per-handler: `@Body(new ValidationPipe(someSchema))`. A failed body validation returns **HTTP 400** with `{ message: "Validation failed", errors: [ …zod issues… ] }`, each carrying zod's `code`/`path`/`message`. The schemas double as the request DTO types.

### 4.3 Error response shape

`GlobalExceptionsFilter` (`APP_FILTER`) normalizes HTTP + GraphQL errors: `HttpException`s keep their status/payload; unknown errors become 500. Responses carry the `X-Trace-Id` header so a client can correlate a failure with server logs.

### 4.4 CSRF (double-submit)

`CsrfGuard` enforces a **signed double-submit cookie** on login/signup/refresh: it compares the `csrfToken` cookie against the `x-csrf-token` header (constant-time, HMAC-verified, token format `{randomHex}.{hmacHex}`). Failures throw `ForbiddenException`.

### 4.5 Provenance-triple idempotency convention

**Every bulk ingest path dedups on the provenance triple `(source_type, source_system, source_id)`** — the platform-wide idempotency key that lets the importer re-push without creating duplicates.

| Field | Meaning | Example |
|---|---|---|
| `source_type` | The *kind* of upstream record / ingest lane | `'capture'`, `'email'`, `'calendar'` |
| `source_system` | The connector / provider | `'gmail'`, `'google'`, `'takeout'` |
| `source_id` | The upstream record's stable natural key | the provider's message/event id |

The triple backs an `ON CONFLICT … DO NOTHING`/idempotent upsert, so a re-POST of a seen record is a no-op, not an error. Unified capture ingest is the canonical example (`EventsIngestController.ts:44-70`): an empty `RETURNING` means the row existed → counted as `duplicate`, downstream materialization skipped. The same convention governs the GraphQL batch-create mutations. Where a source provides no stable `source_id`, ingest falls back to a stable natural-key hash to avoid the "constant-filename items collapse to one hash and vanish" failure mode.

---

## 5. MCP surface

CI-Server exposes a **Model Context Protocol** server so agents (CI-Hermes, CI-OpenClaw, external MCP clients) get one memory-brain endpoint.

### 5.1 Endpoint, transport, identity

- **Path: root `/mcp`** — `@Controller('mcp')` (`McpController.ts:36`). Browser clients reach it at `/api/mcp` through the proxy; there is **no** separate `/api/mcp` controller.
- **Transport:** `StreamableHTTPServerTransport` (`@modelcontextprotocol/sdk`) — HTTP with an SSE stream for server→client notifications.
- **Server identity:** name **`companion-memory`**, version **`0.1.0`** (`McpServerService.ts:21-24`).
- **Auth:** class-guarded by **`JwtOrApiKeyAuthGuard`** — authenticate with an access-token Bearer **or** `x-api-key` (or a Portal token when enabled).

### 5.2 Session lifecycle (JSON-RPC over HTTP)

| Method | Behavior |
|---|---|
| `POST /mcp` | All JSON-RPC messages. An `initialize` body (no `Mcp-Session-Id`) creates a transport + `McpServer` and mints a session id; subsequent calls **must** send `Mcp-Session-Id` (`:53-117`) |
| `GET /mcp` | Opens the SSE stream for server notifications; requires `Mcp-Session-Id` (`:123-150`) |
| `DELETE /mcp` | Terminates a session (`:155-180`) |

Each session is bound to the authenticating `userId`; a session id from a *different* user is rejected. Idle sessions are reaped after **30 minutes** by a 5-minute cron.

```bash
# Initialize — server returns Mcp-Session-Id
curl -i -X POST https://ci-memory.example.com/api/mcp \
  -H "x-api-key: a1b2c…" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2025-06-18","capabilities":{},
        "clientInfo":{"name":"my-agent","version":"1.0"}}}'
# → header Mcp-Session-Id: <uuid>;  result.serverInfo = {name:"companion-memory",version:"0.1.0"}
```

### 5.3 Tools

Tools come from **two sources** (`McpToolService.ts:26-35`):

**(a) Auto-wrapped GraphQL CRUD.** `GraphQLToolAdapter` turns **every query field and every mutation field into an MCP tool** (`:59-86`); arg types → zod input schemas. Privacy labels: queries are `read`; mutations are `write`, flagged **`destructive` when the name starts with `delete`/`remove`/`destroy`/`purge`/`drop`** (`:34`). The tool count scales with the schema automatically.

**(b) Native curated intents** from the shared **`ToolRegistry`** (`@ci/domains/tools`) — dotted ids (e.g. `memory.recall`) exposed under an MCP-safe underscored name. A native name colliding with an auto-wrapped GraphQL tool is skipped.

Every tool is registered with standard MCP annotation hints derived from its privacy label (`McpServerService.ts:112-122`): `readOnlyHint`, `destructiveHint`, `openWorldHint`.

### 5.4 Resources

| Resource | URI | Content |
|---|---|---|
| GraphQL schema | `schema://graphql` | Full SDL (`printSchema`) for type/query/mutation discovery |
| Intent catalog | `intents://catalog` | `IntentCatalogService.getManifest()` — schema domains, entity types, curated privacy-labelled intents |

The intent catalog is also served over REST at `GET /api/intents` (behind `JwtOrApiKeyAuthGuard`), giving non-MCP agents the same capability declaration. Prefer the curated, typed, privacy-labelled catalog over raw CRUD.

---

## Summary

- **No server-side `/api` prefix and no CORS** — the SPA is same-origin behind a proxy that strips `/api`; a few controllers hardcode `api/` so their public URLs survive the rewrite.
- **Three credentials:** an in-memory access-token JWT sent as `Authorization: Bearer` (the only thing `JwtStrategy` reads, for REST *and* GraphQL); an httpOnly `sessionToken` cookie (`secure: req.secure` + `sameSite: lax`, so it survives plain-HTTP Tailscale) used *only* at `/authenticate/refresh` and `/logout`; and `x-api-key` keys stored as SHA-256 hashes. OIDC ends by minting the same session cookie, with JIT provisioning and a `redirect_uri` pinned to `APP_BASE_URL`.
- **Auth is per-controller** (`JwtAuthGuard` / `ApiKeyGuard` / `JwtOrApiKeyAuthGuard`), not global; there is no `@Public` decorator and the only global guard is the non-auth `IdFormatGuard`. `userId` propagates via AsyncLocalStorage and is enforced by `toServiceContext`.
- **Conventions:** zod validation (no class-validator), 10mb body limit for `/graphql` and `/v1/events` (100kb otherwise), trace-id error envelopes, and a platform-wide `(source_type, source_system, source_id)` provenance-triple idempotency key.
- **MCP** lives at root `/mcp` (`companion-memory` v0.1.0) over `StreamableHTTPServerTransport`, authenticated by `JwtOrApiKeyAuthGuard`, exposing every GraphQL query/mutation as a privacy-labelled tool plus native curated intents, and the `schema://graphql` + `intents://catalog` resources.

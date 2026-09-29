# CI-Server API — Authentication, Conventions & MCP Surface

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

Reference documentation for the CI-Server NestJS API: its authentication mechanisms, the guard model, cross-cutting request conventions, and the Model Context Protocol (MCP) surface. The GraphQL surface is in [graphql.md](graphql.md); the REST controllers in [rest.md](rest.md).

All citations are `path:line` against `backend/apps/api/src`.

---

## 0. Bootstrap & routing at a glance

A single NestJS 11 process listening on `config.host:config.port` (default `0.0.0.0:3030`; `config/default.json:2-3`).

Bootstrap (`main.ts`) is deliberately thin. It has two entry points selected by `processRole()`: `bootstrapWorker()` builds the same module graph as an **application context with no HTTP server** (the queue/cron worker), and `bootstrapWeb()` is the API server described here.

- `bodyParser: false` — Nest's built-in parser is disabled (`main.ts:33`); body parsing is delegated to `BodyParserMiddleware` so per-route size limits apply (see [§4.1](#41-request-body-limits)).
- `cookieParser()` is installed globally (`main.ts:39`) so `req.cookies` is populated for the session/CSRF/OIDC flows.
- `app.enableCors({...})` (`main.ts:53-60`) — a **narrow** allowlist for the native webview origins, not a wildcard. See [§3](#3-cors).
- `express.set('trust proxy', 1)` (`main.ts:62`) — required so `req.secure`, `req.ip`, and `X-Forwarded-*` reflect the fronting proxy (Hub Traefik / Portal Cloudflare tunnel), which drives the `secure` cookie flag and the OIDC callback origin. `express.disable('x-powered-by')` follows on `:63`.
- `server.requestTimeout = 0` (`main.ts:83`) — Node's default 300 s *total* request lifetime killed multi-gigabyte `POST /import/uploads` parts with a 408. `headersTimeout` is deliberately left at its default (it is the half that defends against slow-header attacks).

**There is no server-side global prefix.** `setGlobalPrefix` is never called. Controllers mount at their bare decorator paths — it is `POST /authenticate`, not `/api/authenticate`. The `/api` segment browsers use is stripped by the frontend proxy before the request reaches Nest (`frontend/apps/web/vite.config.ts:149-157`, `rewrite: p => p.replace(/^\/api/, '')`).

> ⚠️ **Exceptions:** three controllers hardcode `api/` *into their own path* so the public URL survives the proxy rewrite — `@Controller(['api/intents', 'api/agent/intents'])`, `@Controller('api/maintenance')` and `@Controller('api/pipeline')`. The OIDC callback likewise hardcodes `/api/authenticate/oidc/callback` in the `redirect_uri` (`domains/auth/utils/oidcCallbackUrl.ts:1`) because that URL must be reachable *through* the proxy from the outside. Do not "fix" these to bare paths.

Global cross-cutting wiring lives in the root module (`application.ts`):

| Concern | Registration | Location |
|---|---|---|
| Request-context (AsyncLocalStorage) | `RequestContextMiddleware` on `*` | `application.ts:171` |
| Body parsing + size limits | `BodyParserMiddleware` on `*` | `application.ts:172` |
| Request logging | `RequestLoggerMiddleware` on `*` | `application.ts:173` |
| ID-format validation | `IdFormatGuard` as `APP_GUARD` (global) | `application.ts:155-158` |
| Error normalization | `GlobalExceptionsFilter` as `APP_FILTER` (global) | `application.ts:159-162` |

Note what is **not** global: there is **no global authentication guard**.

---

## 1. Authentication mechanisms

Four credential types. Two are user-facing (session cookies for the browser SPA, API keys for programmatic clients); OIDC is a browser sign-in flow that mints a session cookie; the fourth, Portal-brokered bearer tokens, was a migration path and is now **enabled by default** (see [§1.4](#14-portal-brokered-bearer-tokens-on-by-default)).

### 1.1 JWT session cookies (browser SPA)

The web app authenticates with **two separate JWTs**, each with a distinct job. They are never bridged — this is the single most important fact about the browser auth model.

| Credential | Kind | Lifetime | Where it lives | Secret | Sent as |
|---|---|---|---|---|---|
| **Access token** | JWT | `5m` (`default.json:17`) | In-memory React state — never a cookie/localStorage | `authTokenSecret` | `Authorization: Bearer <token>` |
| **Session token** | JWT | `7d` (`default.json:20`) | httpOnly cookie `sessionToken` | `refreshTokenSecret` | Cookie, automatically same-origin |

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

CSRF cookie (`domains/auth/utils/authCookies.ts` — the single source of truth for its attributes): `httpOnly: false` (JS reads it for the double-submit header), `secure: req.secure`, `sameSite: 'strict'`, `maxAge` matching the session cookie (7d) so the pair lives and dies together — a browser restart no longer strands a valid session behind a missing csrf cookie. Default cookie names (`default.json:32-35`): `sessionToken`, `csrfToken`.

**Stable-token model** (`CsrfService.ensureToken`): a CSRF token identifies a *browser and its principal*, not a request. Every issue/render site (`GET /authenticate/csrf`, refresh, the connect-consent and confirm-account pages) **reuses a valid existing same-scope cookie** and only mints when the cookie is absent, invalid, or bound to a different principal; rotation happens **only at identity boundaries** — login, signup, OIDC sign-in (fixation hygiene) — and logout clears it. This keeps all tabs and server-rendered forms converged on one token, so a background session refresh can never invalidate a page rendered earlier (the CI-Server#1740 race). CSRF failures on the no-JS consent/confirm forms self-heal with a one-shot 303 back to their GET (re-rendering against the current cookie). The retry is bounded by a `csrf_retry` marker: a second consecutive failure on the connect flow returns the user to CI-Hub with `error=csrf_failed` rather than stranding them, and a failure with no live session goes straight back to the Hub — `connect()` would otherwise bounce a signed-out user onward to the cross-origin OIDC issuer, which the gateway's `form-action 'self'` blocks mid-redirect-chain.

**Principal binding** (token v2): the token format is `{scope}.{randomHex64}.{hmacHex64}`, where `scope` is the **session id** the token was minted under (the session JWT's `sid` claim, also the `SessionEntity` primary key) or the literal `anon` for a pre-auth mint; the HMAC covers `scope + "\n" + random`, so the scope segment cannot be re-labelled. Validation resolves the request's scope from the session cookie (`AuthService.resolveCsrfScope` — signature-checked but **expiry-ignored**, since the scope identifies the *minting* principal and expiry says nothing about that; session validity is still enforced where sessions are consumed, so an expired cookie on `/authenticate/refresh` ends in a 401 either way. Ignoring expiry here only fixes the ORDER of failure: otherwise an expired or clock-skewed cookie resolves to the anonymous scope, its session-bound token is rejected first, and the 403 spends the SPA's one-shot CSRF retry on a token that was never the problem) and, after the unchanged double-submit checks (presence → type → cookie↔header equality → HMAC), requires token scope === request scope:

| Request context | Token scope | Result |
|---|---|---|
| anonymous | `anon` | accept |
| anonymous | session-bound | 403 (`bound-token-on-anon-request`) |
| session A | `anon` | 403 (`anon-token-on-authed-session`) |
| session A | session A | accept |
| session A | session B | 403 (`session-mismatch`) |

A harvested or fixated token therefore dies at the first principal boundary it crosses. Legacy 2-segment (v1) tokens fail validation and self-heal: any ensure site re-mints them, and legacy `sid`-less session JWTs count as anonymous until their first refresh rotation embeds the `sid` (the same response's ensure upgrades the CSRF cookie to match). Rejections surface as `CsrfValidationError` (a `ForbiddenException` carrying a machine-readable `reason`), logged by `CsrfGuard` without token values or session ids.

> **Why `secure: req.secure` (not `true`) matters — the plain-HTTP Tailscale case.** Because the flag mirrors the actual connection, cookies still set over plain HTTP (e.g. a `*.ts.net` exposure) rather than being dropped. Combined with `sameSite: 'lax'`, this is what makes Memory login work over unencrypted Tailscale: set `APP_BASE_URL` to the frontend origin, and the lax+non-secure cookie survives the round-trip.
>
> **`secure` depends on the gateway deriving the client's scheme.** `infrastructure/gateway/nginx.conf` listens plain on `8642`, so it used to set `proxy_set_header X-Forwarded-Proto $scheme` and overwrite whatever the edge put there. With `trust proxy 1` that made `req.secure` `false` on *every* request, including HTTPS ones — so `sessionToken` and `csrfToken`, both 7-day persistent, went out without `Secure` on an origin reached over TLS, readable (and writable, giving session/CSRF fixation) by any on-path attacker. The gateway now derives `$client_proto` and forwards *that*. Deployment testing on core-2 showed `X-Forwarded-Proto` alone is not enough: behind the Hub's Cloudflare tunnel the chain is Cloudflare → cloudflared → **Hub Traefik** → gateway, and Traefik overwrites `X-Forwarded-Proto` with its own plain-`http` entrypoint scheme, so it arrives as `http` on a genuine HTTPS request. Cloudflare's `CF-Visitor: {"scheme":"https"}` carries the true client scheme and survives that hop, so `$client_proto` **prefers `CF-Visitor`**, then a correctly-set `X-Forwarded-Proto` (first token, for a non-Cloudflare edge), then `$scheme` (a direct plain-HTTP LAN / Tailscale exposure, which keeps working unencrypted). Two consequences worth remembering: an appliance running an older gateway image still has the gap until it updates, and `resolveOidcOriginBounce` deliberately still compares host only for that reason.

#### Flows — `@Controller('authenticate')` (`SessionController.ts:37`)

| Endpoint | Method | Guard | Purpose |
|---|---|---|---|
| `/authenticate/csrf` | GET (200) | — | Ensure a `csrfToken` cookie scoped to the caller's principal (reuses a valid same-scope one; idempotent) **and return the token in the body as `{ csrfToken }`** (`SessionController.ts:54-71`) — a cookie-less native client reads it here and echoes it as `x-csrf-token` |
| `/authenticate` | POST (200) | `CsrfGuard` | Login → session cookie + access token; **rotates** csrf, bound to the new session |
| `/authenticate/refresh` | POST (200) | `CsrfGuard` | Rotate session token, return a new access token; **reuses** csrf (slides maxAge; re-binds a legacy anon token to the session) |
| `/authenticate/logout` | POST (204) | `CsrfGuard` | Invalidate session, clear both cookies (client must send the double-submit header) |
| `/signup` | POST | `CsrfGuard` | Create account → session cookie + access token; **rotates** csrf, bound to the new session |

**Session persistence** (`AuthService.ts:33-58`): the session row stores an **HMAC-SHA256 digest** of the token, IP, and user-agent (keyed by `auth.session.fieldPepper`) — the raw token is never stored. **Refresh with rotation + 30s grace window** (`AuthService.rotateSessionToken`): a valid refresh rotates the session token (old hash → `previous_token`); a token matching the *previous* hash within `session.refreshGracePeriod` yields a new access token without re-rotating, so racing tab refreshes don't invalidate each other.

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

Long-lived credentials for non-browser clients (the native iOS/Android shells and their App Intents, Companion Capture, CI-Hermes / CI-OpenClaw, CI-Mentra smart glasses (memory-scoped), MCP clients). Passed in the **`x-api-key`** header, or as **`Authorization: Bearer <key>`**.

The bearer form exists for MCP clients: most expose a single bearer-token field and cannot send a custom header, which made `/api/mcp` unreachable for them. It also removes a gratuitous difference from the Hub, whose MCP surface is bearer-only. The scheme is matched case-insensitively per RFC 7235 §2.1 (`bearer` works). The two in-process readers — `ApiKeyStrategy` and `JwtOrApiKeyAuthGuard`'s Portal path — share one `extractBearerToken` helper so they cannot drift; the third reader is `passport-jwt`, which does its own parse and has always lowercased the scheme (`extract_jwt.js:54,60`). `x-api-key` wins if both are present — unless it is blank, in which case the bearer form is used, so a proxy that always sets the header cannot mask a good credential. This does not shadow session auth — on `JwtOrApiKeyAuthGuard` the `jwt` strategy consumes bearer JWTs first, and a JWT that reached the api-key strategy would fail the 64-hex format check before any DB lookup.

- **Format:** 32 random bytes → 64 lowercase hex chars (`ApiKeyService.ts:26-29,46`). The strategy rejects anything not matching `^[0-9a-f]{64}$` before hitting the DB (`ApiKeyStrategy.ts:28`, `ApiKeyService.ts:364-366`).
- **Storage:** only a **SHA-256 hash** is stored (`ApiKeyService.hash`, `:400`); a 5-char `prefix` is stored clear for identification. The raw key is returned **once** at creation and never again.
- **Validation** (`ApiKeyService.validateKey`, `:361-398`): hash → look up by `hashed_key` → reject if expired → stamp `last_used_at` → return `{ keyId, userId, scopes, capability }`. `keyId` matters because two keys of the same user can hold identical scopes, and anything binding state to a caller's authority (MCP sessions) needs the key itself.

**Two independent authorization axes.** `scopes` say *which surface* a key opens; `capability` says *what it may do* there.

- **Scopes** — a `text[]` column, settable at create/update, **enforced deny-by-default** (`common/guards/apiKeyScopeEnforcement.ts`, called from inside `JwtOrApiKeyAuthGuard.canActivate:53-58` and `ApiKeyGuard` once the strategy has populated `req.apiKeyScopes`; there is no standalone `ScopesGuard` any more). A scope-limited key may reach a route **only** if the route declares `@RequireScopes` and the key holds every scope listed; anywhere else it is refused with `ForbiddenException`. An **empty** `scopes` array is the grandfathered full-authority case. The four canonical values (`common/decorators/RequireScopes.ts:26-29`) are:

  | Scope | Opens |
  |---|---|
  | `memory` | the agent `/memory/*` endpoints and `/v1/intelligence/*` |
  | `intents` | the intent catalog + execute routes (`/api/intents`, `/api/agent/intents`) and the native intents exposed over MCP |
  | `mcp` | the Model Context Protocol endpoint (`POST/GET/DELETE /mcp`) |
  | `capture` | the observation write plane: the `/v1/*` bulk-ingest routes and `POST /files/upload` |

- **Capability** — `'read' | 'write' | 'full'` (`common/decorators/ApiKeyCapability.ts:19-25`), ascending authority: `read` = nothing it can call changes stored data; `write` = read + mutating but never deleting; `full` = including destructive tools. The default on create is **`write`** (`DEFAULT_API_KEY_CAPABILITY`, `:35`) — `read` would break "create a key, connect an agent", `full` would silently hand every new key delete authority. A stored value that does not parse coerces to `read`, not the default: an authority we cannot read is the smallest one (`coerceApiKeyCapability`, `:50`). **Enforced on every operation a key can reach** (`enforceApiKeyCapability`): a route that declares `@RequireCapability` requires that level; one that declares nothing requires what its shape implies — a GraphQL mutation or non-GET verb `write`, a query or GET `read` (`capabilityImpliedByShape`). Before 2026-09-24 it was opt-in per route, and no GraphQL resolver opted in, so a `read` key could run every mutation. Routes declare a floor with `@RequireCapability`, enforced by `enforceApiKeyCapability` next to the scope check.

#### `/keys` management — `@Controller('keys')`, **every method `JwtOrPortalAuthGuard`** (`ApiKeyController.ts:86-153`)

A browser session JWT **or** a CI-Portal OIDC bearer (Companion Capture trades its short-lived `id_token` for a durable key at sign-in) — but **never an API key**, so a leaked key cannot mint successors that outlive its revocation.

| Endpoint | Method | Body | Result |
|---|---|---|---|
| `/keys` | POST | `{ name, scopes?, capability?, expires_at? }` | Creates key; returns metadata **plus the one-time raw `key`** |
| `/keys` | GET | — | List caller's keys (metadata only) |
| `/keys/:id` | GET/PATCH/DELETE(204) | `{ name?, scopes?, capability? }` | Read / update / revoke |

`capability` is optional on **both** verbs (`createApiKeySchema` / `updateApiKeySchema`, `ApiKeyController.ts:62-78`): omitting it means *the default* on create and *unchanged* on update — never a silent reset. `scopes` is validated against the four canonical names, so a typo 400s at the door rather than minting a key that authenticates and is then refused everywhere.

### 1.3 OIDC — "Sign in with CI-Portal"

Browser SSO via authorization-code + **PKCE (S256)**. IdP is **CI-Portal** at the configured issuer (interactive flow uses `oidc.issuerUrl` from `OIDC_ISSUER_URL`; observed authorize host `hub.companionintelligence.com`). CI-Server is a **public client** (`client_id: ci-server`, no secret — `OidcController.ts:272,369`). Controller `@Controller('authenticate/oidc')` (`OidcController.ts:136`), **unguarded** (pre-auth entry point).

| Endpoint | Method | Purpose |
|---|---|---|
| `/authenticate/oidc?redirect=<path>&client=<client>` | GET (302) | Set state/PKCE/redirect/client cookies, 302 to Portal authorize |
| `/authenticate/oidc/callback` | GET | Exchange code → tokens → userinfo → session (or, for the native client, a deep link carrying a one-time code; or a bounce to `confirm-account` for a first-time sign-in) |
| `/authenticate/oidc/native/exchange` | POST (200) | **Native only, unauthenticated by design.** Redeem the single-use ~2-minute code delivered by the `<scheme>://oidc/callback?code=…` deep link for an access token: `{ code }` → `{ accessToken }`. The app then trades that JWT for a durable API key. Redeeming invalidates the code, so it is replay-safe (`OidcController.ts:484-499`) |
| `/authenticate/oidc/confirm-account` | GET / POST | First-time sign-in confirmation page and its no-JS same-origin form POST. Reads the signed signup-intent cookie set by the callback; CSRF failures self-heal with a 303 back to the GET (`:506`, `:566`) |

The deep-link scheme for the native flow comes from `auth.oidc.nativeRedirectScheme` (default `companion`, `OidcController.ts:151`).

**Initiate** (`OidcController.ts:184-281`): generate `state` + PKCE `verifier`/`challenge`; set up to four 10-min cookies — all `httpOnly`, `secure: req.secure`, **`sameSite: 'lax'`**: `oidc_state` (`:228`) and `oidc_pkce` (`:236`) unconditionally, `oidc_client` only when `client=native` (`:246-253`), and `oidc_redirect` only when a safe relative `redirect` was supplied — with no redirect that cookie is *cleared* instead, so a plain sign-in cannot inherit a previous attempt's destination (`:258-268`); 302 to `<issuer>/api/auth/oauth2/authorize` with `client_id=ci-server`, `redirect_uri`, `scope=openid email profile`, `state`, `code_challenge`, `code_challenge_method=S256`.

> `sameSite: 'lax'` on the state/PKCE cookies is required: the browser returns from Portal via a top-level cross-site GET, and `lax` (unlike `strict`) sends cookies on that navigation. With `secure: req.secure`, this is why the flow also works over plain-HTTP Tailscale.

**Callback** (`OidcController.ts:286-474`): reject on `error`/missing/`state` mismatch; POST `<issuer>/api/auth/oauth2/token` (`grant_type=authorization_code` + PKCE `code_verifier`, no secret); GET `/userinfo` → `{ sub, email, name, email_verified }`; resolve the Portal identity to a local account — an established `(iss, sub)` binding wins; else a **verified** email links a not-yet-bound local account exactly once (an unverified address, or an account already bound to another identity, is refused as `email_unverified` / `account_linked_elsewhere` and the flow stops there); else it is a first-time sign-in, admitted only on an unclaimed appliance, by Hub invitation, or with a signup code (`signup_code_required` otherwise, when the gate is on). First-time web sign-ins bounce through `confirm-account`, whose intent cookie carries the `(iss, sub)` so the account it creates is bound at birth; it refuses (`account_exists`) if an account for the address appeared meanwhile, unless that account is already bound to this very identity (a concurrent tab); issue **the same session + CSRF cookies as local login**; 302 to the validated `oidc_redirect`.

#### `redirect_uri` — `resolveOidcCallbackUrl` + `APP_BASE_URL`

Built by `resolveOidcCallbackUrl` (`domains/auth/utils/oidcCallbackUrl.ts:41-49`): **prefers `config.auth.oidc.publicBaseUrl`** (env **`APP_BASE_URL`**, injected by CI-Hub) → `<APP_BASE_URL>/api/authenticate/oidc/callback`; **falls back to the inbound request origin** (`X-Forwarded-Proto`/`Host`) for local installs. This pins the callback to the app's publicly reachable origin regardless of the inbound host — critical when the app is reached at its `*.localhost` Traefik route.

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

### 1.4 Portal-brokered bearer tokens (on by default)

`auth.portal.enabled` is **`true`** in the shipped configuration (`config/default.json:79-84`), with issuer `https://hub.ci.computer`, `jwksUri` `https://hub.ci.computer/api/auth/jwks`, and the audience allowlist `ci-server,ci-hub,ci-import-tools,ci-browser-extension,ci-even,ci-applet`. That allowlist is a contract detail: a token whose `aud` is not on it does not authenticate.

When enabled, `JwtOrApiKeyAuthGuard` first verifies an `Authorization: Bearer` as a **Portal-issued JWT** (against the Portal JWKS) and resolves it to a local user before falling back to the legacy `jwt`/`api-key` strategies (`JwtOrApiKeyAuthGuard.ts:30-46`). A Portal principal carries full user authority and no API-key scopes, so scope/capability enforcement does not apply on that path.

**That check is bounded, so a Portal outage cannot hang the API.** It runs before the local strategies on every bearer request, so it must never wait on the network indefinitely (`PortalTokenService.verifyPortalJwt`):

- A bearer whose protected-header `alg` is not asymmetric — notably the web app's own HS256 session JWT — cannot verify against a public-key set, so it skips the Portal entirely and no JWKS is fetched.
- The JWKS fetch times out after 3 s (`PORTAL_JWKS_FETCH_TIMEOUT_MS`), and the whole verification is capped at 5 s (`PORTAL_VERIFY_TIMEOUT_MS`). On the cap the token is treated as "not a Portal token", a `warn` is logged, the request falls through to the legacy strategies, and the cached JWKS set is discarded so the next request starts a fresh fetch.

The cap exists because jose's remote key set shares one in-flight fetch across all callers: on 2026-09-28 a single fetch that never settled made every bearer-authenticated route hang until the API process was restarted, while api-key, cookie and unauthenticated routes stayed fast. A Portal token presented while the Portal is unreachable now gets a 401 within 5 s instead.

**Who this path admits** (`PortalTokenService.provisionUser`): a Portal identity already bound to a local account, or a verified email that links a not-yet-bound local account exactly once — and, in one case only, an identity nobody here has bound: when the appliance has **no accounts at all**, the sign-in claims it and becomes the owner/admin. On a claimed appliance an unbound Portal identity gets a 401, full stop. The model is one Portal identity per appliance (the owner); household members are email-and-password accounts the owner invites through the browser flow, which is where invitations are checked. Until 2026-09-24 this path created an account for *any* valid Portal token, which on a tunnelled Hub install meant anyone with a Portal login could sign up.

Three other server-to-server credentials exist alongside it:

- **Python sidecar run tokens** — the HBPE and Summary sidecars used to hold `AUTH_TOKEN_SECRET` and self-sign a user token for whatever `user_id` a run named, so a compromised sidecar could act as any user. Now the dispatcher (`PythonFunctionDispatchListener`) mints one token per run (`PythonFunctionTokenService.issueRunToken`): a real access token signed with the same secret `JwtStrategy` verifies, so the sidecar's GraphQL calls work as that job's user, but carrying `purpose: python_run`, the job id and the queue, and expiring shortly after its queue would expire the job (the queue's pg-boss `expireInSeconds` plus 15 minutes, not the global 2 h `jobTimeoutSeconds` — 8 h 15 min for `py-fn-hbpe`, whose backlogged nightly runs past 3 h). The sidecar echoes it on `POST /function-runs/callback`, where `PythonRunCallbackGuard` verifies it and the controller refuses any body naming a different job. In the other direction every request the API makes to a sidecar carries `Authorization: Bearer <SIDECAR_AUTH_SECRET>` (`common/sidecar/sidecarAuth.ts`), a shared secret `setup-secrets` mints, and the sidecars' middleware refuses requests without it (only `/health` is exempt).
- **Hub forward-auth** — an HMAC-signed `X-CI-Hub-User` header verified by `HubForwardAuthGuard`, which **fails closed** while `auth.hubForwardAuth.enabled` is false (the default). Only route: `GET /audit/forward-auth/whoami`.
- **Hub connect S2S** — `ConnectRequestAuthGuard` (`domains/auth/guards/ConnectRequestAuthGuard.ts`), an HMAC-signed request with nonce replay protection, on `POST /connect/{exchange,revoke,rotate}`. It is how CI-Hub swaps a one-time consent code for the raw scoped key it just minted, and how it later revokes or rotates that key. It reads the **same** `auth.hubForwardAuth.{enabled,secret}` block as the forward-auth guard above and **fails closed the same way**: while `enabled` is false — the shipped default (`config/default.json:86-87`) — `canActivate` throws `UnauthorizedException('Hub forward-auth verification is not enabled on this server')` before any signature check (`ConnectRequestAuthGuard.ts:41-46`). So both of these S2S credentials are 401 until an operator turns that one flag on and sets the shared secret. (The replay window is the connect-specific `DEFAULT_CONNECT_MAX_SKEW_MS` = 60s, deliberately *not* the larger shared `hubForwardAuth.maxSkewMs`.)

**Peer asks** are a fourth, deliberately separate case: `POST /agent/v1/ask` declares **no guard at all** and verifies the calling peer's Portal token *claims only* (`verifyClaims`, never `verifyAndProvision` — a peer must not become a local account). It additionally requires `peers.audience` to be configured and 503s without it.

---

## 2. Guard model

CI-Server uses **per-controller guards**, not a global auth guard.

- **The only global guard is non-auth:** `IdFormatGuard` (`APP_GUARD`, `application.ts:155-158`) — a *format validator*, rejecting malformed id-shaped params before a handler runs. There is **no global auth `APP_GUARD`**.
- **No `@Public` decorator** exists — auth is opt-*in* per controller, so a route is unauthenticated simply by not declaring a guard.

**The pre-auth surface** (no auth guard on the route; several are gated some other way):

| Route | Why it is open |
|---|---|
| `GET /health` | liveness probe |
| `GET /_internal/features/global` | gates the SPA before login — answers with the `PUBLIC_FEATURES` allowlist only, not the full flag map |
| `GET /config/telemetry` | the SPA needs the Sentry DSN before it has a session. *(Its sibling `GET /config/maps` **is** guarded.)* |
| `authenticate/*`, `/signup` | login/refresh/logout + CSRF issue — `CsrfGuard` where it applies, but no auth guard |
| `authenticate/oidc/*` | the whole OIDC entry point, including `POST native/exchange` (the one-time code *is* the proof) and `GET`/`POST confirm-account` |
| `GET /connect` | renders the consent hop; bounces through OIDC when signed out |
| `POST /connect/approve` | the consent form's submit — the mutating half of the same hop, and equally guardless (`ConnectController.ts:284`). Gated inline instead: a return-URL origin allowlist (`:290-292`) and a signed double-submit CSRF token from the hidden form field (`:305-309`) |
| `GET /graphiql` | the GraphiQL IDE page (static HTML; the user pastes their own key into it) |
| `GET /solid/profile/:userId` | a WebID document must be world-dereferenceable; gated only by the `solid.protocol` flag, which is off by default |
| `POST /agent/v1/ask` | authenticates a *peer*, not a local user — verifies Portal claims inline |

> Note there is **no** `GET /graphql` playground any more: `playground: false` **and** `graphiql: false` on the Apollo driver, and the IDE is a separate `GET /graphiql` route (`domains/graphql/controllers/GraphQLController.ts`).

### Guard inventory

| Guard | Extends | Accepts | Typical use |
|---|---|---|---|
| `JwtAuthGuard` | `AuthGuard('jwt')` | Access-token bearer only | `/onboarding` (`OnboardingController.ts:19,25,34`), `/_internal/features` (`common/feature/controllers/FeatureController.ts:11`), and the GraphQL `UserSnapshotResolver` (`domains/graphql/resolvers/UserSnapshotResolver.ts:12`) — those three are its entire use |
| `ApiKeyGuard` | `AuthGuard('api-key')` (+ scope/capability enforcement) | `x-api-key` or `Authorization: Bearer <key>` | the agent `/memory/*` routes |
| `JwtOrApiKeyAuthGuard` | `AuthGuard(['jwt','api-key'])` (+ Portal, + scope/capability enforcement) | Any of the three | The default for most resolvers & REST controllers |
| `JwtOrPortalAuthGuard` | `AuthGuard('jwt')` (+ Portal) | Session JWT **or** Portal bearer — never an API key | all five `/keys` routes |
| `CsrfGuard` | `CanActivate` | double-submit CSRF token, or a header-only token from a cookie-less native client | login / refresh / logout / signup — and **only** those four (`SessionController.ts:75,109,161`, `SignupController.ts:35`). The no-JS forms verify CSRF inline instead, see [§4.4](#44-csrf-double-submit) |
| `HubForwardAuthGuard` | `CanActivate` | HMAC-signed `X-CI-Hub-User`; **fails closed** when disabled | `GET /audit/forward-auth/whoami` |
| `ConnectRequestAuthGuard` | `CanActivate` | HMAC-signed Hub S2S request with nonce replay protection; **fails closed** on the same `auth.hubForwardAuth.enabled` flag (false by default) | `POST /connect/{exchange,revoke,rotate}` |
| `IdFormatGuard` | `CanActivate` (global) | — | id-param format validation |

`JwtOrApiKeyAuthGuard` **precedence** (`:27-62`): (1) Portal token if enabled; else (2) the passport composite `['jwt','api-key']` — **`jwt` runs first** (Authorization bearer), then **`api-key`** (`x-api-key`, or a bearer value the `jwt` strategy rejected). Any one success authenticates; none → `UnauthorizedException`. On success it then runs `enforceApiKeyScopes` and `enforceApiKeyCapability` (`:53-58`) — enforcement must happen *here*, after the strategy has populated `req.apiKeyScopes`, which is why the old standalone `ScopesGuard` was removed rather than made global. All passport guards override `getRequest` to unwrap **both HTTP and GraphQL** contexts, so the same guard works on REST controllers and GraphQL resolvers (`:64-83`).

### How `userId` reaches handlers — AsyncLocalStorage

User scoping flows through an **AsyncLocalStorage** request context (`ContextService`), not the request object:

1. `RequestContextMiddleware` opens a store with a fresh `traceId` (emitted as `X-Trace-Id`) per request.
2. On authentication, the strategy calls **`ContextService.set({ userId })`** (`JwtStrategy.ts:41`, `ApiKeyStrategy.ts:99`, Portal path `JwtOrApiKeyAuthGuard.ts:38`) and sets `request.user`.
3. Handlers read it via the **`@Context()`** decorator → `RequestContext` (`{ traceId?, userId? }`).
4. **`toServiceContext(context)`** converts to `UserServiceContext`, throwing `UnauthorizedException` if `userId` is missing; services then constrain every query by `userId` (with a `SYSTEM_USER` bypass for internal/JIT ops). In the MCP path (no ALS store per JSON-RPC message), `userId` is read from `req.user` set by the guard.

---

## 3. CORS

**CORS is configured, but as a narrow allowlist — never a wildcard** (`main.ts:53-60`):

```ts
app.enableCors({
  origin: [...nativeAppOrigins, ...config.cors.allowedOrigins],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-API-Key'],
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
});
```

The web app still talks to the API **same-origin**, issuing relative `/api/*` requests that the fronting proxy forwards after stripping `/api` — none of those are cross-origin and none need CORS. The allowlist exists for the **native Capacitor shells**, whose webviews serve from a different origin: `capacitor://localhost` (iOS) and `http(s)://localhost` / `ionic://localhost` (Android). Operators extend it with the comma-separated `CORS_ALLOWED_ORIGINS` env var (`config.cors.allowedOrigins`, empty by default).

> **Operational consequence:** exposing the API on some *other* origin than the SPA (e.g. hitting `:3030` directly from a browser app elsewhere) still fails preflight unless that origin is added to `CORS_ALLOWED_ORIGINS`. Programmatic clients (curl, importer, native code paths) are unaffected — they authenticate with `x-api-key`/Bearer and aren't subject to same-origin policy.

---

## 4. Cross-cutting conventions

### 4.1 Request body limits

Nest's parser is off (`main.ts:33`); `BodyParserMiddleware` (on `*`) picks a size limit:

| Route | Limit | Why |
|---|---|---|
| `POST /graphql` (+ `/graphql/*`) | **`10mb`** | importer batch mutations (`BodyParserMiddleware.ts:19-20,76-77`) |
| the whole **`/v1/*`** plane | **`10mb`** | Companion Capture perception snapshots ~1MB+, and `{records: […]}` envelopes up to 10,000 records (`:33-34,78`) |
| `/v1/*` with `Content-Type: application/x-ndjson` | **no limit — middleware bypassed entirely**, raw unconsumed stream handed to the handler (`:85-87`) | unbounded NDJSON streams; a 1 MB per-line ceiling is enforced downstream in `domains/ingest/ndjson.ts:40` |
| route with `@BodyLimit(...)` | **nothing — the metadata is never read at runtime**, so the route falls through to the path-based default | see below (`:64,67,91-92`) |
| everything else | `100kb` | default (`:92`) |

> ⚠️ Two branches of this middleware never fire in practice, and both fail in the same direction — toward the default limit, never toward a larger one.
>
> - The NDJSON bypass also tests `PORTABILITY_IMPORT_PATH = '/api/account/import/stream'` (`:36,79`), but with no global prefix that route is mounted at bare **`/account/import/stream`** (`AccountDataController.ts:55,69`) and the proxy has already stripped `/api`, so `isPortabilityImport` is always false. Harmless in effect — `express.json()`/`urlencoded()` skip an `application/x-ndjson` body anyway, so the handler still receives the stream unconsumed — but the *explicit* guard the constant was meant to provide is not in force. Only the `/v1/*` half of the bypass is live.
> - **`@BodyLimit` is currently inert.** The single production use is `@BodyLimit('500mb')` on `POST /account/import` (`domains/auth/controllers/AccountDataController.ts:91-92`); at runtime that route is capped at the **100kb default**, so a legacy JSON archive over 100kb 413s.

The GraphQL/`/v1` limits are matched **by request path** (`req.baseUrl`/`originalUrl`), not `@BodyLimit` metadata, because Apollo is mounted via `app.use('/graphql', …)` so `req.route` is undefined there — and `BodyParserMiddleware` runs on `forRoutes('*')`, i.e. before routing, so per-route metadata is undefined for the `/v1` plane too.

That second reason generalises to **every** route, which is why the `@BodyLimit` row above yields nothing. The middleware reads its override from `req.route?.stack?.[0]?.handle` (`:64,67`), but it is registered as `consumer.apply(BodyParserMiddleware).forRoutes('*')` (`application.ts:172`), and Nest binds `forRoutes` middleware in `registerModules()` *before* `registerRouter()` resolves controller routes. The express adapter binds it as a wildcard `app.all()` layer, so by the time the middleware runs the only route that has matched is that catch-all, whose `stack[0].handle` is Nest's middleware proxy — never the controller method carrying the `body_limit` metadata `SetMetadata` attached (`common/decorators/BodyLimit.ts:22`). `reflector.get()` therefore always returns `undefined` and `bodyLimit` always comes from the path branch. The middleware's own comment states this (`:30-32`). The override *is* unit-tested (`common/middleware/__tests__/BodyParserMiddleware.test.ts:140-177`), but only against a hand-built `req.route` that real routing never produces. **File uploads** use multipart in `FilesController` / `BulkFilesController` and bypass these JSON limits (they have their own per-file caps).

### 4.2 Validation — zod, not class-validator

Validation is **zod-based**; `class-validator`/`class-transformer` are **not dependencies**. There is no global `ValidationPipe` — a zod schema is passed per-handler: `@Body(new ValidationPipe(someSchema))`. A failed body validation returns **HTTP 400** with `{ message: "Validation failed", errors: [ …zod issues… ] }`, each carrying zod's `code`/`path`/`message`. The schemas double as the request DTO types.

### 4.3 Error response shape

`GlobalExceptionsFilter` (`APP_FILTER`) normalizes HTTP + GraphQL errors: `HttpException`s keep their status/payload; unknown errors become 500. Responses carry the `X-Trace-Id` header so a client can correlate a failure with server logs.

### 4.4 CSRF (double-submit)

`CsrfGuard` enforces a **signed double-submit cookie** on login/signup/refresh/logout: it compares the `csrfToken` cookie against the `x-csrf-token` header (constant-time, HMAC-verified, token format `{scope}.{randomHex64}.{hmacHex64}` — see the principal-binding table in §1.1). Failures throw `ForbiddenException` carrying a machine-readable `reason`.

**The guard is not what protects the no-JS forms.** `@UseGuards(CsrfGuard)` appears in exactly four places in the tree — the four routes above (`SessionController.ts:75,109,161`, `SignupController.ts:35`). `POST /connect/approve` (`ConnectController.ts:284`) and `POST authenticate/oidc/confirm-account` (`OidcController.ts:566`) declare no guard at all and instead call `CsrfService.validateToken(cookie, body.csrf, AuthService.resolveCsrfScope(req))` inline on the hidden `csrf` form field (`ConnectController.ts:305-309`, `OidcController.ts:590-593`). Same checks, but in the handler — which is the point: the handler can catch the `ForbiddenException` and self-heal with a 303 back to its own GET instead of dead-ending the user on a raw 403. A consequence worth knowing when auditing: the cookie-less native branch described below lives in the guard, so it does **not** apply on those two form routes.

**Cookie-less native branch** (`CsrfGuard.ts:42-48`): a request with an `x-csrf-token` header and **no** `csrfToken` cookie is the native signature — a Capacitor webview cannot read or send that cookie, so it reads the token from the `GET /authenticate/csrf` body instead. That shape is verified scope-agnostically (`verifyToken`: was this token minted by us?), because there is no session cookie to bind a scope against, and cookie-replay CSRF does not apply to a client that authenticates with an API key. A request with **neither** cookie nor header deliberately falls through to `validateToken` so it is reported and logged as a missing-CSRF rejection rather than silently reclassified as native.

### 4.5 Provenance-triple idempotency convention

**Every bulk ingest path dedups on the provenance triple `(source_type, source_system, source_id)`** — the platform-wide idempotency key that lets the importer re-push without creating duplicates.

| Field | Meaning | Example |
|---|---|---|
| `source_type` | The *kind* of upstream record / ingest lane | `'capture'`, `'email'`, `'calendar'` |
| `source_system` | The connector / provider | `'gmail'`, `'google'`, `'takeout'` |
| `source_id` | The upstream record's stable natural key | the provider's message/event id |

The triple backs an `ON CONFLICT … DO NOTHING`/idempotent upsert, so a re-POST of a seen record is a no-op, not an error. Unified capture ingest is the canonical example (`domains/ingest/controllers/BulkIngestController.ts:312-336`, the shared `captureAndMaterialize` pipeline): the raw log `ci.capture_events` is idempotent on `(user_id, destination, triple)`, and a row not present in the `RETURNING` set already existed → counted as `duplicate`, downstream materialization skipped. `destination` is part of that key because one source item may legitimately present the same triple to two lanes (the importer's fan-out kinds send one item to both `/v1/events` and `/v1/contents`). The same convention governs the GraphQL batch-create mutations. Where a source provides no stable `source_id`, ingest falls back to a stable natural-key hash to avoid the "constant-filename items collapse to one hash and vanish" failure mode.

---

## 5. MCP surface

CI-Server exposes a **Model Context Protocol** server so agents (CI-Hermes, CI-OpenClaw, external MCP clients) get one memory-brain endpoint.

### 5.1 Endpoint, transport, identity

- **Path: root `/mcp`** — `@Controller('mcp')` (`McpController.ts:83`). Browser clients reach it at `/api/mcp` through the proxy; there is **no** separate `/api/mcp` controller.
- **Transport:** `StreamableHTTPServerTransport` (`@modelcontextprotocol/sdk`) — HTTP with an SSE stream for server→client notifications.
- **Server identity:** name **`companion-memory`**, version **`0.1.0`** (`McpServerService.ts:23-24`).
- **Auth:** class-guarded by **`JwtOrApiKeyAuthGuard`**, plus `@RequireScopes('mcp')` and `@RequireCapability('read')` (`McpController.ts:83-88`) — authenticate with an access-token Bearer, an API key as **`Authorization: Bearer <key>`** or `x-api-key` (or a Portal token). A scope-limited connect key needs the `mcp` scope; `read` is only the floor for *reaching* the endpoint (initialize, list tools) — which tools it may actually run is decided per tool, see §5.3. Point a standard MCP client at its bearer-token field; see [§1.2](#12-api-keys-programmatic-clients).

### 5.2 Session lifecycle (JSON-RPC over HTTP)

| Method | Behavior |
|---|---|
| `POST /mcp` | All JSON-RPC messages. An `initialize` body (no `Mcp-Session-Id`) creates a transport + `McpServer` and mints a session id; subsequent calls **must** send `Mcp-Session-Id` (`:105-166`) |
| `GET /mcp` | Opens the SSE stream for server notifications; requires `Mcp-Session-Id` (`:168-186`) |
| `DELETE /mcp` | Terminates a session (`:188-234`) |

**Session binding is by authority, not just user.** The server — its tool list *and* every handler's captured request — is built once at `initialize`, so a session is frozen to whoever opened it. Matching on `userId` alone is not enough on a single-owner appliance, where the owner's full-authority browser session and an agent's scope-limited connect key are the *same* user. Each session therefore carries an **authority signature**: a JSON encoding of `{ keyId, sorted scopes, capability }` (or the sentinel `{principal:'non-api-key'}` for a session/JWT caller) — `apiKeyAuthoritySignature`, `McpController.ts:57-79`. Consequences worth knowing:

- two agents' connect keys under the same owner cannot resume, drive or terminate each other's sessions (hence `keyId`, not just the scope set);
- re-scoping or demoting a key immediately retires the sessions it opened — the next request rebuilds the server at the new level rather than coasting on the old one until the TTL;
- a session id belonging to a *different* user returns **404**, not 403, deliberately.

Idle sessions are reaped after **30 minutes** by a 5-minute cron (`:236`).

```bash
# Initialize — server returns Mcp-Session-Id
# `-H "x-api-key: a1b2c…"` is equivalent; MCP clients that only offer a token field use this form.
curl -i -X POST https://ci-memory.example.com/api/mcp \
  -H "Authorization: Bearer a1b2c…" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2025-06-18","capabilities":{},
        "clientInfo":{"name":"my-agent","version":"1.0"}}}'
# → header Mcp-Session-Id: <uuid>;  result.serverInfo = {name:"companion-memory",version:"0.1.0"}
```

### 5.3 Tools

Tools come from **two sources**:

**(a) Auto-wrapped GraphQL CRUD.** `GraphQLToolAdapter` turns **every query field and every mutation field into an MCP tool**; arg types → zod input schemas. Privacy labels: queries are `read`; mutations are `write`, flagged **`delete`/destructive when the name starts with `delete`/`remove`/`destroy`/`purge`/`drop`** (`GraphQLToolAdapter.ts:34,109-137`). The tool count scales with the schema automatically.

**(b) Native curated intents** from the shared **`ToolRegistry`** (`@ci/domains/tools`) — dotted ids (e.g. `memory.recall`) exposed under an MCP-safe underscored name (`memory_recall`). A native name colliding with an auto-wrapped GraphQL tool is skipped.

**The advertised list is filtered per request** — `McpToolService.getToolsForRequest` (`:77-92`), not a static catalog:

- **GraphQL-derived tools are withheld entirely from scope-limited keys.** The resolvers behind them declare no `@RequireScopes`, so deny-by-default would 403 every call; advertising them would hand the model a catalog where each entry fails with an opaque `Forbidden resource`.
- **Native intents additionally require the `intents` scope**, not just `mcp` (`mayRunIntents`, `:73`) — otherwise an `mcp`-only key, 403'd on `/api/intents`, could execute those very intents here. Both chat-agent connect keys already carry `intents`, so this closes the hole without narrowing any key in the field.
- **Every tool is then filtered by the key's `capability`** (`read` / `write` / `full`) — including for empty-scope full-surface keys, because "sees every surface" and "may delete on it" are separate grants.

Authorization itself lives in the tools domain and is enforced inside `ToolRegistry.executeTool` for **every** transport (MCP, the in-house chat model, the on-device tier). `capability` is a mandatory field on `ToolInvocationContext`, so a new dispatcher cannot execute a tool without stating an authority; MCP keeps only a pre-check so it can return a specific 403 message.

Every tool is registered with standard MCP annotation hints derived from its privacy label (`McpServerService.ts`): `readOnlyHint`, `destructiveHint`, `openWorldHint`.

### 5.4 Resources

| Resource | URI | Content | Withheld from |
|---|---|---|---|
| GraphQL schema | `schema://graphql` | Full SDL (`printSchema`) for type/query/mutation discovery | scope-limited keys — the resource stays in lockstep with the tools it documents |
| Intent catalog | `intents://catalog` | `IntentCatalogService.getManifest()` — schema domains, entity types, curated privacy-labelled intents | keys that fail `mayRunIntents` (i.e. scope-limited without `intents`) |

The intent catalog is also served over REST at **`GET /api/agent/intents`** (canonical for CI-Hermes / CI-OpenClaw) and **`GET /api/intents`** (the legacy prefix, still served — one controller mounts both), behind `JwtOrApiKeyAuthGuard` + the `intents` scope. That gives non-MCP agents the same capability declaration. Prefer the curated, typed, privacy-labelled catalog over raw CRUD.

---

## Summary

- **No server-side `/api` prefix** — the SPA is same-origin behind a proxy that strips `/api`; three controllers hardcode `api/` so their public URLs survive the rewrite. **CORS is enabled but narrow**: the native webview origins plus whatever `CORS_ALLOWED_ORIGINS` adds.
- **Four credentials:** an in-memory access-token JWT sent as `Authorization: Bearer` (the only thing `JwtStrategy` reads, for REST *and* GraphQL); an httpOnly `sessionToken` cookie (`secure: req.secure` + `sameSite: lax`, so it survives plain-HTTP Tailscale) used *only* at `/authenticate/refresh` and `/logout`; `x-api-key` keys stored as SHA-256 hashes and carrying two authorization axes (`scopes` × `capability`); and CI-Portal OIDC bearers, **accepted by default**. Browser OIDC ends by minting the same session cookie, with JIT provisioning and a `redirect_uri` pinned to `APP_BASE_URL`.
- **Auth is per-controller** (`JwtAuthGuard` / `ApiKeyGuard` / `JwtOrApiKeyAuthGuard` / `JwtOrPortalAuthGuard`, plus the HMAC S2S guards), not global; there is no `@Public` decorator and the only global guard is the non-auth `IdFormatGuard`. `userId` propagates via AsyncLocalStorage and is enforced by `toServiceContext`.
- **Conventions:** zod validation (no class-validator), 10mb body limit for `/graphql` and the whole `/v1/*` plane with an uncapped NDJSON bypass (100kb otherwise), trace-id error envelopes, and a platform-wide `(source_type, source_system, source_id)` provenance-triple idempotency key.
- **MCP** lives at root `/mcp` (`companion-memory` v0.1.0) over `StreamableHTTPServerTransport`, authenticated by `JwtOrApiKeyAuthGuard` + the `mcp` scope, exposing every GraphQL query/mutation as a privacy-labelled tool plus native curated intents — **both filtered per caller** by scope and capability — and the `schema://graphql` + `intents://catalog` resources.

---

*Guard assignments, route codes, scope/capability semantics, CORS and body limits re-verified against `backend/apps/api/src` on **2026-08-19**. Cookie/CSRF mechanics (§1.1) and the OIDC flow (§1.3) were carried over unchanged and re-checked only where cited above.*

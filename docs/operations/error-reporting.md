# Error reporting (Sentry)

CI-Server reports crashes to [Sentry](https://sentry.io). It is **opt-out**: on
any build configured with a DSN, reporting is **on by default**, and the user
turns it off with the **Share crash reports** toggle in the app store (or
`CI_TELEMETRY=off` directly).

Two statements are both true here and easy to conflate:

- **Configured with a DSN → reporting is on** unless the user turns it off. That
  is the shipped appliance: release images carry a DSN.
- **No DSN → nothing initialises**, and no component makes an outbound
  connection. That is a source checkout, a local `make dev`, or any build made
  without `SENTRY_DSN`. It is the absence of configuration, not a privacy
  setting.

So "opt-out" describes what a user of the appliance experiences. It does not
mean a DSN-less build quietly reports — it cannot.

This is the reference implementation for the rest of the first-party fleet. The
same env contract is implemented in CI-Planning, CI-Import-Tools, CI-Hermes,
CI-OpenClaw, CI-Spellbook, CI-WebXR-Time-Machine and
CI-Spatial-Companion-WebXR.

## Privacy posture

The appliance holds the user's entire digital life, so reporting is deliberately
narrower than a Sentry default install:

| Setting | Value | Why |
|---|---|---|
| `sendDefaultPii` | `false` | No IPs, cookies, or request bodies. |
| `tracesSampleRate` | `0.1` by default | Override with `SENTRY_TRACES_SAMPLE_RATE`; keep consent and scrubbing enabled. |
| Session replay | `0.1` of sessions, 100% of error sessions | Override with the `VITE_SENTRY_REPLAYS_*` variables. |
| `beforeSend` | scrubber | Redacts credentials and home paths, drops cookies/body/query string. |

Two kill switches disable reporting even when a DSN is baked into an image, so
an operator can turn it off without a rebuild:

| Variable | Effect |
|---|---|
| `CI_TELEMETRY=off` | Explicit opt-out (also `false`, `0`, `no`, `disabled`). |
| `CI_LOCAL_ONLY=true` | Local-only mode means zero phone-home. See [local-only-mode](https://github.com/companionintelligence/CI-Engineering/blob/main/proposals/local-only-mode.md). |

`CI_LOCAL_ONLY` takes precedence over `CI_TELEMETRY`, which takes precedence
over the DSN.

## What gets scrubbed

`backend/apps/api/src/common/telemetry/scrubEvent.ts` and its Python
counterpart (`backend/packages/telemetry/src/ci/telemetry/__init__.py`, shared
by every Python service) implement the same rules:

- Bearer tokens, `api_key=` / `password:` / `token:` style pairs, Tailscale
  `tskey-…`, and credentials in connection URLs → `[Filtered]`
- Home directories (`/Users/<name>`, `/home/<name>`, `C:\Users\<name>`) → `~`,
  since they leak the account name
- Object and header keys matching
  `password|secret|token|authorization|cookie|jwt|api[-_ ]?key|dsn|pepper|private_key`
  → `[Filtered]`. The hyphenated form matters: `x-api-key` is the API's own
  key header, and the SDK ships request headers even with PII disabled.
- Request cookies and bodies dropped; **query strings removed from
  `request.query_string`, from `request.url`, and from the `referer` header** —
  the SDK builds `request.url` from `req.url`, which on a Node server is
  path+query, so filtering only `query_string` redacts nothing
- Stack frame `filename` / `abs_path` (absolute paths outside Docker) and
  captured `vars`; `include_local_variables` is off in the Python services,
  where frame locals would otherwise be note bodies and memory rows
- `server_name` (the machine hostname) removed, and `includeServerName: false`
  set at init — the hostname identifies the household like a home path does
- Breadcrumbs: message and every `data` value. This matters more than it
  sounds — the default integrations record fetch/xhr crumbs carrying `data.url`
  **with the query string**, console crumbs carrying raw arguments, and (in
  Python) every INFO+ log record. In the Python SDK the shape is
  `breadcrumbs.values`, not a bare list; both are handled.
- `logentry.formatted` and `logentry.params`, not just `logentry.message` —
  `message` is only the printf *format string*, so scrubbing it alone stamps
  `[Filtered]` on the template while shipping the interpolated user data intact
- Strings over 8 KB truncated, so a stray blob can't smuggle memory contents out
  inside an exception message

The browser bundle (`frontend/apps/web/src/lib/telemetry.ts`) applies the same
rules and additionally strips the query string and hash from every reported URL,
breadcrumb URL and `Referer` header — on this app those carry the user's search
terms — and drops chunk-load and `ResizeObserver` noise.

### The browser consent check

A DSN baked into the bundle at build time cannot be revoked afterwards, so the
kill switches would not reach the browser on their own. Before calling
`Sentry.init`, the frontend asks `GET /api/config/telemetry` whether reporting is
permitted, and **fails closed** if that endpoint is unreachable or says no. This
is what makes the marketplace "Share crash reports" toggle — which sets
`CI_TELEMETRY` on the container — actually apply to the web UI.

The build-time DSN is still what gates bundling: with `VITE_SENTRY_DSN` unset the
whole init path folds to dead code and the SDK is tree-shaken out entirely
(measured: **0 bytes** without a DSN, **+88.8 kB raw** with one). Keep the
module-scope `const DSN = import.meta.env.VITE_SENTRY_DSN` shape without optional
chaining — `import.meta.env.X?.trim()` does not fold under rolldown, which
silently put the entire SDK back into a sibling repo's DSN-less bundle.

## Sentry projects

One project per component, matching the CI-Hub convention:

CI-Server reports into the **`ci-memory`** project in the `companion-intelligence`
org (named for the marketplace app id, matching `ci-import-tools`; CI-Hub's
`hub-backend` / `hub-frontend` / `hub-desktop` predate the convention).

Each component still gets its own DSN variable, and every event carries a
`component` tag, so one project or four both work:

| Component | `component` tag | DSN variable |
|---|---|---|
| `backend/apps/api` | `ci-server-api` | `SENTRY_DSN_API` |
| `frontend/apps/web` | `ci-server-web` | `VITE_SENTRY_DSN` (build time) |
| `frontend/apps/mobile` | `ci-server-mobile` | `VITE_SENTRY_DSN` (build time — same bundle) |
| `backend/apps/hbpe` | `ci-server-hbpe` | `SENTRY_DSN_HBPE` |
| `backend/apps/summary` | `ci-server-summary` | `SENTRY_DSN_SUMMARY` |

Point them all at the same `ci-memory` DSN and filter by `component:` in Sentry,
or split them into per-component projects later without touching any code — the
env contract is the same either way. Compose maps each variable onto the
container's `SENTRY_DSN`, so a service only ever sees the one meant for it.

### The native shell

The Capacitor app has no bundle and no DSN of its own — it ships the very same
`@ci/fe-web` build. It is the *runtime* that differs, so the `component` tag is
resolved per session from `isNativePlatform()` rather than being a build-time
constant. Two things follow, neither of which the web path ever has to think
about:

- **The consent probe is not same-origin.** Capacitor serves the bundle from
  `capacitor://localhost` (iOS) or `https://localhost` (Android), so a relative
  `GET /api/config/telemetry` resolves against the WebView itself. It goes
  through `buildApiUrl()` against the server the user configured, and returns
  `null` — reporting off — before any server has been configured. This also means
  `initApiBaseUrl()` **must** run before `initTelemetry()` in `main.tsx`: the
  probe issues its fetch before its first `await` yields, so an origin resolved
  after it is too late. Reversing those two lines silently disables reporting for
  the entire mobile app, with no error raised anywhere.
- **The server origin is itself sensitive.** On web the API is same-origin and
  there is nothing to conceal; on a phone it is whatever the user typed, and that
  is routinely a tailnet hostname or a LAN IP identifying their machine and their
  network. `beforeSend` replaces it with `[server]` wherever it appears —
  messages, exception values, breadcrumb URLs. `sendDefaultPii: false` does not
  cover this, because the SDK cannot know the string is sensitive.

Native Swift/Java crashes are **not** captured; only errors that reach the JS
layer are. Capturing those needs `@sentry/capacitor` plus a privacy-manifest
update, and is deliberately outside this integration.

```
sentry issue list companion-intelligence/ci-memory --query "component:ci-server-hbpe"
```

## Enabling it

```bash
# .env — one DSN per component, all optional
SENTRY_DSN_API=https://<key>@o<org>.ingest.us.sentry.io/<id>
SENTRY_DSN_HBPE=https://<key>@o<org>.ingest.us.sentry.io/<id>
SENTRY_DSN_SUMMARY=https://<key>@o<org>.ingest.us.sentry.io/<id>
SENTRY_ENV=production
CI_SERVER_VERSION=2026.8.1
```

The web DSN is a **build-time** value — it must be present when
`yarn workspace @ci/fe-web build` runs (`make build ENV=production`), not at
container start.

Turning it off again:

```bash
CI_TELEMETRY=off docker compose --profile production up -d
```

## Verifying

```bash
sentry issue list companion-intelligence/ci-memory --query "is:unresolved"
sentry issue view CI-MEMORY-1
```

To confirm reporting is genuinely inert without a DSN, start the API with no
`SENTRY_DSN*` set and check that no request reaches `ingest.sentry.io`.

## Where it hooks in

| Path | Role |
|---|---|
| `backend/apps/api/src/instrument.ts` | `Sentry.init`; must stay the first import in `main.ts` |
| `backend/apps/api/src/common/telemetry/settings.ts` | Resolves the telemetry gate from env |
| `backend/apps/api/src/common/filters/GlobalExceptionsFilter.ts` | Captures unexpected request failures (not 4xx) |
| `backend/apps/api/src/application.ts` | Crash handlers capture + flush before `process.exit` |
| `frontend/apps/web/src/main.tsx` | Calls `initTelemetry()` before render |
| `backend/apps/{hbpe,summary}` | `init_telemetry()` in the FastAPI app entry points |

## Not wired up yet

- **Release + source map upload in CI.** `publish.yml` does not yet pass
  `VITE_SENTRY_DSN` / `SENTRY_RELEASE` or run `sentry sourcemaps upload`, so
  browser stack traces are minified. CI-Hub's `desktop-release.yml` has the
  pattern to copy.
- **Consent UI.** Reporting is currently an operator-level switch, not a
  user-facing one — the same gap tracked for CI-Hub in
  [security-trust-and-ops](https://github.com/companionintelligence/CI-Engineering/blob/main/architecture/subsystems/security-trust-and-ops.md) (P2).

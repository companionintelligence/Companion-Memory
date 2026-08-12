# @ci/capacitor-local-hub

Capacitor plugin for the **Local Hub**: an embedded, loopback-only HTTP server that runs
inside the CI-Server mobile app. Unlike `@ci/capacitor-local-llm` (Android-only), this
plugin ships native implementations for both Android and iOS.

## Design: three phases

The Local Hub is planned in three phases. **This package currently implements only Phase
1** -- the skeleton below. Phases 2 and 3 are documented here so the shape of what plugs in
later is clear, but neither is built yet.

### Phase 1 -- skeleton (this pass)

- `start()` / `stop()` / `getStatus()` lifecycle for an embedded HTTP server bound to
  `127.0.0.1` on an OS-assigned ephemeral port.
- A single endpoint, `GET /api/health`, gated by a per-launch bearer token.
- No persistence, no request handling beyond the health check, no background work.

This exists so the app can start depending on "there is a local server at a known
`baseUrl` with a known bearer token" before the more valuable Phase 2/3 features land,
and so those later features have a lifecycle and an auth model to plug into rather than
inventing their own.

### Phase 2 -- durable outbox (not yet built)

A SQLite database (encrypted at rest via SQLCipher) local to the app, used as a durable
write-behind queue: the web client (running inside the same WebView) writes mutations to
the Local Hub instead of directly to CI-Server, the Local Hub persists them immediately,
and a background flush process replays them against CI-Server's REST API as connectivity
allows. This is what lets the client keep working (and keep the user's intent durable)
through flaky or absent connectivity, without the web app itself needing to implement
retry/replay logic.

Expected shape: new NanoHTTPD (Android) / equivalent (iOS) routes such as
`POST /api/outbox` alongside the existing router in `LocalHubServer`, plus a
SQLCipher-backed store and a flush worker (likely WorkManager on Android, matching the
pattern already used by `@ci/capacitor-local-llm`'s `ModelDownloadWorker`).

### Phase 3 -- local inference + read mirrors (not yet built)

- An embedded `llama.cpp` runtime for local-only inference, as an alternative/complement
  to `@ci/capacitor-local-llm`'s LiteRT-LM path.
- Local mirrors of the read endpoints CI-Server's memory domain exposes today (e.g.
  `GET /api/memory/search`), served from the same Local Hub process so the client can read
  recent memory fully offline, backed by data synced down via the same
  outbox/sync machinery as Phase 2.

## Phase 1 contract (implemented)

```ts
interface LocalHubPlugin {
  start(): Promise<{ baseUrl: string; token: string }>;
  stop(): Promise<void>;
  getStatus(): Promise<{ running: boolean; baseUrl?: string }>;
}
```

- **`start()`**: if not already running, binds an HTTP server to `127.0.0.1` (never
  `0.0.0.0`) on port `0` (OS-assigned free port), generates a fresh cryptographically
  random bearer token (32 bytes, base64url), and returns `{ baseUrl, token }`. The token
  is never persisted to disk and is regenerated every time a fresh server actually starts.
  If already running, returns the existing `baseUrl`/`token` without restarting or
  rotating the token.
- **`stop()`**: stops the server if running. No-op otherwise.
- **`getStatus()`**: current running state and `baseUrl` if running.
- **`GET /api/health`**: the only route. Requires `Authorization: Bearer <token>` with the
  exact token `start()` returned.
  - Valid token: `200 {"status":"ok","version":"0.1.0"}`
  - Missing/wrong token: `401` with a minimal JSON error body.

### Security posture

- The server binds explicitly to the loopback interface (`127.0.0.1`), so it is never
  reachable from the LAN or any other device, regardless of firewall/VPN state.
- Every route requires the current per-launch bearer token, so no other app on the same
  device can call it either, short of somehow obtaining a live token from this plugin's
  own `start()` response.
- The token is generated fresh per `start()` call from a CSPRNG (`SecureRandom` on
  Android) and is never written to disk, a log, or persistent storage.

## Package layout

Modeled on `@ci/capacitor-local-llm` for consistency:

```
src/
  definitions.ts   # LocalHubPlugin TS interface (source of truth for native parity)
  index.ts         # registerPlugin('LocalHub', ...)
  web.ts           # no-op web fallback
android/
  build.gradle
  src/main/AndroidManifest.xml
  src/main/java/com/companionintelligence/localhub/
    LocalHubPlugin.kt   # @CapacitorPlugin(name = "LocalHub"): start/stop/getStatus
    LocalHubServer.kt   # NanoHTTPD subclass: loopback bind + bearer auth + routes
CapacitorLocalHub.podspec  # CocoaPods spec (Capacitor 7 iOS plugin structure)
ios/
  Sources/LocalHubPlugin/
    LocalHubPlugin.swift  # @objc CAPPlugin/CAPBridgedPlugin, jsName "LocalHub": start/stop/getStatus
    LocalHubServer.swift  # GCDWebServer wrapper: loopback bind + bearer auth + routes
```

Consumed by `frontend/apps/mobile` via `"@ci/capacitor-local-hub": "file:../../packages/capacitor-local-hub"`,
picked up by `npx cap sync` on the Android side (`capacitor.settings.gradle` /
`capacitor.build.gradle`, generated from that dependency). On iOS, `cap sync` does not
manage CocoaPods dependencies the way it manages Android Gradle modules, so the pod is
instead added by hand as a `:path =>` entry in
`frontend/apps/mobile/ios/App/Podfile`'s `capacitor_pods` block, pointing straight at
this package directory rather than through `node_modules`.

## iOS native implementation status (unverified)

The iOS side (`CapacitorLocalHub.podspec`, `ios/Sources/LocalHubPlugin/*.swift`) was
written in an environment with **no Mac, no Xcode, and no Swift compiler available** --
by close reading of the actual `@capacitor/ios@7.6.7` source already vendored in this
repo's `frontend/apps/mobile/node_modules/@capacitor/ios` (used to confirm the exact
`CAPPlugin`/`CAPBridgedPlugin`/`CAPPluginCall` API this Capacitor version expects) and
of GCDWebServer's public headers and README fetched from
[swisspol/GCDWebServer](https://github.com/swisspol/GCDWebServer) on GitHub (used to
confirm `GCDWebServerOption_BindToLocalhost`, `GCDWebServerOption_Port`,
`startWithOptions:error:`, `addHandlerForMethod:path:requestClass:processBlock:`, the
`headers` property type, and `GCDWebServerDataResponse`'s JSON initializer). That
source-reading gives reasonable confidence the API calls are spelled correctly, but:

- **None of this Swift code has been compiled.** There is no way to run `swiftc`,
  Xcode, or even a syntax check in this environment. Typos, argument-label mistakes, or
  Swift-version-specific behavior would not have been caught.
- **`pod install` has not been run.** The `CapacitorLocalHub.podspec` and the new
  Podfile entry are unverified beyond visual inspection -- in particular, whether
  GCDWebServer builds cleanly as a CocoaPods dependency under this Podfile's
  `use_frameworks!` setting has not been confirmed.
- **No runtime testing.** The server has never actually been started on a device or
  simulator; `start()`/`stop()`/`getStatus()` and the `/api/health` request/response
  cycle are unverified beyond code review.
- **App Transport Security**: no `Info.plist` changes were made. Reasoning: the
  plugin's `baseUrl` is always a literal IP address (`http://127.0.0.1:<port>`), and
  ATS's cleartext-HTTP restrictions apply only to connections to hostnames, not literal
  IP addresses -- so no ATS exception should be needed regardless of whether the
  caller is JS in the WKWebView or native code. This reasoning is grounded in Apple's
  documented ATS behavior, not in having tested it against this exact loopback
  server. If a real device build shows an ATS block, the fix is almost certainly a
  narrow addition to `frontend/apps/mobile/ios/App/App/Info.plist`'s existing
  `NSAppTransportSecurity` block, not a blanket exception.
- **GCDWebServer API surface confidence**: high for the specific symbols used
  (verified against the library's actual header files, not general/possibly-stale
  training knowledge) -- but "verified against source" is not the same as "verified by
  compiling." `GCDWebServerOption_BindToLocalhost`'s exact default-off behavior and the
  Swift throwing-initializer conversion for `startWithOptions:error:` are both
  documented/inferable from the fetched headers, but were not observed running.
- **Constant-time token comparison**: added on the iOS side to match the Android
  implementation's `constantTimeEquals` (avoiding a timing side-channel on the bearer
  check); this is a straightforward byte-array XOR loop with no exotic API surface, so
  it carries the same "should be correct, unverified" caveat as the rest of the file
  rather than any GCDWebServer-specific uncertainty.

Building, `pod install`, and on-device/simulator testing all need to happen on an
actual Mac with Xcode before this ships.

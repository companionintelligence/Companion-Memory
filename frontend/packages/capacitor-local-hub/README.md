# @ci/capacitor-local-hub

Capacitor plugin for the **Local Hub**: an embedded, loopback-only HTTP server that runs
inside the CI-Server mobile app. Unlike `@ci/capacitor-local-llm` (Android-only), this
plugin ships native implementations for both Android and iOS.

## Design: three phases

The Local Hub is planned in three phases. **Phases 1 and 2 are implemented** (Phase 2
partially -- see its scope boundaries below). Phase 3 is documented so the shape of what
plugs in later is clear, but it is not built yet.

### Phase 1 -- skeleton (done)

- `start()` / `stop()` / `getStatus()` lifecycle for an embedded HTTP server bound to
  `127.0.0.1` on an OS-assigned ephemeral port.
- `GET /api/health`, gated by a per-launch bearer token.

This exists so the app can depend on "there is a local server at a known `baseUrl` with a
known bearer token", and so later features have a lifecycle and an auth model to plug into
rather than inventing their own.

### Phase 2 -- durable capture outbox (implemented; see scope boundaries)

An on-disk, SQLCipher-encrypted SQLite database local to the app, used as a durable
write-behind queue: the web
client (running inside the same WebView) writes captures to the Local Hub instead of
directly to CI-Server, the Local Hub commits them to disk *before* answering, and a flush
process replays them against CI-Server's REST API as connectivity allows. This is what lets
the client keep working -- and keep the user's intent durable -- through flaky or absent
connectivity, without the web app itself implementing retry/replay logic.

The full route contract, the capacity/attempt policy, and what is deliberately **not** in
this pass are in [Outbox contract](#outbox-contract-implemented) below.

### Phase 3 -- local inference + read mirrors (not yet built)

- An embedded `llama.cpp` runtime for local-only inference, as an alternative/complement
  to `@ci/capacitor-local-llm`'s LiteRT-LM path.
- Local mirrors of the read endpoints CI-Server's memory domain exposes today (e.g.
  `GET /api/memory/search`), served from the same Local Hub process so the client can read
  recent memory fully offline, backed by data synced down via the same
  outbox/sync machinery as Phase 2.

## Lifecycle contract (implemented)

```ts
interface LocalHubPlugin {
  start(): Promise<{ baseUrl: string; token: string }>;
  stop(): Promise<void>;
  getStatus(): Promise<{ running: boolean; baseUrl?: string }>;

  // Keystore-backed credential store. Not part of the HTTP surface -- these work whether
  // or not the server is running. See "Secure credential storage" below.
  secureGet(options: { key: string }): Promise<{ value: string | null }>;
  secureSet(options: { key: string; value: string }): Promise<void>;
  secureRemove(options: { key: string }): Promise<void>;
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
- **`GET /api/health`**: Requires `Authorization: Bearer <token>` with the exact token
  `start()` returned.
  - Valid token: `200 {"status":"ok","version":"0.2.0"}`
  - Missing/wrong token: `401` with a minimal JSON error body.
  - The `version` moved `0.1.0` -> `0.2.0` when the outbox routes landed; it tracks this
    package's phase markers, not the app version.

### Security posture

- The server binds explicitly to the loopback interface (`127.0.0.1`), so it is never
  reachable from the LAN or any other device, regardless of firewall/VPN state.
- Every route requires the current per-launch bearer token, so no other app on the same
  device can call it either, short of somehow obtaining a live token from this plugin's
  own `start()` response.
- The token is generated fresh per `start()` call from a CSPRNG (`SecureRandom` on
  Android) and is never written to disk, a log, or persistent storage.
- The bearer check runs *before* route dispatch, so an unauthenticated caller cannot even
  probe which routes exist -- every path answers `401`, not `404`.
- **CORS is load-bearing, not decoration.** The caller is the app's own WebView, but
  Capacitor loads it from a different origin (`https://localhost` on Android,
  `capacitor://localhost` on iOS), so the browser enforces CORS against this loopback
  server. Two rules follow, both learned from real device runs:
  1. *Every* response -- including `401`/`404`/`507` -- must carry
     `Access-Control-Allow-Origin`, or `fetch()` rejects it before JS can read it.
  2. `Access-Control-Allow-Headers` must list both `Authorization` **and** `Content-Type`.
     A JSON request body is itself a preflight trigger, so omitting `Content-Type` breaks
     every outbox write in exactly the way the missing `Access-Control-Allow-Origin`
     originally broke every read.

  The wildcard `Access-Control-Allow-Origin: *` does not weaken the boundary: the bearer
  token is what gates access, and the `OPTIONS` preflight is answered *unauthenticated* on
  purpose (browsers send it without credentials; a `401` there kills the real request
  before it is ever sent).

## Outbox contract (implemented)

The durable capture outbox lives at `/api/outbox` on the same server, behind the same
bearer token and the same CORS handling. The web client `POST`s a capture, gets an
immediate durable acknowledgement, and a flusher drains the queue against CI-Server when
connectivity allows.

### Routes

All routes require `Authorization: Bearer <token>` except the `OPTIONS` preflight.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/outbox` | Enqueue one item. `201`, or `507` when full. |
| `GET` | `/api/outbox` | List items oldest-first. Optional `?status=pending\|needs_attention\|all` (default `all`). |
| `GET` | `/api/outbox/{id}` | One item **including** `payload`. `404` if unknown. |
| `DELETE` | `/api/outbox/{id}` | Remove one item (successful flush, or deliberate user discard). `204` / `404`. |
| `POST` | `/api/outbox/{id}/attempt` | Record a flush outcome. `204` on success, `200` with the updated item on failure, `404` if unknown. |
| `POST` | `/api/outbox/{id}/retry` | Move an item back to `pending` with `attempts` reset to 0. `200` / `404`. |

**Enqueue** — `POST /api/outbox`

```jsonc
// request
{
  "kind": "note",                          // opaque to the sidecar ("note" | "capture" | …)
  "payload": { "text": "…" },              // opaque JSON object the flusher POSTs onward
  "capturedAt": "2026-08-13T10:00:00.000Z",// ISO-8601, CLIENT time at capture
  "idempotencyKey": "01J…"                 // client-generated ULID/UUID
}
// 201
{ "id": "…", "status": "pending", "capturedAt": "2026-08-13T10:00:00.000Z", "seq": 1 }
```

- `capturedAt` is stored **verbatim** and never replaced with server/device-receive time.
  An item that sits in the queue for a day still reaches CI-Server with the timestamp the
  user actually captured it at.
- `idempotencyKey` is unique: re-`POST`ing the same key returns the **original** row
  (same `id`, same `seq`, same `capturedAt`) with `201` again, and creates nothing. A
  differing `payload` on a replay is ignored -- first write wins. Answering `201` on a
  replay is deliberate: the caller retried because it never saw the first response, so it
  should not have to special-case the second one.
- Missing/blank `kind`, `capturedAt`, or `idempotencyKey`, or a `payload` that isn't a JSON
  object, are rejected `400 {"error":"invalid_request","detail":"…"}`.
- `507 {"error":"outbox_full","detail":"…"}` when the queue is at its cap (below).

**List** — `GET /api/outbox`

```jsonc
{
  "items": [
    { "id": "…", "kind": "note", "capturedAt": "…", "seq": 1,
      "status": "pending", "attempts": 0, "lastError": null }
  ],
  "counts":   { "pending": 1, "needsAttention": 0, "total": 1 },
  "capacity": { "max": 5000, "used": 1, "warnAt": 4000 }
}
```

- **Ordering is strict FIFO by `seq`**, a monotonic autoincrement. It never depends on the
  wall clock -- device clocks move backwards (NTP correction, manual change) and replay
  order must not. `seq` is also never reused after a delete (SQLite `AUTOINCREMENT`),
  so a new item can't sort ahead of one already queued.
- **List responses deliberately omit `payload`** -- payloads can be large (media, long
  notes) and a queue-depth poll shouldn't stream them. Use `GET /api/outbox/{id}` for the
  full item.
- `lastError` is always present, `null` when there has been no failure.

**Attempt** — `POST /api/outbox/{id}/attempt`

```jsonc
{ "ok": true }                                            // -> 204, item deleted
{ "ok": false, "error": "…", "permanent": false }         // -> 200, updated item
```

- `{"ok":true}` is exactly equivalent to `DELETE`: a flushed item leaves the queue rather
  than accumulating a "done" state somebody would later have to garbage-collect.
- `{"ok":false}` increments `attempts` and stores `lastError`. The item becomes
  `needs_attention` if `permanent` is true **or** `attempts` reaches `MAX_ATTEMPTS`;
  otherwise it stays `pending`.
- The response is the list-shaped item (no `payload`).

**Retry** — `POST /api/outbox/{id}/retry` sets `status` back to `pending` and `attempts` to
`0`. It applies to any existing item, not only `needs_attention` ones, so it is idempotent.
`lastError` is deliberately **kept** -- it is the only record of why the item stalled, and
the next failed attempt overwrites it anyway.

### Durability and policy

These are the point of the feature, not incidental:

- **Real on-disk SQLCipher in app-private storage.** Android:
  `/data/data/<pkg>/databases/ci_local_hub_outbox_enc.db` (via SQLCipher's
  `SQLiteOpenHelper`). iOS: `Library/Application Support/<bundle id>/ci-local-hub-outbox.sqlite3`
  inside the app container. Both are OS-isolated from other apps *and* encrypted at rest --
  see [Encryption at rest](#encryption-at-rest--what-is-and-is-not-protected) below for what
  that does and does not cover.
- **The write is committed before the response is returned** -- never buffered in memory
  and flushed later. A force-quit or reboot immediately after the `201` cannot lose the
  item. (iOS additionally sets `PRAGMA synchronous = FULL`.)
- **Capacity: hard cap of 5000 items, `warnAt` at 80% (4000).** At the cap, enqueue returns
  `507` and the caller must surface it. The queue **never** silently drops or evicts user
  data to make room -- an older capture is also something nobody agreed to lose. Callers
  see pressure coming via the `capacity` block on `GET /api/outbox` before hitting the wall.
- **`MAX_ATTEMPTS = 5`** failed attempts before an item lands in `needs_attention`.
- **Nothing is ever discarded silently.** Every terminal state is either an explicit
  `DELETE` (successful flush or deliberate user discard) or a visible `needs_attention`
  row waiting for the user.

### Encryption at rest — what is and is not protected

The outbox database **is** encrypted at rest, with SQLCipher (AES-256). Be precise about what
that buys, because "encrypted" is easy to over-claim:

**Protected.** The database *file*. An attacker who obtains the bytes — a rooted or
jailbroken device, a forensic image, a recovered flash page, a filesystem snapshot, a stolen
powered-off phone — sees ciphertext. The file does not begin with SQLite's `SQLite format 3`
magic and cannot be opened by any SQLite tool without the key.

**Also protected: deletion.** The key lives in the OS keystore, never on disk in usable form
and never exportable. Destroying that one keystore entry renders every copy of the database
file permanently unopenable, however many copies exist. That is the property that makes a
future "erase this device" a real operation rather than a `File.delete()` on recoverable
pages.

**Not protected: a running app that has already opened the database.** The key is in the
process the moment the sidecar starts, which it does eagerly at launch. Anything with code
execution inside the app can read the rows, and the loopback HTTP surface still answers to
whoever holds the per-launch bearer token. Encryption at rest defends a *device at rest*; it
is not a defence against a compromised or unlocked running app. The app-lock that covers that
case is a separate, unbuilt control.

**Not protected: the plaintext file's historical bytes.** The migration below overwrites the
old plaintext database before unlinking it, but on wear-levelling flash the controller may
write that overwrite elsewhere and leave the original block intact. It is the right gesture,
not a guarantee — which is exactly why encryption, not deletion, is the control this design
leans on.

#### Keys

| | Android | iOS |
| --- | --- | --- |
| Wrapping key | AES-256-GCM in `AndroidKeyStore`, alias `…localhub.outbox_dek_v1`, StrongBox-backed when the device has it | Keychain item, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` + `kSecUseDataProtectionKeychain` |
| Database key | 32 bytes of `SecureRandom`, wrapped by the above, stored as `version‖iv‖ciphertext` in app-private SharedPreferences | 32 bytes of `SecRandomCopyBytes`, stored directly in the Keychain item |
| Form passed to SQLCipher | `x'<64 hex>'` — a **raw key**, so PBKDF2 is skipped entirely | same |
| Also on disk | — | DB file set to `.completeUntilFirstUserAuthentication` and excluded from backups |

Raw key rather than a passphrase because there is no passphrase in this design: native auth is
an API key, not something the user types at launch. PBKDF2 exists to stretch a *low-entropy*
secret; stretching 256 bits of CSPRNG output buys nothing and costs milliseconds on the
critical path of every cold start.

**The key is never biometric-gated.** No `setUserAuthenticationRequired` on Android, no
`SecAccessControl` biometry on iOS, and — a deliberate deviation from
`SECURITY_ARCHITECTURE.md` §2.4/§3.1 — no `setUnlockedDeviceRequired` either. That flag is the
Android twin of iOS's `kSecAttrAccessibleWhenUnlocked`, which §3.1 of that document rejects at
length because the sidecar must be able to write while the screen is locked; setting it would
break background ingest and make the two platforms inconsistent in the direction the document
argues against. `AfterFirstUnlock` semantics — available from the first unlock after boot until
power-off — are what a background ingest daemon needs, and are what both platforms use here.

**Fail closed.** If the keystore cannot produce the key, the store throws and `start()` rejects.
There is no unencrypted fallback anywhere in either implementation. This is deliberate and is
the specific defect being avoided: `capacitor-secure-storage-plugin` responds to a Keystore
failure by writing plain Base64 into the same SharedPreferences file and reporting success.

**When the key is lost but the database is not** (app data cleared out of order, a keystore
reset) the store raises `OutboxKeyLostException` rather than minting a replacement key. A fresh
key would surface as SQLCipher's generic "file is not a database", which reads like corruption
and hides the fact that user captures were lost. Deleting the file automatically is
**not** done: per `SECURITY_ARCHITECTURE.md` §3.4 that decision owes the user a warning naming
how many captures are about to go, and there is no UI for that yet. Until there is, this state
is a hard start-up failure — visible, which is the point.

### Migrating an install that predates encryption

The plaintext database (`ci_local_hub_outbox.db`) and the encrypted one
(`ci_local_hub_outbox_enc.db`) are **different files**, because the plain driver cannot open a
SQLCipher file and vice versa. On first open after the upgrade:

1. The encrypted database is created and its schema installed.
2. If a plaintext database exists, every row is copied across — `seq`, `id`, `kind`, `payload`,
   `captured_at`, `idempotency_key`, `status`, `attempts`, `last_error` — inside one
   transaction. `seq` values are preserved exactly, so FIFO replay order is unchanged.
3. Only after that transaction commits is the plaintext file overwritten and deleted, along
   with its `-journal` / `-wal` / `-shm` sidecars.

If anything in step 2 throws, the plaintext file is left untouched and the failure propagates
out of `start()`. The failure mode is a visible, retryable error — never a queue that came back
mysteriously empty. These rows have never reached any server; losing them would be precisely
what the outbox exists to prevent.

This is a file-level cutover, not a `SQLiteOpenHelper` version step, so `DATABASE_VERSION`
stays at `1` and `onUpgrade` still throws. (`SECURITY_ARCHITECTURE.md` §2.1 suggested bumping
it; against a brand-new file that would be a no-op, since `onCreate` runs and `onUpgrade` never
fires. The guard against destructive upgrades is worth more than the version number.)

iOS has nothing to migrate: no build containing `OutboxStore.swift` has ever run on a device,
so no plaintext predecessor exists in any app container.

### Secure credential storage

The plugin also exposes `secureGet` / `secureSet` / `secureRemove`, which are **not** part of
the HTTP surface — they work whether or not the server is running. They exist because the
appliance API key was held by `capacitor-secure-storage-plugin`, which has two defects:

- **iOS**: writes with `kSecAttrAccessibleAfterFirstUnlock` — *not* `…ThisDeviceOnly`. Items in
  that class are included in encrypted iTunes/Finder backups and restore onto new hardware, so
  the long-lived appliance credential silently migrates with a backup, with no
  re-authentication and no device record on the server learning about it. Android's half is
  covered by `allowBackup="false"`; iOS has no equivalent lever for that keychain class.
- **Android**: falls back from AndroidKeyStore RSA wrapping to **plain Base64 in the same
  `MODE_PRIVATE` SharedPreferences file** if Keystore init throws for any reason, with only a
  `Log.e`. The credential degrades to reversible storage on disk while the app reports success.

`CompanionSecureStore` replaces it for credentials, in the same two namespaces described above
(credentials and outbox keys are kept separate so either can be destroyed without the other).
`@ci/common`'s `secureStorage*` helpers route here, read through to the old plugin once, and
move any value they find — writing the new copy **before** removing the old one, so the failure
mode is "briefly stored twice", never "stored nowhere".

### Explicitly out of scope in this pass

These are deliberate follow-up slices, not oversights:

- **Background flushing.** This pass flushes opportunistically while the app is in the
  foreground. An Android foreground service (and the iOS background-task equivalent) is
  future work.
- **Resumable large-media upload.** Payloads are ordinary JSON today; chunked/resumable
  media transfer is not implemented.
- **A recovery flow for a lost database key.** See `OutboxKeyLostException` above.
- **Remote wipe.** The crypto-shred primitives exist (`CompanionSecureStore.destroyKey()` on
  Android, `destroyAll()` on iOS) and are exercised by tests, but nothing calls them yet.

### Verification status

- **Android: verified on-device.** **42 instrumented tests, 0 failures**, run against a real
  bound socket, a real on-disk SQLCipher database, and the real AndroidKeyStore on an
  API-35 emulator.
  ```
  cd frontend/apps/mobile/android
  ./gradlew :ci-capacitor-local-hub:connectedDebugAndroidTest
  ```
  - `LocalHubServerTest` (30) — enqueue/list/counts/capacity, FIFO ordering (including a
    backwards-moving `capturedAt` and seq-reuse-after-delete), idempotent replay, the attempt
    and retry state machine, the `507` cap, `401` on every outbox route, concurrent enqueues
    from multiple threads, survival across closing and reopening the store against the same
    database file, **plus**: the database file on disk does not carry SQLite's magic header and
    contains neither the payload text nor the idempotency key; a different key cannot open it;
    an unusable keystore produces no database at all rather than an unencrypted one; and a real
    plaintext outbox built with the framework driver migrates across with every row, `seq`,
    `status`, `attempts`, `lastError`, payload and idempotency key intact, after which the
    plaintext file is gone.
  - `CompanionSecureStoreTest` (12) — round-trip, namespace isolation, key generation on
    hardware without StrongBox (the emulator, so the fallback path runs for real), a fresh IV
    per write, and the fail-closed cases: an unusable keystore entry makes `set` **throw and
    write nothing** — asserted by decoding what landed in SharedPreferences and by scanning
    `shared_prefs`/`files`/`databases`/`no_backup` for the secret in both raw and Base64 form —
    a replaced key reports decryption failure rather than "no value", and `destroyKey()` makes
    even a restored ciphertext unrecoverable.

  **What the durability test does not prove**: an instrumented test lives in one process, so
  it cannot literally force-quit the app or reboot the device. It proves the rows are
  genuinely committed to the database file and survive a fresh store/server/token opened
  against that file. True force-quit/reboot survival still wants a manual check.

  **What no test here proves**: that SQLCipher actually *skipped* PBKDF2 for the raw key. The
  `x'…'` form is SQLCipher's documented raw-key syntax and reaches `sqlite3_key()` unchanged
  (verified by reading `SQLiteOpenHelper`/`SQLiteConnection` in the `sqlcipher-android` sources
  jar), but whether the native side took the raw-key branch is a *performance* property with no
  observable API. Getting it wrong would mean a slower cold start, not a weaker database.
- **iOS: unverified.** See the section below -- there is no Mac in this environment, so
  none of the Swift has been compiled or run.

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
    LocalHubPlugin.kt        # @CapacitorPlugin(name = "LocalHub"): start/stop/getStatus + secure*
    LocalHubServer.kt        # NanoHTTPD subclass: loopback bind + bearer auth + routes
    OutboxStore.kt           # SQLCipher SQLiteOpenHelper-backed durable queue + plaintext migration
    OutboxDatabaseKey.kt     # 32-byte raw DB key: generate once, keep in CompanionSecureStore
    CompanionSecureStore.kt  # AndroidKeyStore AES-256-GCM value store; fails closed, never Base64
  src/androidTest/java/com/companionintelligence/localhub/
    LocalHubServerTest.kt        # on-device HTTP + SQLCipher + migration coverage
    CompanionSecureStoreTest.kt  # on-device AndroidKeyStore coverage, incl. the fail-closed paths
CapacitorLocalHub.podspec  # CocoaPods spec (Capacitor 7 iOS plugin structure)
ios/
  Sources/LocalHubPlugin/
    LocalHubPlugin.swift        # @objc CAPPlugin/CAPBridgedPlugin, jsName "LocalHub"
    LocalHubServer.swift        # GCDWebServer wrapper: loopback bind + bearer auth + routes
    OutboxStore.swift           # SQLCipher C-API durable queue; hand-kept in sync with OutboxStore.kt
    CompanionSecureStore.swift  # Keychain (…AfterFirstUnlockThisDeviceOnly) + the raw DB key
```

The Android and iOS stores share no code -- the schema, status vocabulary, `MAX_ATTEMPTS`,
and capacity policy are duplicated by hand and must be changed together.

> **Build gotcha:** `frontend/apps/mobile/node_modules/@ci/capacitor-local-hub` is a real
> *copy* of this package on a `node-modules`-linker install (not a symlink), and Gradle
> builds that copy. Editing a file here does not reach the build until `yarn install` is
> re-run inside `frontend/apps/mobile` -- and Gradle will still report `BUILD SUCCESSFUL`
> against the stale copy, so it looks like it worked. Re-run `yarn install` after every
> edit to this package.

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
- **The SQLCipher module import is the single riskiest line in the iOS half.**
  `OutboxStore.swift` says `import SQLCipher`, relying on CocoaPods building the
  `SQLCipher` pod as a framework module under this Podfile's `use_frameworks!` (its
  podspec has no `module_name`, so the module name is inferred from the pod name). If
  that inference is wrong the file will not compile -- which is the *safe* failure. The
  dangerous one is the opposite mistake: `import SQLite3` would bind to the OS's
  unencrypted SQLite, compile cleanly, run cleanly, and produce a **plaintext** database
  that looks encrypted from the outside. `s.library = 'sqlite3'` was removed from the
  podspec for the same reason (SQLCipher's own podspec defines `_SQLITE3_H_=1` on the
  consuming target specifically to keep the system header out). **First real build must
  verify the file, not just the compile**: enqueue an item, then check the database file
  does not begin with `SQLite format 3` -- the same assertion the Android suite makes.
- **The `PRAGMA key` / raw-key path** and `verifyKeyAccepted()`'s forced read of
  `sqlite_master` are written from SQLCipher's documented behaviour, not observed. So are
  the `.completeUntilFirstUserAuthentication` protection class and
  `isExcludedFromBackup` on the database file.
- **`CompanionSecureStore.swift` is entirely unrun.** The `SecItemAdd` ->
  `errSecDuplicateItem` -> `SecItemUpdate` sequence, the `kSecUseDataProtectionKeychain`
  attribute appearing in *both* the write attributes and the lookup query, and the
  re-assertion of `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` on update (which is
  what upgrades an item written by the old plugin in place) are all reasoned from Apple's
  documentation. The behaviour that matters most -- that a restored encrypted backup does
  **not** carry the credential onto new hardware -- can only be verified with two real
  devices and a real backup/restore cycle.
- **App Transport Security**: no `Info.plist` changes were made *for the sidecar*. Reasoning: the
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

### Outbox on iOS -- additional unverified surface

`ios/Sources/LocalHubPlugin/OutboxStore.swift` and the outbox routes in
`LocalHubServer.swift` were written the same way: by reading APIs, not by compiling. On top
of the caveats above, these specifically have never been exercised:

- **The whole SQLite3 C-API layer.** `import SQLite3`, `sqlite3_open_v2`,
  `sqlite3_prepare_v2`/`bind`/`step`/`finalize`, the `SQLITE_TRANSIENT` `unsafeBitCast`
  idiom, and `String(cString:)` on `sqlite3_column_text` are all standard and used widely
  in Swift, but not one line has been run here. The Android side's identical schema *has*
  been verified on-device, so the SQL itself is sound; the Swift binding around it is not.
- **`s.library = 'sqlite3'` in the podspec** was added defensively -- whether autolinking
  alone would have sufficed under this Podfile's settings is unconfirmed.
- **Handler registration order.** The router relies on GCDWebServer matching handlers
  LIFO (last registered wins), with `addDefaultHandler` catch-alls registered first so
  every unmatched path still answers with CORS headers and auth-before-dispatch. That
  ordering rule comes from GCDWebServer's documentation, not from observing it.
- **Swift argument labels.** `addHandler(forMethod:path:request:processBlock:)` /
  `addDefaultHandler(forMethod:request:processBlock:)` assume the ObjC importer's
  omit-needless-words rule turns `requestClass:` into `request:` (the headers carry no
  `NS_SWIFT_NAME`). If that assumption is wrong, every registration call needs the same
  one-word fix.
- **Multi-statement closure return types** are annotated explicitly throughout
  (`{ () -> T in }`) precisely because no compiler was available to catch an inference
  failure.
- **`Library/Application Support/<bundle id>/` as the database location** is reasoned from
  Apple's guidance (app-private, backed up, not exposed via file sharing the way
  `Documents/` can be) but has not been observed on a device or simulator.

Building, `pod install`, and on-device/simulator testing all need to happen on an
actual Mac with Xcode before this ships. Treat the Android implementation as the reference
behavior and the iOS one as a port awaiting its first compile.

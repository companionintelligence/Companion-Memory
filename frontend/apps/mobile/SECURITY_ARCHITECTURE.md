# Companion Mobile — Security & Privacy Architecture

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**
>
> Design for making the phone an **ETL source** for the user's own appliance without
> making the phone the weakest link in the chain. Companion to
> [`DELIVERY.md`](./DELIVERY.md) (store submission + roadmap) and
> [`README.md`](./README.md) (how the shell is built). This file is the **threat model,
> the control design, and the ordered slice list** — including the hard gates that say
> which data source may not be ingested until which control exists.

---

## 0. TL;DR

The app is about to start reading health, location, motion, contacts and photo metadata
off the device. Today the two places that data would land — the Local Hub sidecar's
SQLite outbox and the PowerSync copy in the WebView — are **both plaintext**, the
long-lived API key that authenticates the device is stored with **weaker guarantees than
the code comments claim**, and there is **no way to revoke a lost phone's access and have
its local copy become unreadable**.

None of that is a bug in what shipped. Every piece of it was scoped out deliberately and
is marked as such in the source. The point of this document is to put the pieces back in
an order where each new data source lands behind the control that makes it defensible.

**The five things this document actually decides:**

| # | Decision |
|---|---|
| 1 | **SQLCipher owns all durable device data.** The sidecar's SQLite DB gets SQLCipher with a raw 32-byte key from the OS keystore. The WebView's IndexedDB copy is not encryptable in any honest sense — so the answer is to stop putting sensitive data there, which the sidecar-owns-storage pivot already in flight does for free. |
| 2 | **The DB key is never biometric-gated; the UI is.** Gating the DB key breaks background ingest. Biometric app-lock is a presentation gate over the WebView, not a data gate. |
| 3 | **Encryption at rest is a hard prerequisite for remote wipe**, not an orthogonal feature — "wipe" without it is `File.delete()` on recoverable plaintext pages. With it, destroying one keystore entry crypto-shreds the whole vault. |
| 4 | **Cleartext cannot be scoped with `networkSecurityConfig`** — the schema has no CIDR support, and the appliance can be any LAN IP. Tailscale Serve is the only path that makes "encrypted in transit" true; ship it as the recommended onboarding path and gate `http://` behind a private-range check plus an interstitial. |
| 5 | **Communications content is not a mobile problem.** Play's restricted-permissions policy makes `READ_SMS`/`READ_CALL_LOG` effectively unshippable for a memory vault, and iOS exposes no equivalent API at all. Contacts ship metadata-only with tokenized identifiers; message/call *content* routes through CI-Import-Tools on desktop, where it is a deliberate archival act rather than a background daemon. |

**Two defects this audit found in code that is already shipping** (§2.4) — both cheap,
both blocking nothing, both worth fixing before the next data source lands.

**Convention used throughout:** **[V]** = verified by reading the code in this repo, with
the file cited. **[P]** = proposed, not built. Anything not marked **[V]** is a proposal.

---

## 1. What is actually true today

Every row below was read, not assumed.

### 1a. Credential storage

| Fact | Where | Status |
|---|---|---|
| Native auth is a long-lived API key sent as `x-api-key`, held in a module singleton so the request layer can read it synchronously | [`common/src/utils/apiAuth.ts`](../../packages/common/src/utils/apiAuth.ts) | **[V]** |
| Key + key id persist under `ci.apiKey` / `ci.apiKeyId` via `secureStorage*` → `capacitor-secure-storage-plugin` | [`hooks/useAuth.ts:24-25`](../web/src/hooks/useAuth.ts), [`common/src/utils/nativeBridge.ts:110-167`](../../packages/common/src/utils/nativeBridge.ts) | **[V]** |
| The appliance base URL is *also* mirrored into the keystore so native App Intents can read it | `nativeBridge.ts:393-411` (`syncNativeIntentConfig`) | **[V]** |
| **iOS**: the plugin writes with `withAccessibility: .afterFirstUnlock` — *not* `…ThisDeviceOnly` | `node_modules/capacitor-secure-storage-plugin/ios/Plugin/SecureStoragePluginPlugin.swift:15` | **[V]** — see §2.4 |
| **Android**: an RSA/ECB/PKCS1 keypair in AndroidKeyStore (alias `<pkg>_cap_sec`) wraps values stored in the `cap_sec` SharedPreferences file — with a **silent fallback to unencrypted Base64 in the same file** if Keystore init throws | `node_modules/capacitor-secure-storage-plugin/android/…/PasswordStorageHelper.java:53-67, 102-146` | **[V]** — see §2.4 |
| `android:allowBackup="false"` keeps that SharedPreferences file out of adb/cloud backup | [`AndroidManifest.xml`](./android/app/src/main/AndroidManifest.xml) | **[V]** |

### 1b. Local durable stores

| Fact | Where | Status |
|---|---|---|
| The sidecar's outbox is **plaintext SQLite** in app-private internal storage (`ci_local_hub_outbox.db`), protected only by the app sandbox + full-disk encryption. The source says so explicitly and carries a `TODO(local-hub): SQLCipher-backed encryption at rest` | [`OutboxStore.kt:60-63`](../../packages/capacitor-local-hub/android/src/main/java/com/companionintelligence/localhub/OutboxStore.kt) | **[V]** |
| Payloads are stored as raw JSON `TEXT` — whatever a capture contains sits in the clear | `OutboxStore.kt:98, 150` | **[V]** |
| `onUpgrade` **throws** rather than migrating — deliberately, so an upgrade can never drop unflushed user data | `OutboxStore.kt:112-117` | **[V]** — makes adding SQLCipher a schema-version event, see §2.1 |
| Hard cap 5000 items, rejects rather than evicts (HTTP 507) | `OutboxStore.kt:339`, [`outbox.ts:51`](../../packages/common/src/utils/outbox.ts) | **[V]** |
| **iOS has no outbox at all yet** — `LocalHubServer.swift` mentions it only in comments | `capacitor-local-hub/ios/Sources/LocalHubPlugin/*.swift` | **[V]** |
| PowerSync keeps a local SQLite copy in the WebView via `IDBBatchAtomicVFS` (IndexedDB), file `ci-powersync.db`. The comment states this is the only VFS that works without cross-origin-isolation headers the Capacitor webview can't set — "Do not switch to OPFSCoopSyncVFS or similar" | [`PowerSyncProvider.tsx:27-39`](../web/src/api/powersync/PowerSyncProvider.tsx) | **[V]** |
| Installed version is `@powersync/web@1.39.1` | `.yarn/cache/@powersync-web-npm-1.39.1-…zip` | **[V]** |
| Logout calls `database.disconnect()`, **not** `disconnectAndClear()` — locally synced rows survive logout. Flagged in-source as a known gap | `PowerSyncProvider.tsx:43-51` | **[V]** — this is the wipe primitive, see §4 |
| `PowerSyncProvider` is mounted unconditionally in the app tree — no feature flag | `App.tsx:101` | **[V]** |

### 1c. The sidecar's own security boundary

All **[V]**, from
[`LocalHubServer.kt`](../../packages/capacitor-local-hub/android/src/main/java/com/companionintelligence/localhub/LocalHubServer.kt)
and
[`LocalHubPlugin.kt`](../../packages/capacitor-local-hub/android/src/main/java/com/companionintelligence/localhub/LocalHubPlugin.kt):

- Binds **explicitly to `127.0.0.1`**, never `0.0.0.0`, on an OS-assigned ephemeral port.
- Every route requires a **per-launch bearer token**: 32 bytes of `SecureRandom`,
  base64url, **never persisted to disk** (`LocalHubPlugin.kt:165-170`).
- Compared in **constant time** (`LocalHubServer.kt:310-319`); the Swift side mirrors it.
- The auth check runs in the router *before* dispatch, so an unauthenticated caller
  cannot probe which routes exist.
- CORS is `Access-Control-Allow-Origin: *` with a fixed `Access-Control-Allow-Headers`
  allowlist. The reasoning in-source is sound: the bearer token is the actual gate, and
  the wildcard only lets the browser *read* a response it could not have produced without
  the token. **The token is the whole boundary** — which is why `fetchJson`'s
  `skipApiKey` option exists (`fetchJson.ts:5-15`), so the appliance's `x-api-key` never
  leaks to a different origin.

This is a good boundary and this document proposes no changes to it. The gap is
underneath: the data the boundary protects is on disk in the clear.

### 1d. Transport

| Fact | Where | Status |
|---|---|---|
| `android:usesCleartextTraffic="true"` app-wide; **no** `networkSecurityConfig`; `res/xml/` contains only `config.xml` and `file_paths.xml` | `AndroidManifest.xml`, `android/app/src/main/res/xml/` | **[V]** |
| `androidScheme: 'https'` + `android.allowMixedContent: true` | [`capacitor.config.ts`](./capacitor.config.ts) | **[V]** |
| iOS is already narrower: `NSAllowsArbitraryLoadsInWebContent`, not the app-wide `NSAllowsArbitraryLoads` | [`Info.plist`](./ios/App/App/Info.plist) | **[V]** |

### 1e. Server-side revocation

| Fact | Where | Status |
|---|---|---|
| `DELETE /api/keys/:id` **hard-deletes the row**; `validateKey` then finds nothing and returns null → 401 on every subsequent request | [`ApiKeyService.ts:322-329, 361-398`](../../../backend/apps/api/src/domains/auth/services/ApiKeyService.ts) | **[V]** |
| Every `/api/keys` route is guarded by `JwtOrPortalAuthGuard` — **never an API key**, explicitly "so a leaked key cannot mint successors that outlive its revocation" | [`ApiKeyController.ts:74-79`](../../../backend/apps/api/src/domains/auth/controllers/ApiKeyController.ts) | **[V]** |
| Keys are SHA-256 hashed at rest, 32 random bytes, with `scopes` (`memory`/`intents`/`mcp`) and `capability` (`read`/`write`/`full`) as two orthogonal axes | `ApiKeyService.ts:46-48, 400-402`, `ApiKeyCapability.ts` | **[V]** |
| `ci.devices` exists with `is_active`, `push_token`, and an **unused `privacy_settings` jsonb** column | [`DeviceEntity.ts:51-65`](../../../backend/apps/api/src/domains/devices/entities/DeviceEntity.ts) | **[V]** |
| **`ci.devices` and `ci.api_keys` are unrelated tables** — no FK, no column joining them | both entities | **[V]** — this is the missing link for §4 |
| Account deletion is soft-delete + `purge_after`; **the purge job does not exist** | `UserEntity.ts:65,69`; [`DELIVERY.md`](./DELIVERY.md) §1a | **[V]** |

### 1f. Every place bytes leave the app

This list is the input to §5. All **[V]**.

| Lane | Choke point | Coverable by a JS hook? |
|---|---|---|
| REST (incl. outbox flush, health probes) | single `fetch()` at [`fetchJson.ts:202`](../../packages/common/src/utils/fetchJson.ts) | ✅ yes |
| GraphQL | `createHttpLink({ uri: buildApiUrl('/api/graphql') })` + `setContext` auth link, [`ApolloProvider.tsx:23-37`](../web/src/api/ApolloProvider.tsx) | ✅ yes, via a custom `fetch` |
| PowerSync credentials + upload | own `fetch` calls in [`powersync/connector.ts`](../web/src/api/powersync/connector.ts) | ✅ yes |
| **PowerSync download stream** | opened inside `@powersync/web`, in a Web Worker | ❌ **no** — not reachable from app code |
| LLM generate (remote fallback) | raw `fetch` at `nativeBridge.ts:501` | ⚠️ bypasses `fetchJson` |
| CSRF prime / logout | raw `fetch` in `useAuth.ts` (`primeCsrfCookie`, `postLogout`) | ⚠️ bypasses `fetchJson` |
| **Esri basemap tiles** | `<TileLayer url="https://server.arcgisonline.com/…">` at [`Map.tsx:40-41`](../web/src/components/Map/Map.tsx) | ❌ **no** — Leaflet loads tiles as `<img>` |
| Server-side third-party egress (Google geocoder, TMDB, unpkg) | [`docs/architecture/third-party-egress.md`](../../../docs/architecture/third-party-egress.md) | n/a — off-device |

The Esri row is the one that matters most for the sovereignty claim and is invisible to
every JS-level hook. `third-party-egress.md` already establishes that it fires
unconditionally in a normal session, with no attribution shown.

---

## 2. Encryption at rest

### 2.1 The sidecar outbox — SQLCipher (Android)

**[P]** Replace `android.database.sqlite.SQLiteOpenHelper` with SQLCipher's drop-in
equivalent. `OutboxStore` extends `SQLiteOpenHelper` directly (`OutboxStore.kt:84`), so
this is a base-class swap plus a key argument, not a rewrite — the FIFO/`AUTOINCREMENT`
semantics, the `writeLock` discipline, and the transaction boundaries all carry over
unchanged.

**Dependency.** `net.zetetic:sqlcipher-android:4.6.x` (package
`net.zetetic.database.sqlcipher`) — the current Zetetic artifact, AOSP-derived bindings,
BSD-style licensed Community Edition. The legacy artifact
`net.zetetic:android-database-sqlcipher` (package `net.sqlcipher.database`) is the older
line; do not mix them. **Pin and verify the exact current version at implementation
time** — this repo cannot resolve Maven.

**Size cost.** SQLCipher ships a native `.so` per ABI (it bundles its own SQLite +
crypto). Budget **roughly 2.5–4 MB per ABI** in the APK; with `arm64-v8a` +
`armeabi-v7a` that is roughly **+4–7 MB** to a universal APK, and roughly **+2.5–4 MB**
to what any one device actually downloads from an AAB, since Play splits per ABI.
**Measure it before and after** — these are order-of-magnitude figures, not a commitment.

⚠️ **Two consequences elsewhere, both of which invalidate a line in `DELIVERY.md`:**

1. **16 KB page size stops being a no-op.** `DELIVERY.md` §1a says "likely a no-op — no
   native libs." That is *already* false: `@ci/capacitor-local-llm` pulls
   `com.google.ai.edge.litertlm:litertlm-android:0.11.0` **[V]**, which ships native
   libraries. SQLCipher makes it doubly so. Both need an API-35 device check.
2. **`ITSAppUsesNonExemptEncryption=false` needs re-examination on iOS.** The Info.plist
   comment states the basis as "only exempt standard cryptography (HTTPS/TLS via the OS,
   Keychain)" **[V]**. Bundling SQLCipher adds non-OS AES-256. The likely outcome is
   still exempt (mass-market, open-source implementation), **but the stated basis becomes
   untrue**, and the `DELIVERY.md` checkbox that marks this done must be re-opened and
   confirmed with counsel. Do not silently leave `false` in place.

**Migration.** `onUpgrade` currently throws (`OutboxStore.kt:112-117`) because dropping
the table would lose unflushed captures. A SQLCipher file is not readable by the plain
driver, so the cutover is: on first launch after upgrade, if the plaintext
`ci_local_hub_outbox.db` exists, open it with the plain driver, copy every row into a new
encrypted `ci_local_hub_outbox_enc.db`, `fsync`, then **overwrite-and-delete** the
plaintext file. Bump `DATABASE_VERSION` and give `onUpgrade` a real v1→v2 path for the
encrypted file going forward. Deleting a file does not zero its pages, so overwrite the
plaintext file's bytes before unlinking — best-effort on flash with wear-levelling, but
the right gesture.

### 2.2 The sidecar outbox — SQLCipher (iOS)

**[P]** iOS has no outbox yet **[V]**, so there is nothing to migrate — build it
encrypted from the first commit. Options, in order of preference:

- **GRDB.swift with the SQLCipher subspec** (`pod 'GRDB.swift/SQLCipher'`) — gives a
  typed, well-tested DB layer and takes a `passphrase` in its `Configuration`. Heavier
  dependency, much less hand-rolled SQL.
- **`pod 'SQLCipher', '~> 4.6'`** directly against the C API — minimal, matches the
  Android implementation's shape one-for-one, no ORM to learn.

**Size cost:** compiled into the binary, arm64-only slice; budget **+1.5–3 MB** to the
IPA. Again: measure.

Independently of the driver: create the DB file under `Library/Application Support/`
(not `Documents/`), set `NSURLIsExcludedFromBackupKey` on it, and set its data-protection
class explicitly to `.completeUntilFirstUserAuthentication`. That class is the correct
pairing for the keychain accessibility chosen in §3 — both mean "available after the
first unlock following boot," which is what background ingest needs.

### 2.3 The PowerSync IndexedDB copy — be honest

**This one does not have a good answer, and pretending otherwise would be the dishonest
part of this document.**

What is actually available:

| Option | Verdict |
|---|---|
| An encryption option on `@powersync/web` | **Does not exist at v1.39.1.** `WASQLiteOpenFactory` is constructed with `dbFilename` and `vfs` only **[V]**. PowerSync's SQLCipher support lives in the React Native SDK, not the web one. Re-check on upgrade; do not assume. |
| Rely on the OS | This is what happens today, and it is **exactly the same protection the plaintext outbox has**: Android WebView IndexedDB lives in the app data dir (`app_webview/Default/IndexedDB/`), WKWebView storage lives in the app container. App sandbox + full-disk encryption, no more. Honest framing: "unencrypted" here means "no better than the sandbox," not "world-readable." |
| Application-layer field encryption in JS | Technically possible; **defeats the point.** You lose local SQL filter/sort/index on any encrypted column — which is the entire reason PowerSync exists — and the server holds plaintext anyway, so the sync rules gain nothing. Not recommended. |
| A page-encrypting custom VFS wrapping `IDBBatchAtomicVFS` | Real (wa-sqlite supports VFS registration) but it means forking a load-bearing dependency, PowerSync does not support it, and **the key still lives in the JS heap** — reachable from any XSS in the bundle. Buys "at rest while the app is not running," which FDE already gives on a powered-off device. High cost, narrow benefit. |

The unfixable part is **key custody**: anything you hand to JS is in the WebView heap.
You can fetch it from the native keystore over the bridge at boot, and from that instant
it is a string in a JavaScript VM you do not control the memory of.

**Therefore: the recommendation is not to encrypt IndexedDB. It is to stop putting
sensitive data in it.**

The sidecar-owns-all-storage pivot already in flight makes this moot, and this is one of
the reasons the design prefers that path. The plugin README's Phase 3 already plans
"local mirrors of the read endpoints CI-Server's memory domain exposes today … served
from the same Local Hub process" **[V]**. Once reads come from the sidecar's SQLCipher DB
over the loopback API, the WebView holds no durable copy — it holds a render buffer.

**The interim rule, and it is a hard gate:** the PowerSync sync-rules set is **frozen at
its current contents** (notes, threads, messages, entity_tags, tags, files metadata) until
either the pivot lands or PowerSync ships web encryption. **No device-sourced table —
health, location, contacts, motion, app usage — may be added to `sync-rules.yaml` while
the local copy is plaintext IndexedDB.** That is gate G-2 in §8.

Cheap interim mitigation, worth doing now: change the logout path to
`disconnectAndClear()` instead of `disconnect()`, closing the gap already documented at
`PowerSyncProvider.tsx:43-51` **[V]**. It is a small change and it is also the wipe
primitive §4 needs.

### 2.4 Two defects in shipping code

Found while verifying §1a. Neither is exotic; both are the kind of thing a dependency's
defaults quietly decide for you.

🔴 **D1 — iOS: the API key is in encrypted device backups and restorable to a different
phone.** `capacitor-secure-storage-plugin` writes with
`withAccessibility: .afterFirstUnlock` **[V]**, which maps to
`kSecAttrAccessibleAfterFirstUnlock`. Items in that class are **included in encrypted
iTunes/Finder backups** and restore onto new hardware. The `…ThisDeviceOnly` variants are
the ones excluded. So the app's long-lived, non-expiring appliance credential migrates
with a backup — silently, with no re-authentication and no device record on the server
learning about it. Android's side of this is covered by `allowBackup="false"` **[V]**;
iOS has no equivalent lever for a keychain item in that class.

🔴 **D2 — Android: silent fallback to unencrypted storage.** `PasswordStorageHelper`
tries `PasswordStorageHelper_SDK18` (AndroidKeyStore RSA wrapping) and, **if
initialisation throws for any reason, falls back to `PasswordStorageHelper_SDK16` —
plain Base64 in the same `MODE_PRIVATE` SharedPreferences file, no encryption at all**
**[V]**, with only a `Log.e`. On a device with a damaged or locked-out keystore the API
key degrades to Base64 on disk and the app reports success. `allowBackup="false"` keeps
that file off cloud/adb backup, so the exposure is a rooted or forensically imaged
device — which is precisely the threat encryption-at-rest exists for.

**[P] Fix for both: stop using `capacitor-secure-storage-plugin` for the API key.** The
Local Hub plugin already has native code on both platforms and, per §3, already needs a
Keystore/Keychain path for the DB key. Add two methods to it — `secureGet`/`secureSet`
against a `CompanionSecureStore` — with:

- **iOS:** `kSecClassGenericPassword`,
  `kSecAttrAccessible = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`,
  `kSecUseDataProtectionKeychain = true`.
- **Android:** AES-256-GCM key in AndroidKeyStore, `setUnlockedDeviceRequired(true)` on
  API 28+, StrongBox via `setIsStrongBoxBacked(true)` with a documented fallback on
  `StrongBoxUnavailableException` — and **failing closed** rather than writing plaintext.

`nativeBridge.ts`'s `secureStorage*` helpers already abstract the plugin behind three
functions **[V]**, so the call sites (`useAuth.ts`, `syncNativeIntentConfig`) do not
change. Keep `capacitor-secure-storage-plugin` for non-credential values if convenient,
or drop it.

**This is the cheapest high-value slice in the document and it blocks nothing.** Do it
first (S0 in §8).

### 2.4.1 [V] Partial fix shipped on iOS — `KeychainHardening` (2026-08-13)

The full S0 replacement above is still the right destination. In the meantime the **iOS**
half of D1 is mitigated in-repo by
[`ios/App/App/KeychainHardening.swift`](./ios/App/App/KeychainHardening.swift), which
sweeps every `cap_sec` item to `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` via
`SecItemUpdate`. `AppDelegate` runs it at launch and again on entering the background —
the second call matters because the web layer can store a fresh key mid-session, and a
device backup realistically happens after the app has left the foreground.

**Why a sweep and not simply asking the plugin to write the right class.** That looks like
a one-line change and is a trap: `SwiftKeychainWrapper.update` puts `kSecAttrAccessible`
into the **query** dictionary, where it is a *match constraint*, not a change. Asking it
for `…ThisDeviceOnly` would therefore fail to match any item already stored as
`…AfterFirstUnlock`, `SecItemUpdate` would return `errSecItemNotFound`, and `set()` would
return `false` — credential saving would break on upgrade for exactly the users who
already have a key. `KeychainHardening` matches on service+account only and puts the
accessibility in the *attributes-to-update* dictionary, which `SecItemUpdate` does accept.

**[V] — verified at runtime**, not reasoned about. A temporary probe (added, run, removed)
seeded an item with `kSecAttrAccessibleAfterFirstUnlock` on an iOS 27 simulator and logged
the sweep's effect:

```
PROBE seed add status=0
PROBE before=ck        # kSecAttrAccessibleAfterFirstUnlock — backup-migratory
PROBE upgraded=1
PROBE after=cku        # …AfterFirstUnlockThisDeviceOnly — the "u" is ThisDeviceOnly
PROBE idempotent_second_run_upgraded=0
PROBE value_after=seeded-secret   # the stored secret survived the change
```

**Two caveats, stated plainly.** This is a mitigation layered on a wrong write, so a write
followed by a backup with *no* intervening background transition is still theoretically
migratory — S0 remains the real fix. And it covers **iOS only**; D2, the Android Keystore
fallback that silently writes plain Base64 to SharedPreferences, is untouched and is still
the more severe of the two.

> **Incidental finding worth knowing:** an **unsigned** build cannot use the Keychain at
> all — `SecItemAdd` returns `-34018` (`errSecMissingEntitlement`). That is the
> configuration `mobile-build.yml` produces (`CODE_SIGNING_ALLOWED=NO`), so its artifact
> cannot exercise sign-in, the API key, or the App Intents' `CompanionConfig` read. Not a
> shipping bug — real builds are signed — but do not read "the unsigned CI build launched
> fine" as evidence that the credential path works.

---

## 3. Key management

### 3.1 Where the DB key lives, and in what form

**[P]** The SQLCipher key is **32 random bytes, used as a raw key** — passed as
`PRAGMA key = "x'<64 hex chars>'"` so SQLCipher **skips PBKDF2 entirely**.

That is the right call for a specific reason: PBKDF2 exists to stretch a *low-entropy*
secret (a human passphrase). There is no passphrase here — native auth is an API key, not
a password the user types at launch **[V]**. Stretching 256 bits of CSPRNG output buys
nothing and costs measurable milliseconds on every cold start, on the critical path of
`start()`, which `LocalHubPlugin` deliberately does eagerly so a corrupt outbox is a
visible failure (`LocalHubPlugin.kt:122-133`) **[V]**.

**Android:**
1. Generate 32 bytes from `SecureRandom` on first run.
2. Generate an AES-256-GCM wrapping key in AndroidKeyStore, alias
   `com.companionintelligence.app.outbox_dek`:
   `setBlockModes(GCM)`, `setEncryptionPaddings(NONE)`,
   `setUserAuthenticationRequired(false)` (see §3.3),
   `setUnlockedDeviceRequired(true)` on API 28+,
   `setIsStrongBoxBacked(true)` with a fallback on `StrongBoxUnavailableException`.
3. Store `IV || ciphertext` in an app-private file. The DB key never exists on disk
   unwrapped; the wrapping key never leaves the TEE/StrongBox.
4. Handle `KeyPermanentlyInvalidatedException` explicitly — see §3.4.

**iOS:**
1. Generate 32 bytes with `SecRandomCopyBytes`.
2. Store them directly in the Keychain as a `kSecClassGenericPassword` item with
   `kSecAttrAccessible = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` and
   `kSecUseDataProtectionKeychain = true`.

**Why `AfterFirstUnlockThisDeviceOnly` specifically — both halves matter:**

- **`ThisDeviceOnly`** excludes the item from iCloud Keychain *and* from encrypted device
  backups. This is load-bearing: the encrypted outbox **file** will be in a backup unless
  you exclude it (§2.2 says to exclude it, but belt and braces). If the key travelled
  with the backup too, the entire vault would silently migrate to new hardware — the
  exact failure D1 already exhibits for the API key. With `ThisDeviceOnly`, a restored
  backup yields a DB file that **cannot be opened**, which is the correct outcome: the
  new device re-authenticates and re-syncs from the user's own server.
- **`AfterFirstUnlock`, not `WhenUnlocked`.** The sidecar must be able to write while the
  screen is locked — a background location update, a `BGProcessingTask` flush, a
  background `URLSession` completion. `WhenUnlocked` would fail those with
  `errSecInteractionNotAllowed`, and the failure mode is invisible: captures silently
  stop queueing whenever the phone is in a pocket. `AfterFirstUnlock` means the key is
  available from the first post-boot unlock until power-off, which is the correct trade
  for a background ingest daemon.

### 3.2 The tokenization pepper

**[P]** §7 introduces a per-install pepper for hashing third-party identifiers. It lives
in the **same storage, same protection class, same lifecycle** as the DB key — with one
additional, absolute rule: **the pepper is never synced, never backed up, and never sent
to the server.** If it reaches the server, tokenization stops being a minimization
measure and becomes theatre, because the server could re-derive the token for any
candidate identifier it can guess (and phone numbers are eminently guessable).

### 3.3 Biometric gating of the DB key: **no**

**[P] Recommendation: do not set `setUserAuthenticationRequired(true)` on the wrapping
key, and do not put `kSecAccessControl` biometry on the keychain item.**

Rationale: the DB key must be usable by background work. `setUserAuthenticationRequired`
makes the Keystore key unusable without a recent authentication event, so a WorkManager
flush or a background location callback would fail on a locked phone. That converts
"queue a capture" from a durability guarantee into "durability, if you happened to have
unlocked your phone in the last N seconds" — and the outbox's entire contract is that
`ok: true` means "this survives a reboot" **[V]** (`outbox.ts:256-262`).

This is not a shortcut. **Encryption-at-rest and app-lock defend different threats:**
encryption defends against a stolen/imaged device; the app-lock defends against a
borrowed or shoulder-surfed unlocked device. Conflating them buys a marginal improvement
against the first threat at the cost of breaking background ingest entirely.

**[P]** Where biometry *is* appropriate: a **second, separate** key gating a narrow set of
UI actions — exporting the vault, viewing a health or messages surface, revealing the raw
API key in Settings. That key can carry `setUserAuthenticationRequired(true)` with a short
validity window, because nothing background needs it.

### 3.4 Backup, restore, and device migration

**[P]** The behaviours to build and test:

| Event | Behaviour | Mechanism |
|---|---|---|
| Android cloud/adb backup | Nothing app-private is backed up | `allowBackup="false"` **[V]** — already correct |
| iOS encrypted backup | DB file excluded; key excluded | `NSURLIsExcludedFromBackupKey` + `…ThisDeviceOnly` |
| **Restore onto a new device** | The DB is unopenable and the API key is absent → the app lands on the server/sign-in screen and re-syncs from the user's own appliance | Follows from the two rows above. **This is the designed outcome, not a bug**, and the onboarding copy must say so: "your memories live on your server; a new phone re-downloads them." |
| Android biometric enrolment change / screen-lock removal | `KeyPermanentlyInvalidatedException` on the wrapping key | **Catch it explicitly.** The DB is now unrecoverable. Handle it as a local-only reset: delete the DB, keep the API key, resync — **but first count the unflushed outbox rows and warn the user by name**, because those captures never reached any server and are about to be lost. Never swallow this exception. |
| User changes the appliance URL | Do **not** rotate the DB key or wipe | The outbox is device state, not server state; a user correcting a typo must not lose queued captures |

⚠️ The `KeyPermanentlyInvalidatedException` row is the one most likely to be handled by a
bare `catch (Exception e)` and silently turn into data loss. Write the test.

---

## 4. Biometric app-lock

`DELIVERY.md` §3 already lists this as a **Now**-phase item with the exact justification:
"a private memory app holding a long-lived API key in the keystore should gate access."
**[V]**

### 4.1 Plugin and native APIs

**[P]** Candidates, to be version-checked against Capacitor 7 at implementation time
(this repo cannot resolve npm):

- **`@aparajita/capacitor-biometric-auth`** — maintained, exposes `checkBiometry()` /
  `authenticate()` / `BiometryType`, handles the enrolled-vs-available distinction that
  most wrappers get wrong.
- **`@capgo/capacitor-native-biometric`** — the maintained fork of
  `capacitor-native-biometric`.

What is *certain* is the layer underneath, and the plugin choice should be judged on
whether it exposes these faithfully:

- **Android:** `androidx.biometric:biometric` → `BiometricPrompt` with
  `setAllowedAuthenticators(BIOMETRIC_STRONG or DEVICE_CREDENTIAL)`.
- **iOS:** `LAContext.evaluatePolicy(.deviceOwnerAuthentication)` —
  **`.deviceOwnerAuthentication`, not `.deviceOwnerAuthenticationWithBiometrics`.** The
  former falls back to the device passcode; the latter does not, which locks a user with
  no enrolled biometric (or a failed Face ID) out of **their own memory vault** with no
  recovery path. This is the single most common way this feature ships broken.
- **iOS Info.plist needs `NSFaceIDUsageDescription`**, which is **absent today** **[V]**.
  Without it the app crashes on first Face ID use.

### 4.2 Lock/unlock lifecycle

**[P]**

| Trigger | Behaviour |
|---|---|
| Cold start | Locked |
| `appStateChange { isActive: false }` | Start the grace timer. The listener already exists: `addAppStateListener` at `nativeBridge.ts:210` **[V]** |
| Return to foreground after grace expiry | Locked |
| Grace period | User-configurable: Immediately / 30 s / 5 min / Never. Default **30 s** — long enough that answering a notification does not demand a face scan, short enough that a handed-over phone re-locks |
| Failed auth | No lockout counter of our own; the OS already rate-limits and falls back to passcode |
| Backgrounded (any duration) | **Screen contents obscured immediately**, independent of the grace timer |

That last row is a distinct control and easy to miss: the OS screenshots your app for the
task switcher.

- **Android:** `getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, FLAG_SECURE)`.
  For a memory vault, recommend **always on**, not just while locked — it also blocks
  screenshots and screen recording. Note the trade: it blocks the *user's* screenshots
  too, so make it a setting, default on.
- **iOS:** overlay a blur/branded view on `sceneWillResignActive`, remove it on
  `sceneDidBecomeActive`. `SceneDelegate` already exists in the project **[V]**.

### 4.3 What the lock covers

**[P] v1: a React route gate + `FLAG_SECURE` + the iOS blur overlay.** Cheap, ships with
the plugin, and covers the realistic threat (someone picks up an unlocked phone).

**[P] v2: a native overlay above the Capacitor bridge WebView.** A React-route lock is a
presentation trick — the underlying page is still mounted and rendering, and anything
that can drive the router can get past it. A native `UIViewController` / Android `View`
layered over the WebView is the real control. Honest note: this is native shell work in
`MainActivity` / `CAPBridgeViewController`, more than a plugin call, and unverified here.

### 4.4 In-flight sync while locked — the load-bearing decision

**[P] The app-lock is a presentation gate. Sync does not stop.**

The outbox flush and the PowerSync upload queue **continue while the app is locked.**

Rationale: a durably queued capture is the user's data waiting to reach the user's own
server. Blocking that behind a face scan means a phone that sits in a pocket never syncs —
and the queue has a hard 5000-item cap that **rejects** rather than evicting **[V]**, so a
long enough lock does not just delay captures, it starts refusing them.

This is precisely why §3.3 refuses to biometric-gate the DB key. **If the DB key were
biometric-gated, this decision would be impossible to implement** — the flusher could not
open the database. The two sections are one decision.

**Current state note:** `outboxFlush.ts` is explicitly "opportunistic, foreground-only"
**[V]** (`outboxFlush.ts:11-13`), and the drain is driven by `useOutboxQueue` off
connection-mode changes inside the WebView. So today "locked" and "not flushing" largely
coincide and this decision is theoretical. **It stops being theoretical the moment the
background-flush slice lands**, which is exactly why it needs to be settled now rather
than discovered then.

Corollary for the UI: the lock screen should show queue depth ("3 captures waiting to
sync") without unlocking. Knowing *that* something is queued is not sensitive; knowing
*what* is.

---

## 5. Remote revoke + wipe

### 5.1 What exists and what is missing

`DELETE /api/keys/:id` already hard-deletes the row, and `validateKey` returns null for a
missing row, so **revocation of access already works and is immediate** **[V]**. The
client already stores `ci.apiKeyId` (`useAuth.ts:25`) **[V]** — exactly the handle needed.

Three things are missing:

1. **The client cannot tell "revoked" from "unreachable."**
2. **`ci.devices` and `ci.api_keys` are unrelated tables** **[V]** — there is no "this
   phone" to revoke, only "this key," and nothing binds them.
3. **There is no wipe.** Even if the client knew, deleting a plaintext SQLite file leaves
   recoverable pages.

### 5.2 Never wipe on a 401

**This is the most important rule in this section.** A 401 is not evidence of revocation.
The `/server` screen accepts any user-entered URL **[V]**, so a 401 can mean: the user
typed the wrong host; a reverse proxy is answering; the appliance is mid-restore or
mid-migration; a captive portal is intercepting. Wiping on a bare 401 destroys the
outbox — which by construction holds captures **that have never reached any server**.

**[P] The client wipes only on an explicit, positively-identified revocation signal.
Absence of a signal is never a signal.**

### 5.3 Make revocation legible: tombstone instead of delete

**[P]** Add `revoked_at timestamptz` (and `revoked_reason text`) to `ci.api_keys`.

- `ApiKeyService.remove` sets `revoked_at` instead of deleting the row (add a separate
  retention sweep for rows revoked > 90 days ago).
- `ApiKeyService.validateKey` gains a `revoked_at` check in the same place it already
  checks `expires_at` (`ApiKeyService.ts:379-381`) **[V]** — a three-line change — and
  returns a distinguishable "revoked" result.
- `ApiKeyGuard` answers `401` with a body `{ "error": "key_revoked", "action": "wipe" | "revoke" }`.

**This weakens nothing.** The key still fails authentication exactly as it does today.
It only makes the failure *legible* to the client, which is the entire point. The
alternative — an unauthenticated status endpoint keyed on `device_id` — invents a second
credential to protect the first one, and is worse.

### 5.4 Join `devices` to `api_keys`

**[P]** Add a nullable `api_key_id uuid` to `ci.devices` (or `device_id` to
`ci.api_keys` — either direction works; `devices` is the better home because a device may
outlive several rotated keys). Set it when the mobile app registers itself via the
existing `POST /devices` **[V]**.

That turns Settings → Devices into a real control surface:

> **Companion on Pixel 9** — last seen 2 minutes ago
> [ Sign out this device ] [ **Erase this device** ]

### 5.5 Two verbs, because the cases genuinely conflict

**[P]** A single "revoke" button cannot serve both real scenarios:

| Verb | Meaning | Unflushed outbox | Local data |
|---|---|---|---|
| **`revoke`** — "I'm retiring this phone" | Stop syncing; the phone is in my hand | Attempt one final bounded flush (60 s cap) before standing down | Left intact until the user uninstalls |
| **`wipe`** — "This phone is gone" | Shred now | **No final flush.** A thief's network is not a channel you want the last captures going over, and a final flush is a delay window an attacker can exploit | Destroyed on next launch |

The Settings → Devices dialog asks which, in those words. Defaulting to one and hoping is
how you either lose a user's last three photos or hand a thief a sync window.

### 5.6 Crypto-shredding: why §2 is a hard prerequisite

**[P] The wipe sequence, in order:**

1. **Delete the AndroidKeyStore entry / Keychain item holding the DB key.**
   This single operation renders the SQLCipher database **permanently unopenable** — no
   matter how many copies of the file a forensic tool recovers from unallocated flash
   pages, from a backup, or from a filesystem snapshot. It is atomic, instant, and
   complete.
2. Delete the pepper (§3.2), which severs the token → contact-name mapping.
3. Delete the DB file itself, best-effort.
4. `database.disconnectAndClear()` for PowerSync — the fix to the gap at
   `PowerSyncProvider.tsx:43-51` **[V]**.
5. `secureStorageRemove` for `ci.apiKey`, `ci.apiKeyId`, `ci.apiBaseUrl` **[V]**.
6. Clear WebView storage: Android `WebStorage.getInstance().deleteAllData()` +
   `WebViewDatabase.clearFormData()`; iOS
   `WKWebsiteDataStore.default().removeData(ofTypes:modifiedSince:)`.
7. Show a terminal screen: "This device was erased from your Companion Core."
   Do not silently return to sign-in — the user must learn that it happened.

**Steps 1 and 2 are why encryption-at-rest gates remote wipe.** Without SQLCipher, "wipe"
is step 3 alone: `File.delete()` on a plaintext SQLite database, which leaves fully
recoverable pages on flash. Marketing a wipe feature on top of that would be a false
security claim, which is worse than not having the feature. **G-4 in §8.**

### 5.7 Delivery of the signal

**[P]** The client checks on: cold start, foreground resume, and any authenticated
response carrying `error: "key_revoked"`. No push required — push would be nicer (fires
while the app is closed) but the `devices` domain has `push_token` and **no APNs/FCM
sender exists yet** **[V]**, per `DELIVERY.md` §3 "Next". Ship the pull path first; push
is a latency optimisation, not the mechanism.

⚠️ **Honest limitation, state it in the UI copy:** a wipe only executes if the phone is
turned on and reaches the server. A phone that is off, factory-reset, or airplane-moded
forever never receives the signal. Remote wipe is a **best-effort** control layered on
top of encryption-at-rest, which is the control that actually holds. Say "erase this
device the next time it connects," never "erase this device."

### 5.8 Server-side is only half the promise

Local wipe destroys the phone's copy. The user's data is still on the appliance, which is
correct — but if the user's intent was "delete everything," the **account purge job still
does not exist** **[V]** and `purge_after` is a promise with nothing honouring it. That
is already a 🔴 P0 in `DELIVERY.md` §1a. Both halves have to land before the privacy
policy can describe deletion accurately.

---

## 6. Egress accounting & Sovereign Mode

`DELIVERY.md`'s sovereignty thesis is "no human ever reads this." An accounting screen is
what turns that from a claim into something a user can check.

### 6.1 Where to instrument

**[P]** From the lane inventory in §1f:

| Lane | Hook |
|---|---|
| REST | One counter inside `fetchJson` around the single `fetch()` at `fetchJson.ts:202`. Covers the outbox flush and health probes for free — both go through it **[V]** |
| GraphQL | An `ApolloLink` after `authLink` for operation names, **plus a custom `fetch` passed to `createHttpLink({ fetch })`** for actual byte counts in both directions. The link alone cannot see response size |
| PowerSync upload | Wrap the `fetch` calls in `connector.ts`; count CRUD entries in `uploadData` |
| PowerSync **download** | **Not observable.** The sync stream lives in a Web Worker inside `@powersync/web` **[V]**. Use `db.registerListener` / `SyncStatus` to report **rows synced**, and **label it as rows, not bytes.** Do not fabricate a byte figure |
| Raw `fetch` call sites | `nativeBridge.ts:501`, `useAuth.ts` (csrf/logout) **[V]** — route them through `fetchJson` or add explicit counters. Leaving them is how an accounting screen quietly starts lying |
| **`<img>` / `<video>` / tiles** | **Invisible to every JS hook.** Includes the Esri basemap at `Map.tsx:40-41` **[V]** |

### 6.2 The honest architecture: a checked invariant, not a runtime promise

That last row is fatal to any pure-JS accounting story, and pretending otherwise is
exactly the kind of claim `third-party-egress.md` was written to stop.

**[P] Three layers, each doing what it can actually do:**

1. **JS-layer accounting** — the *product* feature. Covers everything the app
   deliberately sends: REST, GraphQL, PowerSync uploads, LLM calls. This is what the Data
   Flow screen shows: destination host, lane, requests, bytes, last-seen.
2. **A build-time allowlist assertion** — the *guarantee*. A test that scans the built
   `@ci/fe-web` bundle for absolute origins and **fails CI** if any host appears that is
   not on an explicit, reviewed allowlist. This converts "we account for egress" from a
   runtime promise into a checked invariant, and it catches the `<img>` case that no
   runtime hook can. It also would have caught the Esri tile URL the day it landed.
3. **Android `WebViewClient.shouldInterceptRequest`** — the *enforcement*, Android only.
   It sees **every** WebView subresource including `<img>`, so it can both count and
   block.

⚠️ **iOS has no equivalent and this asymmetry must not be papered over.** `NSURLProtocol`
does not apply to WKWebView's separate networking process, and `WKURLSchemeHandler` only
handles custom schemes. There is no supported interception of arbitrary `https`
subresource loads in WKWebView.

### 6.3 Sovereign Mode

**[P] Content-Security-Policy is the cross-platform enforcement mechanism**, and it is
the one that actually covers `<img>`:

```
default-src 'self';
connect-src 'self' <appliance-origin> http://127.0.0.1:*;
img-src 'self' data: blob: <appliance-origin>;
media-src 'self' blob: <appliance-origin>;
script-src 'self';
```

Enforced by the WebView itself, so app JS cannot bypass it — unlike a `fetch` monkeypatch,
which any code in the bundle can undo.

The complication: `<appliance-origin>` is user-entered at runtime **[V]**, and a CSP
`<meta>` tag cannot change after parse. **The mechanism that makes this work:** the shell
serves `index.html` from the local bundle, so the native side can inject the CSP before
the document is parsed — on Android by returning a `Content-Security-Policy` **header**
from `shouldInterceptRequest` for the document request, on iOS by rewriting the `<meta>`
in the served `index.html` at load time. Changing the appliance URL requires a WebView
reload to re-apply, which is acceptable — that flow already reloads.

⚠️ This is native shell work in Capacitor's asset-serving path. It is **[P]**, and the
iOS half in particular is unverified.

**[P] Recommendation: Sovereign Mode default-ON.** A self-hosted appliance whose pitch is
sovereignty should not phone third parties by default. The exceptions become a visible
list in Settings — "Satellite basemap (Esri) — off. Turning this on sends your map view
coordinates to Esri." That turns the findings in `third-party-egress.md` from a document
into a switch, and it makes the product self-disclosing, which is precisely what that
document says the product currently is not.

Ordering note: `third-party-egress.md`'s recommendation #1 — restore the missing Leaflet
attribution — is a one-commit licensing fix that should land regardless and does not wait
for any of this.

---

## 7. Transport: the cleartext problem

### 7.1 `networkSecurityConfig` cannot express the requirement

`DELIVERY.md` §1a defers scoping cleartext, reasoning that "the appliance can be *any*
user-entered LAN/tailnet http host." **That deferral is correct, and here is the concrete
technical reason, which is worth recording so it is not re-litigated:**

**Android's network-security-config schema has no CIDR support.** `<domain>` accepts
hostnames and IP *literals* only. There is no way to write "permit cleartext to any
`192.168.0.0/16` address." So the only expressible scoping is a **fixed host list**, which
is exactly what a user-entered appliance address is not.

**[P] Do not attempt to fix this with `networkSecurityConfig`.** It is not a matter of
effort; the mechanism cannot express the requirement.

### 7.2 The three real options

| Option | What it gets you | Cost |
|---|---|---|
| **A. Runtime policy in TS** — keep `usesCleartextTraffic="true"` (the manifest attribute is only the default for `NetworkSecurityPolicy`) and enforce the real policy in `persistApiBaseUrl`: refuse an `http://` origin unless the host is a private-range literal (RFC1918 / CGNAT / loopback) or `.local` / `.ts.net`; show a persistent "unencrypted" banner while on such an origin | Blocks the genuinely dangerous case (a public `http://` host over hostile Wi-Fi) with a small, testable change in code this repo owns | Does not change what Data Safety must say |
| **B. Tailscale Serve + MagicDNS** — `https://companion-core.<tailnet>.ts.net` with a real Let's Encrypt certificate | **The only option that makes "encrypted in transit = Yes" true.** No cert pinning, no self-signed trust, no port forwarding, and the name resolves only inside the tailnet. Lets `usesCleartextTraffic` go to `false` and drops `NSAllowsArbitraryLoadsInWebContent` | User must run Tailscale on phone + appliance and enable HTTPS certs. On mobile Tailscale is a VPN, so it **conflicts with a second always-on VPN** (corporate MDM) — a real support burden |
| **C. Status quo** | Works everywhere | The Data Safety answer stays "not encrypted in transit" for LAN flows, which `DELIVERY.md` §1c already flags as a disclosure obligation |

### 7.3 Recommendation

**[P] B as the recommended path, A as the fallback, C retired only when telemetry-free
onboarding says B is the norm.**

Concretely:

1. **Make Tailscale the recommended path in onboarding**, with the QR server-pairing deep
   link already on the `DELIVERY.md` roadmap emitting the MagicDNS `https://` URL. The
   right moment to get a user onto TLS is the moment they first type an address.
2. **Ship option A now** — the private-range check in `persistApiBaseUrl` plus the
   banner. Small, in-repo, testable, and it closes the worst case.
3. **Add an interstitial** the first time a user enters a plain `http://` origin, recorded
   as a per-origin decision: *"This connection is not encrypted. Anyone on this Wi-Fi
   network can read the health and location data your phone sends to your server."* That
   is the disclosure the sovereignty thesis obliges, and it is a far better control than a
   config file the user never sees.
4. **Leave `usesCleartextTraffic="true"` until step 1 is the default path**, then flip it
   and retest on-device per `DELIVERY.md`'s warning.

Two supporting notes: the reviewer demo server is HTTPS-only anyway **[V]**, so the review
path never needs cleartext; and the sidecar needs no ATS exception because its `baseUrl`
is always a literal IP (`http://127.0.0.1:<port>`) **[V]** — Android's cleartext policy
likewise permits loopback regardless.

---

## 8. Third-party data minimization

**This is the hardest problem in the document and the one most likely to be treated as a
footnote. It is not.** Everything above protects the user's data from third parties. This
section is about protecting *third parties* from the user's data collection — people who
never consented, will never be asked, and have no interface to object.

### 8.1 Why this is a real constraint, stated precisely

The GDPR household exemption (Art. 2(2)(c)) covers processing "in the course of a purely
personal or household activity." The CJEU has read it narrowly: *Ryneš* (C-212/13) held a
home CCTV camera covering public space fell outside it; *Lindqvist* (C-101/01) held
publishing personal data online fell outside it.

The pattern in both: the exemption thins when processing stops being confined to the
household. For this product, the specific pressures are:

- Ingested contacts and communications are processed by an **LLM, an embedding pipeline,
  and a behavioural-prediction engine** (HBPE), not filed in an address book.
- The appliance is reachable by **connected apps holding API keys** and by **MCP tools**
  **[V]** — data can flow outward to software the contact has never heard of.
- If the hosted demo instance holds real data, **Lifescope becomes a controller or
  processor** for it. `DELIVERY.md` §4 already flags controller/processor determination
  as an owned artifact.

**This document is not legal advice and the determination is counsel's.** What engineering
owes is a design where the *default* configuration keeps as much third-party data off the
server as possible, and where the parts that do go are the parts the user genuinely needs.

### 8.2 The platform constraint that collapses half the design space

⚠️ **Message and call-log *content* is effectively unshippable from mobile. Design around
this rather than into it.**

- **Android:** `READ_SMS` and `READ_CALL_LOG` are in Google Play's **restricted
  permissions** set. They require a Permissions Declaration and an *approved core use
  case* — default SMS handler, default dialer, and a short list of others. "Personal data
  vault" is not on that list. `DELIVERY.md` §1d already warns that broad media-read
  permissions pull the app into the Photo & Video Permissions policy; restricted
  permissions are the same failure mode, harder.
- **iOS:** there is **no public API** for SMS/iMessage content or call history at all.
  `CallKit` / `CallDirectory` do not expose it.

**[P] Conclusion: communications content is a desktop/import problem, not a mobile-ETL
problem.** Route it through **CI-Import-Tools**, where the user makes a deliberate,
one-time archival decision about a specific export file — rather than granting a
background daemon a standing subscription to other people's messages. The
`/api/v1/communications` ingest endpoint already registered in `outboxFlush.ts:51` **[V]**
stays; only its *source* changes.

That is not a limitation to work around. It is the platforms enforcing roughly the right
answer, and the design should adopt it rather than fight it.

### 8.3 The taxonomy that matters

Not "contacts vs. health" — **whose data is it:**

| Class | Sources | Posture |
|---|---|---|
| **First-party** — your data about you | Health, motion/activity, location, app usage, photo *metadata*, calendar events you created | Individually enabled, plain-language sheet, **default off** |
| **Mixed** — yours, containing others incidentally | Calendar events with attendees, photo metadata carrying face-detection identities, shared albums | Enabled with attendee/identity fields **stripped or tokenized by default** |
| **Third-party-dominant** — mostly about people who never consented | Contacts, call logs, SMS/MMS, message content | **Not in v1.** When shipped: separate consent screen, metadata-only, tokenized identifiers |

### 8.4 T1 — Per-source granularity, server-authoritative

**[P]** Every source is an independent toggle. State lives in
**`ci.devices.privacy_settings`** — the existing, currently unused `jsonb` column **[V]**
— so an opt-out is server-authoritative and **survives a reinstall**. A user who turns
off contacts and then reinstalls must not silently start re-uploading them.

Mirror it into the sidecar's (encrypted) DB so enforcement needs no round-trip, and make
the sidecar the enforcement point: **a disabled source cannot enqueue.** A UI-only toggle
is a suggestion; a toggle the outbox honours is a control.

### 8.5 T2 — Store the edge, not the node

**[P]** For anything communications-shaped, the ingest envelope carries interaction
metadata and **never content**:

```jsonc
{
  "kind": "interaction",
  "counterparty_token": "b7f3…",   // see T3 — never a number or an address
  "direction": "outbound",
  "channel": "call",
  "occurred_at": "2026-08-13T14:02:11Z",
  "duration_bucket": "2-5m"        // bucketed, not exact
}
```

This preserves nearly all the behavioural signal HBPE actually consumes — frequency,
recency, reciprocity, circadian rhythm, tie strength — while carrying essentially none of
the third party's expressive content.

**Say plainly what is lost:** no semantic search over messages, no "what did Maria say
about the trip." That is a real product capability being traded away, deliberately, and
the trade should be made explicitly rather than discovered later.

### 8.6 T3 — Tokenize third-party identifiers on-device

**[P]** The identifier (phone number, email, handle) is the direct identifier; the display
name is the strongest quasi-identifier. Neither should reach the server by default.

```
counterparty_token = HMAC-SHA256(pepper, normalize(identifier))  →  truncate to 128 bits
```

- **Pepper**: 32 bytes, generated on first run, stored per §3.2, **never synced, never
  backed up, never sent to the server.**
- **Normalization is the part that quietly breaks.** E.164 for phone numbers (requires a
  region hint — use the SIM's country, fall back to the locale), lowercase + trim for
  email, NFKC for handles. Get it wrong and the same person tokenizes two ways, which
  silently corrupts every downstream frequency and tie-strength calculation. **Normalize
  in one function, unit-test it against a fixture of international formats.**
- The server can still compute "you interact with token X forty times a week," cluster
  contacts, and predict — everything HBPE needs — without holding anyone's phone number.

⚠️ **Be honest about what this buys.** This is **pseudonymization, not anonymization**.
GDPR Recital 26 is explicit that pseudonymized data remains personal data. It does not
make the user a non-controller. What it does buy is real and worth having:

1. A server breach yields tokens, not a contact list.
2. It is a concrete Art. 5(1)(c) data-minimization measure, demonstrable to a regulator.
3. It kills cross-dataset joins — the tokens are useless against any other corpus.

⚠️ **And be honest about the cost.** With the pepper on-device only, the *user* cannot see
"Maria" in their own memory UI unless the phone resolves tokens back to names at render
time. That means an on-device token → display-name map, and the phone becomes the only
place the mapping exists. That is simultaneously the strongest sovereignty property in the
design and a real liability: lose the phone, lose the names (the interaction *graph*
survives on the server; the labels do not).

**[P] Mitigation:** let the user opt into storing the alias map on the appliance as a
distinct, separately-consented, separately-wipeable table (`ci.contact_aliases`) — so the
default minimizes and the escape hatch is explicit, named, and individually revocable.

### 8.7 T4 — On-device derivation, aggregates up

**[P]** For high-volume, low-signal streams — app usage, motion, ambient location — derive
on-device in the sidecar (which already has SQLite and, per its Phase 3 plan, will have an
LLM **[V]**) and sync only rollups: hourly/daily buckets, dwell clusters, session counts,
transition matrices.

Cuts egress volume, cuts breach blast radius, and matches how HBPE consumes the data
anyway. **What is lost:** you cannot re-derive a *different* feature later without
re-collecting, because the raw stream was never kept. Make the retention window for raw
on-device data a setting (default 7 days) so there is a re-derivation window.

### 8.8 T5 — Consent receipts and a third-party register

**[P]** Two surfaces that make the obligations answerable rather than theoretical:

- **Consent receipts.** For every source enabled, write an immutable record — local *and*
  server — of `{ source, scope, minimization_mode, timestamp, app_version }`. This is what
  makes an Art. 30 record real and a DSAR answerable, and it is what a store reviewer or a
  DPA asks to see.
- **"Who is in my memory."** A screen listing distinct counterparty tokens with their
  local display names, and a per-counterparty **Forget** action that (a) tombstones every
  row bearing that token server-side and (b) adds the token to an **on-device denylist so
  re-ingest cannot resurrect them.**

That second half is load-bearing. Without the denylist, "forget this person" is undone by
the next sync — and **nothing in the current design can satisfy a third party's erasure
request at all.** This is the feature that changes that.

### 8.9 T6 — Never ingest a third party's special-category data

**[P]** Hard exclusions, enforced in the source adapters, not in the UI:

- **Contact photos** — biometric-adjacent, high-sensitivity, near-zero analytic value.
- **Attachment bodies** on any communication.
- **Calendar attendee lists** treated as third-party-dominant, tokenized like any other
  counterparty — a shared event titled "Mum — oncology follow-up" is Art. 9 health data
  about someone who is not the user.
- **Health data with an identifiable subject other than the user** (shared health apps,
  caregiver flows) — out of scope entirely.

### 8.10 Recommended default posture

> **Ship with every device source off.**
>
> **First-party** sources enable individually, each behind a plain-language sheet naming
> exactly what leaves the phone and where it goes. **Health ships last** among these — it
> is Art. 9 special-category data and needs encryption at rest, app-lock, and the TLS path
> all landed first.
>
> **Third-party-dominant** sources are **not in v1.** When they ship, **contacts ships
> first and alone**, in metadata + tokenized-identifier mode only, behind a distinct
> second consent screen that names the problem in the user's own language: *"This will
> record who you interact with. Those people have not agreed to this. Companion stores a
> scrambled tag instead of their number, and never their messages."*
>
> **Content-level communications ingest is out of scope for mobile permanently** (§8.2) —
> route it through CI-Import-Tools on desktop.

---

## 9. Prioritized slices and hard gates

Severity: 🔴 **P0** = blocks the next data source · 🟠 **P1** = before the source it gates
· 🟢 **P2** = polish. Effort S/M/L/XL.

### 9a. Slices

| # | Slice | Sev | Effort | Notes |
|---|---|---|---|---|
| **S0** | **Fix D1 + D2** — replace `capacitor-secure-storage-plugin` for the API key with a `CompanionSecureStore` in the Local Hub plugin (`…ThisDeviceOnly` on iOS; fail-closed AES-GCM on Android) | 🔴 | **S** | §2.4. Cheapest high-value slice here, blocks nothing, and its Keystore/Keychain plumbing is the same plumbing S1/S2 need. **Do it first.** |
| **S1** | **SQLCipher on the Android outbox** + Keystore-wrapped raw key + plaintext→encrypted migration | 🔴 | **M** | §2.1, §3.1. Re-check `ITSAppUsesNonExemptEncryption` and the 16 KB page-size item |
| **S2** | **iOS outbox, encrypted from commit one** — parity with S1 | 🔴 | **L** | §2.2. iOS has no outbox at all today **[V]**; needs a Mac |
| **S3** | **`disconnectAndClear()` on logout** — close the documented PowerSync gap | 🟠 | **S** | `PowerSyncProvider.tsx:43-51`. One-line-ish; also the wipe primitive S6 needs |
| **S4** | **Biometric app-lock** + `FLAG_SECURE` + iOS blur overlay + `NSFaceIDUsageDescription` | 🟠 | **M** | §4. Already a `DELIVERY.md` **Now** item |
| **S5** | **Transport** — private-range check in `persistApiBaseUrl`, http:// interstitial, Tailscale Serve onboarding path | 🔴 | **M** | §7. Also fixes the Data Safety answer. **Raised to P0** by `DEVICE_DATA_COMPLIANCE.md`: app-wide cleartext becomes a Play User Data policy *violation* once sensitive data flows, not merely an honest-disclosure problem |
| **S6** | **Revocation tombstone + `devices`↔`api_keys` join + wipe-on-next-launch via crypto-shred** | 🟠 | **L** | §5. **Blocked by S1+S2** |
| **S7** | **Per-source consent** — `privacy_settings` enforcement in the sidecar + consent receipts | 🔴 | **M** | §8.4, §8.8. **Gates every device source** |
| **S8** | **Egress accounting v1** — JS-layer counters + CI allowlist assertion + Data Flow screen | 🟠 | **M** | §6. Also land `third-party-egress.md`'s attribution fix |
| **S9** | **Sovereign Mode** — CSP injection + exception list | 🟠 | **L** | §6.3. iOS half unverified |
| **S10** | **First-party sources**, in order: motion → location → app usage → photo metadata → **health** | — | **L** each | Gated per §9b |
| **S11** | **Tokenization pipeline** — pepper, normalization, alias map, per-counterparty Forget + denylist | 🔴 | **L** | §8.6, §8.8. **Gates contacts** |
| **S12** | **Contacts, metadata-only** | — | **M** | Only after S11 |
| **S13** | **Account purge job** — already a `DELIVERY.md` 🔴 P0 | 🔴 | **L** | §5.8. Local wipe without server purge is half a promise |

### 9b. Hard gates — do NOT ingest X before Y

**These are the load-bearing rows of this document.**

| Gate | Rule |
|---|---|
| **G-1** | **No device source of any kind** — not motion, not location, not health — lands in the outbox before **S1** (Android) / **S2** (iOS). The outbox is plaintext today by its own admission **[V]**; adding health or location to it is knowingly writing special-category data to an unencrypted file. |
| **G-2** | **No device-sourced table enters `sync-rules.yaml`** while the local copy is plaintext IndexedDB (§2.3). The current sync set is the ceiling until the sidecar-owns-storage pivot lands. |
| **G-3** | **No source ships without S7.** A source with no per-source toggle and no consent receipt cannot be disclosed accurately on either store's privacy form, and cannot be turned off by the user. |
| **G-4** | **Do not ship or market remote wipe before S1+S2.** Without crypto-shredding, "wipe" is `File.delete()` on recoverable plaintext pages — a false security claim, which is worse than no feature (§5.6). |
| **G-5** | **Health data requires S1, S2, S4, and S5 all landed.** Art. 9 special-category data, on a device that today has no app-lock and talks cleartext to a LAN host. |
| **G-6** | **Contacts require S11.** Untokenized third-party identifiers must never reach the server, not even once — a token cannot be un-leaked after the raw number has been synced. |
| **G-7** | **No SMS, call-log, or message-content ingest from mobile, ever** (§8.2). Blocked by Play restricted-permissions policy on Android and by the absence of any API on iOS. Route via CI-Import-Tools. |
| **G-8** | **Every source added re-opens the store privacy filings.** `DELIVERY.md` §1c already warns that on-device retention forces a re-file of the nutrition label and Data Safety answers. Each of S10/S12 is a re-file, not a silent addition. |

---

## 10. Cross-references

- [`DEVICE_DATA_COMPLIANCE.md`](./DEVICE_DATA_COMPLIANCE.md) — **the store/policy half of
  the same problem; read both.** That file answers "may this source ship, and what must we
  declare?"; this one answers "what must exist on the device before it may ship at all?"
  Its §5 (not shippable via public stores) and this file's §8.2 / gate **G-7** reach the
  same conclusion about SMS and call logs by independent routes. Its finding that app-wide
  `usesCleartextTraffic` becomes a User Data policy violation once sensitive data flows
  raises the severity of §7 here from 🟠 to 🔴 — treat **S5** as P0, not P1.
- [`DELIVERY.md`](./DELIVERY.md) — submission checklist. §1a cleartext deferral (§7 here),
  §1c privacy filings (G-8), §1d media-permission warning (§8.2), §3 biometric app-lock
  (§4) and account-purge job (§5.8).
- [`README.md`](./README.md) — "Native auth (wired)" describes the credential this
  document proposes to re-home (§2.4).
- [`packages/capacitor-local-hub/README.md`](../../packages/capacitor-local-hub/README.md)
  — Phase 2 already names SQLCipher; Phase 3's read mirrors are what make §2.3's pivot
  work.
- [`docs/architecture/third-party-egress.md`](../../../docs/architecture/third-party-egress.md)
  — the server-side half of §6; its recommendations become Sovereign Mode's exception list.

---

_Design basis: source read on 2026-08-13 against branch `feat/powersync-native-auth-and-tables`.
Claims marked **[V]** cite files in this repo at that commit; everything else is **[P]**,
proposed and unbuilt. Dependency versions, artifact coordinates and binary-size figures
must be re-verified at implementation time — this environment cannot resolve Maven, npm,
or CocoaPods. Store and platform policies move; re-check Play restricted permissions and
Apple export-compliance guidance before relying on §8.2 or §2.1._

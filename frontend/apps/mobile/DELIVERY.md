# Companion Mobile — App Store / Play Store Delivery & Roadmap

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**
>
> Delivery readiness + forward roadmap for the Capacitor app (`@ci/fe-mobile`,
> `com.companionintelligence.app`). Companion to [`README.md`](./README.md), which
> covers how the shell is built and run. This file is the **submission checklist** and
> **phased roadmap**. Derived from a multi-dimension audit (2026-07-15); re-verify
> store policies at submission time — they move.
>
> **Reading device-native data (health, calendar, contacts, photos, location, motion,
> app usage…) into the appliance?** See
> [`DEVICE_DATA_COMPLIANCE.md`](./DEVICE_DATA_COMPLIANCE.md) — per-source permission
> matrix, which sources are unshippable via the public stores, the phased declaration
> sequence, and the exact Data Safety / nutrition-label answers. It also flags two
> **🔴 P0 gaps in this file**: the Play *Health apps declaration* is required of every
> published app (even with zero health features), and app-wide `usesCleartextTraffic`
> becomes a User Data policy violation once sensitive data flows.
>
> **On that first one:** [`GOOGLE_HEALTH_DECLARATION.md`](./GOOGLE_HEALTH_DECLARATION.md) re-verifies it against primary sources (2026-08-13) — the rule is real, but it binds only *published* apps, so for us it is a **gate on the first Play upload, not an overdue violation**; it also carries the fill-in-the-form plan and the Phase-3 re-declaration sequencing.

---

## 0. TL;DR

The app is a **thin Capacitor client** for the user's self-hosted CI-Server appliance.
Engineering-wise it's close, but a first-party memory app that talks to a *user-owned*
backend has an unusual submission profile: the load-bearing unlock is a **seeded,
HTTPS-only demo server** the reviewer can actually use — every review-based channel
needs it. Nothing ships to either store until the 🔴 P0 items below are done.

**Landed so far (in-repo, no accounts needed):**

| Fix | Where |
|---|---|
| ✅ Apple **Privacy Manifest** (`PrivacyInfo.xcprivacy`) authored + wired into the Xcode target | `ios/App/App/PrivacyInfo.xcprivacy` (+ `project.pbxproj`) |
| ⚠️ Export-compliance key `ITSAppUsesNonExemptEncryption=false` — **declared, but its stated basis is stale now that SQLCipher ships; see §1a** | `ios/App/App/Info.plist` |
| ✅ `UIRequiredDeviceCapabilities` `armv7` → `arm64` (stale 32-bit template value) | `ios/App/App/Info.plist` |
| ✅ Android `allowBackup="false"` (keep the private-memory app's local state out of cloud/adb backup) | `android/app/src/main/AndroidManifest.xml` |
| ✅ **In-app account deletion** — `DELETE /account` (soft-delete + access revocation) and Settings → Account | `backend/.../auth/controllers/AccountController.ts`, `frontend/apps/web/src/pages/SettingsPage/sections/AccountSection.tsx` |

Both native builds (iOS + Android) were verified green on a `mobile-v*` tag after the
native changes; the backend/frontend work is green on PR CI.

---

## 1. Pre-submission checklist

Severity: 🔴 **P0** = blocks submission/approval · 🟠 **P1** = should fix before launch · 🟢 **P2** = polish.
Owner: **[code]** = doable in-repo · **[acct]** = needs an Apple/Google/Sentry account, a secret, or a hosted asset · **[both]**.

### 1a. Code / config (in-repo)

- [x] 🔴 **[code]** iOS Privacy Manifest — *done.*
- [ ] 🟠 **[code]** `ITSAppUsesNonExemptEncryption`, `arm64`, Android `allowBackup=false` — *`arm64` and `allowBackup=false` are done; the export-compliance key is **re-opened**.* ⚠️ It was ticked on the basis that the app used “only exempt standard cryptography (HTTPS/TLS via the OS, Keychain)”. Bundling SQLCipher for outbox encryption at rest makes that stated basis untrue — the app now performs AES-256 of its own, not merely via an OS service. The likely determination is still *exempt* (mass-market, standard algorithm, published open-source implementation, applied to the app's own data at rest), **but that is a different exemption argument and it needs counsel's confirmation** — including whether an annual self-classification report is owed. `Info.plist` still declares `false` and now carries the full reasoning inline; flip it to `true` if counsel prefers answering the App Store Connect questionnaire per upload.
- [x] 🔴 **[code]** **In-app account deletion** (Apple 5.1.1(v) + Google Play Data Deletion) — *done: `DELETE /account` + Settings → Account, both CI-green.* **Not exempt** — `SignupPage.tsx` is a real in-app registration flow, so the *initiation* path must live in the app even though data resides on the user's appliance.
  - ⚠️ **What this uncovered:** a hard delete is impossible today. **33 tables** reference `users(id)` with **no `ON DELETE` clause** (→ `NO ACTION`): `events`, `content`, `files`, `threads`, `messages`, `notes`, `embeddings`, `tags`, `sessions`, `questions`, `answers`, all of `hbpe.*`. `DELETE FROM ci.users` raises a foreign-key violation for any account with data — `UserService.remove()` has always had this bug and survives only because nothing calls it. Several user-scoped tables are also TimescaleDB hypertables (~1M+ rows), so even with cascades a synchronous delete would lock for a long time.
  - **Chosen strategy: soft-delete + background purge.** `deleted_at` is a TypeORM `@DeleteDateColumn`, so every read on the user repository skips the row — all three auth entry points (`findById` for JWT *and* API-key, `validatePassword`, `findByEmail`) inherit the gate for free and no future auth path can forget it. `purge_after` is pinned at request time so config changes can't rewrite a promise already made.
  - [ ] 🔴 **[code]** **Remaining: the background purge job** that consumes `purge_after` (batched + hypertable-aware). Until it exists, `purge_after` is a promise with nothing honouring it — deletion revokes access but does not yet delete data, which the privacy policy and Data Safety answers must not overstate.
  - [ ] 🔴 **[acct]** **Remaining: the public web deletion URL** Google requires (in addition to the in-app path).
- [ ] 🔴 **[code]** **Signed release CI lanes** — `mobile-build.yml` only produces an unsigned debug APK + a Simulator `.app`. Add: iOS `xcodebuild archive → -exportArchive` (app-store method) → `.ipa`; Android `./gradlew bundleRelease` → signed `.aab`. Gate both on the signing secrets (§2). *(Code is in-repo; the certs/keystore behind it are [acct].)*
- [ ] 🟠 **[code]** **Scope Android cleartext** — replace app-wide `usesCleartextTraffic="true"` with an `android:networkSecurityConfig`. ⚠️ **Deferred deliberately:** the appliance can be *any* user-entered LAN/tailnet http host, so a scoped config still has to permit cleartext broadly; changing it risks regressing the hard-won LAN-http connectivity. Do this only with an on-device Android retest. Keep the iOS `NSAllowsArbitraryLoadsInWebContent` scoping as the model. Reconcile with the Data Safety "encrypted in transit" answer (see C3 below).
- [ ] 🟠 **[code]** **Version/build automation** — everything is pinned at `1` / `1.0` / `0.0.0`. Derive iOS `CURRENT_PROJECT_VERSION`, Android `versionCode`, and a web build id from CI (tag + run number) so the *second* upload isn't rejected as a duplicate build.
- [ ] 🟠 **[code]** **iPad — DECIDED: ship universal (iPhone + iPad).** `Info.plist` already declares all iPad orientations, so the binary **will be reviewed on iPad**. Since we are keeping iPad in scope rather than setting `TARGETED_DEVICE_FAMILY = 1`, the adaptive iPad/split-view layout in `@ci/fe-web` becomes **pre-submission work, not roadmap work**: a phone-shaped webview stretched to iPad is a live 4.2/2.1 rejection risk, and iPad screenshots become mandatory for the listing.
- [ ] 🟢 **[code]** `CODE_SIGN_IDENTITY = "iPhone Developer"` is the pre-Xcode-9 name → resolves during signing setup (§2); use `Apple Development` / let distribution resolve `Apple Distribution`.
- [ ] 🟠 **[code]** Verify Android 15 **edge-to-edge** (targetSdk 35 forces it) + **16 KB page size** on an API-35 device. ⚠️ **No longer a no-op — the “no native libs” premise is wrong.** The app ships native libraries from two sources: `@ci/capacitor-local-llm` pulls `com.google.ai.edge.litertlm:litertlm-android` (`libLiteRt.so`, `libLiteRtClGlAccelerator.so`, `liblitertlm_jni.so`), and `@ci/capacitor-local-hub` now pulls `net.zetetic:sqlcipher-android` (`libsqlcipher.so`) for outbox encryption at rest. *Checked on the current debug APK:* every packaged `.so` reports ELF `p_align = 0x4000` and every `lib/**` zip entry is stored uncompressed at a 16 KB-aligned offset, so the build is compliant today — but this is now a real check that can regress on any native-dependency bump, not a formality. Raised 🟢→🟠 for that reason.

### 1b. Signing & store accounts

- [ ] 🔴 **[acct]** **iOS distribution signing** — Apple Developer Program membership; set `DEVELOPMENT_TEAM`; Apple Distribution cert + App Store provisioning profile for `com.companionintelligence.app`; App Store Connect app record.
- [ ] 🔴 **[acct]** **Android release signing** — generate an upload keystore, enroll in **Play App Signing**, wire `signingConfigs.release` from `ANDROID_KEYSTORE_BASE64/PASSWORD/KEY_ALIAS/KEY_PASSWORD` (names already referenced in `README.md`).
- [ ] 🔴 **[acct]** **Demo server + demo account** for App Review / Play pre-launch — a public, seeded, **HTTPS-only** CI-Server + credentials (in review notes *and* ideally an in-app one-tap "Try the demo"). A self-hosted client with no reviewer-reachable backend is a well-known automatic rejection. Serve over TLS so the reviewer path needs no cleartext (keeps the Data-Safety "encrypted in transit" answer truthful for that flow).

### 1c. Store presence, privacy & legal

- [ ] 🔴 **[acct]** **Hosted Privacy Policy URL** — covers camera/mic/notifications + the personal memory data sent to the user's own server; no third-party sharing; no tracking/ads. Required by both stores + linked in-app.
- [ ] 🔴 **[acct]** **Apple App Privacy nutrition label** + **Google Data Safety form** — because data is transmitted off-device it counts as *collected*: declare User Content / Photos / Audio / Messages / Location as applicable, **Linked to identity**, **Not used for tracking**, **Not shared**. Explain the self-hosted architecture in review notes. **C2/C3:** if the Lifescope demo server is stood up, data to *that* instance is developer-accessible → reflect it in the label; and cleartext means you **cannot** claim "encrypted in transit = Yes" for LAN flows — disclose accurately.
- [ ] 🔴 **[acct]** **EU trader status** (App Store Connect + Play Console, DSA) — a hard submission gate for EU distribution since 2024. Verify Lifescope's trader identity.
- [ ] 🟠 **[acct]** **EULA / Terms of Use** — distinct from the privacy policy; both stores expect one for account apps (Apple's standard EULA is fine). Link in-app next to Privacy + Delete-account.
- [ ] 🟠 **[acct]** **Age rating** — Apple Age Rating + Google IARC. UGC + open LLM chat push this to a mature tier; recommend an **adults-only (17+/"Not directed to children")** posture to avoid COPPA / Play Families data restrictions.
- [ ] 🟠 **[acct]** **Screenshots + listing metadata** — iPhone 6.7"/6.5" (+ iPad only if universal), Android phone/tablet, description, keywords, support URL, category. Both stores block submission without the minimum screenshot set.
- [ ] 🟢 **[acct]** **App name "Companion" trademark/availability** — extremely crowded on both stores; the *display name* may collide even though the bundle id is unique. Clear it and have a fallback ready ("Companion Intelligence" / "CI Companion").

### 1d. Things that explicitly DON'T apply (don't waste cycles)

- **"Sign in with Apple" (4.8)** — N/A. The only federated login is first-party OIDC to your own CI-Portal; there's no Google/Apple/Facebook button and no `ASAuthorization`. Be ready to tell a reviewer CI-Portal is *your* IdP, not a covered third party.
- **UGC report/block/filter machinery (1.2)** — largely N/A: single-user, self-hosted memory app with no user-to-user surface. State that explicitly as the defense (a reviewer seeing "AI chat + capture" may ask).
- **Google Photo & Video Permissions policy** — sidestepped today because capture is `getUserMedia`, not `READ_MEDIA_IMAGES`. Do **not** add broad-storage/media-read permissions without the Play declaration (and note only the Photo-Library *Add* usage string exists on iOS — a future in-app library picker needs the *read* string too).

---

## 2. Recommended ship path

**Public App Store + Google Play, fronted by a seeded HTTPS demo CI-Server, staged through the testing tracks first.**

1. Build the review-enabling assets first (all the 🔴 P0s): demo server + account, privacy policy + EULA + **in-app account deletion**, honest nutrition-label / Data-Safety answers (cleartext disclosed), signing lanes.
2. Ship to **TestFlight external + Play closed/internal testing** first — *not* an escape from review (both still enforce policy), but it validates the demo-server review path at low stakes.
3. Promote to **public App Store + Play production**, **iPhone-only** initially to minimize first-review surface.

**Alternatives** (secondary, not primary): Apple Business Manager **Custom Apps** + Play **private/unlisted** are a good *parallel* channel for enterprise appliance buyers (still full review, capped reach). **Unlisted** distribution is a useful interim soft-launch. **Apple Developer Enterprise Program is off the table** unless the audience is strictly internal Lifescope staff — using it for a public/self-hosted product violates the agreement. The demo server is the load-bearing unlock for *every* review-based channel, so build it once.

---

## 3. Roadmap — "make the app work better"

Phased **Now** (next release train) / **Next** (following quarter) / **Later**. Effort S/M/L/XL.

### Now
| Item | Effort | Notes |
|---|---|---|
| **Sentry — web bundle** (`@sentry/react` in `@ci/fe-web`) | M | One init covers web **and** native (same bundle ships via `webDir`). Captures JS errors, unhandled rejections, React render errors. Needs a DSN + release/env tags. |
| **Sentry — native crashes** (`@sentry/capacitor`) | M | JS-only Sentry misses Swift/Kotlin crashes (App Intents, `UIScene`). Install into the standalone mobile project; upload dSYM/mapping. |
| **Unified version/release strategy** | M | Single source of truth → iOS build, Android `versionCode`, web build id, and the Sentry release tag. Prerequisite for symbolication + non-duplicate uploads. |
| **In-app deep-link router** (`companion://` + `https` → app routes) | M | Today only `companion://oidc` is handled. A generic router (`/memory/:id`, `/thread/:id`, `/search?q=`) is the shared foundation for universal links, Spotlight, widgets, share-in. |
| **QR server-pairing deep link** | S | Replace hand-typing the appliance URL on first run with a `companion://pair?origin=…(+one-time token)` QR the server/Hub renders. Builds on the router. |
| **Biometric app-lock** (Face ID / Touch ID / fingerprint) | M | A private memory app holding a long-lived API key in the keystore should gate access. New Capacitor biometric plugin + native permission strings. |
| **Reviewer demo mode** | M | See §2 — one-tap "Try the demo" against the hosted sample server; unblocks review *and* new-user onboarding. |

### Next
| Item | Effort | Notes |
|---|---|---|
| **Push notifications — backend device-token endpoint** | M | Prerequisite for all remote push. There's an existing `devices` domain to build on; no APNs/FCM code exists yet. |
| **Push — `@capacitor/push-notifications` client** | M | Reuse the `POST_NOTIFICATIONS` permission already declared; local notifications already wired. |
| **Push — APNs (iOS) + FCM (Android) senders** | L each | APNs `.p8` + Push entitlement (adds the first `App.entitlements`); FCM needs a Firebase project + `google-services.json` (build.gradle already conditionally applies the plugin). |
| **Notification fan-out** | M | Wire push to meaningful signals — new insights / anomalies / suggested actions, daily summary, HBPE forecast changes. ⚠️ The derivation layer is currently scaffolding with no producer ([[ai-insight-system-state]]), so there's nothing to notify *from* yet. |
| **Sentry — backend** (`@sentry/node` in NestJS `GlobalExceptionsFilter`) | M | Backend has only local pino logs today. Decide self-hosted vs SaaS given the confidential appliance posture. |
| **Source map + dSYM + mapping upload in CI** | M | Enable vite `build.sourcemap`, Android minify + `mapping.txt`, collect iOS dSYM; upload to Sentry per release. |
| **Deepen Apple App Intents** | M | Parameterized App Shortcuts via `AppEntity`/`AppEnum` (current free-text params can't interpolate into Siri phrases); more intents (Capture, Today's Summary, Forecast); CoreSpotlight indexing of memories. |
| **Android App Actions / dynamic Shortcuts** | L | Zero equivalent of the 4 iOS intents today. `ShortcutManager` + App Actions (Ask/Search/Remember/Capture) + a keystore config bridge (Android analogue of `CompanionConfig.swift`). |
| **Universal Links + Android App Links** | L | Real `https` links open specific memories/threads. `AppDelegate` already forwards `NSUserActivity`; needs an entitlements file + hosted AASA/`assetlinks.json` + the deep-link router. Also lets OIDC migrate off the hijackable custom scheme. |
| **Offline read cache** (interim before PowerSync) | M | Cache last-viewed memories so the app is usable when the appliance is unreachable — a real failure mode for a self-hosted backend. |
| **Account-data purge job** | L | Consumes `purge_after`: batched, hypertable-aware hard deletion of a soft-deleted account's data across the 33 FK-blocking tables. Promoted from roadmap to **pre-submission** — until it runs, deletion revokes access without deleting data, and the privacy policy / Data Safety answers must say only what is true. |
| **Accessibility pass** (VoiceOver/TalkBack, Dynamic Type, contrast) | M | Also an EU legal obligation — the **European Accessibility Act** (in force June 2025) reaches consumer apps sold into the EU, not just UX polish. |
| **Low-end Android WebGL / 3D-graph degradation** | L | The 3D knowledge-graph can stutter/crash the webview on low-GPU devices; detect tier and fall back to 2D / capped nodes. |

### Later
| Item | Effort | Notes |
|---|---|---|
| **PowerSync local-first client** | XL | Server scaffold + `GET /api/powersync/token` + `sync-rules.yaml` exist; the on-device SQLite client is unwired. Changes both stores' privacy answers (on-device retention) — re-file when it lands. |
| **Share extension / share target** | XL | Capture a photo/URL/text from any app into Companion. iOS Share Extension + App Group; Android `ACTION_SEND` intent-filter; ingest endpoint. |
| **Home-screen widgets** | L | WidgetKit + Android App Widget: recent memory + one-tap capture (App-Intent-backed). |
| **Notification preferences** (per-category opt-in + quiet hours) | M | Once multiple push categories exist, stored server-side against the device record. |
| **Automated store metadata + screenshot pipeline** (fastlane `deliver`/`supply`) | M | Reproducible listing/privacy updates in-repo instead of hand-entry. |
| **OTA web-bundle update model** | L | The app bundles the web build, so a web fix needs a full store re-release today. A Capacitor live-update layer helps — but respect Apple **2.5.2** limits on downloading executable code. |
| **Background capture (constrained)** | XL | Heavily restricted on iOS, battery-sensitive on Android. Spike the platform limits before committing. |

---

## 4. Legal / compliance artifacts (own these before EU launch)

Beyond "publish a privacy policy," a personal-data client needs: **controller/processor determination** (the user is arguably the controller for their own appliance; the demo server makes Lifescope a controller/processor for demo data), **GDPR Art. 13/14 disclosures + lawful basis + DPA/RoPA**, **CCPA/CPRA** notice-at-collection (no "sale" → no Do-Not-Sell mechanism, worth stating), **UK-GDPR**, **DSA trader identity**, a **EULA**, an **age/COPPA posture** (recommend 17+), and **EAA accessibility** for EU. Demo-server opsec: TLS-only, isolated/throwaway, rate-limited, residency-considered.

> **See also:** [`SECURITY_ARCHITECTURE.md`](./SECURITY_ARCHITECTURE.md) — encryption at rest, key management, biometric app-lock, remote revoke/wipe, egress accounting, transport, and third-party data minimization, with the hard gates on which device data source may not ship before which control exists.

---

_Audit basis: 5-dimension review + completeness critic, 2026-07-15, against the branch at
`frontend/apps/mobile`. Store policies change frequently — re-verify Apple App Review
Guidelines and Google Play policies at submission time._

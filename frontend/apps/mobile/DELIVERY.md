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

> **Demo access, as of 2026-08-13.** The demo **account** exists —
> **`demo@ci.computer`** on **`hub.ci.computer`** (Portal, which is the OIDC IdP the
> app's "Sign in with CI Portal" already targets; password lives in the store review
> notes, never in this repo). The demo **server instance does not** — this is a
> self-hosted platform, so a reviewer-reachable CI-Server has to be stood up. §1b records
> which existing hosts were checked and why neither can be used. **Treat "we have a
> backend" and "a reviewer can reach a backend" as two different facts** — that
> distinction is the single most likely cause of a first-submission rejection here.

**Landed so far (in-repo, no accounts needed):**

| Fix | Where |
|---|---|
| ✅ Apple **Privacy Manifest** (`PrivacyInfo.xcprivacy`) authored + wired into the Xcode target | `ios/App/App/PrivacyInfo.xcprivacy` (+ `project.pbxproj`) |
| ⚠️ Export-compliance key `ITSAppUsesNonExemptEncryption=false` — **declared, but its stated basis is stale now that SQLCipher ships; see §1a** | `ios/App/App/Info.plist` |
| ✅ `UIRequiredDeviceCapabilities` `armv7` → `arm64` (stale 32-bit template value) | `ios/App/App/Info.plist` |
| ✅ Android `allowBackup="false"` (keep the private-memory app's local state out of cloud/adb backup) | `android/app/src/main/AndroidManifest.xml` |
| ✅ **In-app account deletion** — `DELETE /account` (soft-delete + access revocation) and Settings → Account | `backend/.../auth/controllers/AccountController.ts`, `frontend/apps/web/src/pages/SettingsPage/sections/AccountSection.tsx` |
| ✅ **Signed store lanes** — TestFlight `.ipa` + Play internal `.aab`, with build numbers stamped from CI | `.github/workflows/mobile-release.yml`, `android/app/build.gradle` |

The backend/frontend work is green on PR CI.

> ### ⚠️ 2026-08-13 — correction to the line that used to sit here
> This file previously said *"both native builds (iOS + Android) were verified green on a
> `mobile-v*` tag."* That was true of the **Android** job and misleading about **iOS**.
> The green iOS job predates the Local Hub / speech plugins; once those landed, `cap sync
> ios` could not `pod install` at all, so the iOS lane had been failing rather than
> passing. On the first real Mac build of this branch:
>
> - **iOS did not compile.** The `@ci/*` podspecs were named `CapacitorLocalHub` /
>   `CapacitorSpeech`, but `cap sync` regenerates the Podfile and derives
>   `CiCapacitorLocalHub` / `CiCapacitorSpeech` from the package names — CocoaPods failed
>   with "No podspec found". Plus two Swift access-level errors in `SpeechPlugin`.
> - **Once it compiled, it crashed.** `LocalHub.start()` hit `abort()` inside
>   `+[GCDWebServer initialize]`, which asserts `[NSThread isMainThread]`; the server was
>   being constructed on a private serial queue. **Every Debug build died on the first
>   Local Hub call** — i.e. every developer build and every Xcode-run TestFlight build.
>
> All four are fixed, and iOS is now verified the way Android was: clean build from an
> empty DerivedData (Xcode 27 / iOS 27 sim), app launches and stays up, and the outbox
> database is created for real in the app container — `sqlite_sequence` present in the
> live file (which is what proves `AUTOINCREMENT` is actually in effect) and
> `journal_mode=wal`. **Still unverified on iOS:** anything needing real hardware —
> transcription accuracy, on-device `SFSpeechRecognizer` availability (the simulator
> reports `supportsOnDeviceRecognition` differently from a device), and reboot durability.

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
- [x] 🔴 **[code]** **Signed release CI lanes** — *done: [`mobile-release.yml`](../../../.github/workflows/mobile-release.yml).* iOS `xcodebuild archive → -exportArchive` (`app-store-connect`) → `.ipa` → `altool --validate-app` → TestFlight; Android `bundleRelease` → signed `.aab` → Play **internal** track. Notes on how it behaves:
  - **`dry_run` defaults to true** on manual runs: it builds, signs, and *validates* against App Store Connect but does not submit. Use it to prove the signing chain before burning a build number — both stores permanently consume a build number on upload, so a failed submission after a successful one still costs you that number. A `mobile-release-v*` **tag push always submits.**
  - Each platform **skips rather than fails** when its secrets are absent, so iOS and Android can be wired up independently.
  - The Android half is verified locally end-to-end: a throwaway keystore produced a signed `app-release.aab` (`META-INF/*.RSA` present) with `versionCode` stamped from the environment. The iOS half is unverifiable without a real Apple Developer account — the certs/profile/API key are all [acct] work, so **first run it with `dry_run: true`.**
  - `./gradlew bundleRelease` now **fails at configuration time** when no keystore is configured, instead of quietly emitting an unsigned bundle that Play rejects at the end of the upload — a failure that otherwise lands very far from its cause.
- [ ] 🟠 **[code]** **DECISION NEEDED: how wide should iOS ATS be?** A five-lens review found that `NSAllowsArbitraryLoadsInWebContent` exempts **WKWebView content only** — it does nothing for `URLSession`, which is exactly what `CompanionAPI` (the Siri/App Intents client) uses. So "Remember this" and "Ask Companion" fail against any `http://` appliance while the in-app webview works fine, which reads as Siri being broken rather than as a transport policy.
  - **Applied now, narrow:** `NSAllowsLocalNetworking: true`. It covers `.local` and unqualified/private-range LAN hosts, and Apple asks for **no review justification** for it — so it is free.
  - **Still uncovered, and it is your call:** a public `http://` origin, and plausibly a Tailscale `100.64/10` address (CGNAT space, not RFC1918). Closing those needs `NSAllowsArbitraryLoads: true`, which is the exact iOS parallel of Android's `usesCleartextTraffic` — it invites an App Review justification and weakens the "encrypted in transit" story in C3. **Do not widen it silently**: either accept that Siri works only over HTTPS and LAN, or widen it deliberately and update the Data Safety answers to match.
- [ ] 🟠 **[code]** **Scope Android cleartext** — replace app-wide `usesCleartextTraffic="true"` with an `android:networkSecurityConfig`. ⚠️ **Deferred deliberately:** the appliance can be *any* user-entered LAN/tailnet http host, so a scoped config still has to permit cleartext broadly; changing it risks regressing the hard-won LAN-http connectivity. Do this only with an on-device Android retest. Keep the iOS `NSAllowsArbitraryLoadsInWebContent` scoping as the model. Reconcile with the Data Safety "encrypted in transit" answer (see C3 below).
- [x] 🟠 **[code]** **Version/build automation** — *done for both native apps.* `mobile-release.yml` resolves the version once and hands the same numbers to both stores: marketing version from the `mobile-release-v*` tag (or a manual input), build number from `github.run_number`, which is monotonic per workflow and so satisfies the "never repeats, always increases" rule both stores enforce. iOS takes them as `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` xcodebuild overrides; Android reads `ANDROID_VERSION_NAME` / `ANDROID_VERSION_CODE` in `build.gradle`, with the old literals kept only as the local-dev fallback. *(A web build id is still unstamped — 🟢, it does not gate a store upload.)*
- [ ] 🟠 **[code]** **iPad — DECIDED: ship universal (iPhone + iPad).** `Info.plist` already declares all iPad orientations, so the binary **will be reviewed on iPad**. Since we are keeping iPad in scope rather than setting `TARGETED_DEVICE_FAMILY = 1`, the adaptive iPad/split-view layout in `@ci/fe-web` becomes **pre-submission work, not roadmap work**: a phone-shaped webview stretched to iPad is a live 4.2/2.1 rejection risk, and iPad screenshots become mandatory for the listing.
- [x] 🟢 **[code]** `CODE_SIGN_IDENTITY = "iPhone Developer"` (the pre-Xcode-9 name) and `CODE_SIGN_STYLE = Automatic` with no `DEVELOPMENT_TEAM` — *handled, deliberately without touching the pbxproj.* Automatic signing cannot work on a runner with no Apple ID session, so the release job overrides `CODE_SIGN_STYLE=Manual`, `CODE_SIGN_IDENTITY='Apple Distribution'`, `DEVELOPMENT_TEAM`, and `PROVISIONING_PROFILE_SPECIFIER` on the `xcodebuild` command line. Opening the project in Xcode locally therefore behaves exactly as before. If you later prefer the settings baked in, change them in Xcode and drop the overrides — but *not* both half-done.
- [ ] 🟠 **[code]** Verify Android 15 **edge-to-edge** (targetSdk 35 forces it) + **16 KB page size** on an API-35 device. ⚠️ **No longer a no-op — the “no native libs” premise is wrong.** The app ships native libraries from two sources: `@ci/capacitor-local-llm` pulls `com.google.ai.edge.litertlm:litertlm-android` (`libLiteRt.so`, `libLiteRtClGlAccelerator.so`, `liblitertlm_jni.so`), and `@ci/capacitor-local-hub` now pulls `net.zetetic:sqlcipher-android` (`libsqlcipher.so`) for outbox encryption at rest. *Checked on the current debug APK:* every packaged `.so` reports ELF `p_align = 0x4000` and every `lib/**` zip entry is stored uncompressed at a 16 KB-aligned offset, so the build is compliant today — but this is now a real check that can regress on any native-dependency bump, not a formality. Raised 🟢→🟠 for that reason.

### 1b. Signing & store accounts

- [ ] 🔴 **[acct]** **iOS distribution signing** — Apple Developer Program membership; set `DEVELOPMENT_TEAM`; Apple Distribution cert + App Store provisioning profile for `com.companionintelligence.app`; App Store Connect app record.
- [ ] 🔴 **[acct]** **Android release signing** — generate an upload keystore, enroll in **Play App Signing**, wire `signingConfigs.release` from `ANDROID_KEYSTORE_BASE64/PASSWORD/KEY_ALIAS/KEY_PASSWORD` (names already referenced in `README.md`).
- [ ] 🔴 **[acct]** **Demo server + demo account** for App Review / Play pre-launch. A self-hosted client with no reviewer-reachable backend is a well-known automatic rejection. **Partly satisfied — one half done, one half still to build:**
  - [x] **Identity.** A Portal test account exists: **`demo@ci.computer`** on **`hub.ci.computer`**. That is the right half to have, because Portal is the OIDC IdP the app's "Sign in with CI Portal" (`companion://` callback) already targets — so the reviewer's *login* path is real. Put the password in App Store Connect review notes and the Play Console, **never in this repo.**
  - [ ] 🔴 **The reviewer-facing CI-Server origin.** Companion Intelligence is a **self-hosted platform**, so an instance has to be stood up for review — the backend software existing is not the same as a reviewer being able to reach one. Requirements: public DNS, valid TLS, **seeded with realistic memory data**, and **not behind an access gate**.
  - ⚠️ **Neither existing host works for this, verified 2026-08-13 — do not point App Review at either:**

    | Host | What it actually is | Why it fails review |
    |---|---|---|
    | `hub.ci.computer` | Companion Hub / CI Portal — the app store + OIDC IdP + OAuth proxy. Valid TLS (GTS, SAN covers `hub.ci.computer`), `/api/health` → 200 | **`POST /api/graphql` → 404.** The mobile app's `CompanionAPI` talks to `/api/graphql` and `/api/llm/generate`; this host serves neither. It is the identity endpoint, not the memory backend |
    | `app.ci.computer` | A CI-Server instance | **Behind Cloudflare Access.** Every path answers 401/404 *from Cloudflare's edge*, not the app — the 401 body is a Cloudflare "Unauthorized" page. A reviewer hits a zero-trust login wall and never reaches the product. This is the sharpest form of the trap: the box is up and still unreviewable |

  - **Serve it over TLS** so the reviewer path needs no cleartext — that is what keeps the Data-Safety "encrypted in transit" answer truthful for the flow a reviewer actually exercises (LAN http remains separately disclosed; see C3 below).
  - Consider an in-app one-tap **"Try the demo"** that pre-fills the origin, so the reviewer never has to type a hostname into the `/server` screen — typing it wrong is itself a rejection path.

### 1c. Store presence, privacy & legal

- [ ] 🔴 **[acct]** **Hosted Privacy Policy URL** — covers camera/mic/notifications + the personal memory data sent to the user's own server; no third-party sharing; no tracking/ads. Required by both stores + linked in-app.
- [ ] 🔴 **[acct]** **Apple App Privacy nutrition label** + **Google Data Safety form** — because data is transmitted off-device it counts as *collected*: declare User Content / Photos / Audio / Messages / Location as applicable, **Linked to identity**, **Not used for tracking**, **Not shared**. Explain the self-hosted architecture in review notes.
  - **C2 is no longer conditional.** It used to read "*if* the Lifescope demo server is stood up…" — but §1b now commits to standing one up, and the Portal account `demo@ci.computer` on `hub.ci.computer` is already a Lifescope-operated identity. So data flowing to Lifescope-operated infrastructure **is** developer-accessible, and the label must say so. "The user hosts it themselves" is true of the product and **not** true of the demo path a reviewer will exercise — answering as though only the self-hosted case exists would be a false declaration on the very flow Apple and Google actually test.
  - **C3:** cleartext means you **cannot** claim "encrypted in transit = Yes" for LAN flows — disclose accurately. The demo instance being HTTPS keeps that answer truthful *for the reviewer path* but does not retroactively make it true for a user pointing the app at `http://` on their tailnet.
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

## 1e. The ASAP critical path (added 2026-08-13)

The checklist above is the full picture; this is the **ordered** version — what actually
gates the next store upload, and what can run in parallel. The honest summary: **the
remaining blockers are almost entirely `[acct]`, not `[code]`.** Engineering can no
longer pull the date in much; accounts, hosted assets, and legal copy now can.

**Sequence — the long pole is Apple enrollment, so start it today.**

| # | Do this | Owner | Blocks | Can start now? |
|---|---|---|---|---|
| 1 | **Apple Developer Program enrollment** + App Store Connect app record for `com.companionintelligence.app` | [acct] | *everything* on iOS | ✅ yes — org verification alone can take days |
| 2 | **Google Play Console** account + app record; enroll in **Play App Signing**; generate the upload keystore | [acct] | everything on Android | ✅ yes |
| 3 | Create the **App Store Connect API key**, **Apple Distribution cert**, **App Store provisioning profile**; add all 11 secrets from §2 to the repo | [acct] | first TestFlight build | after 1 |
| 3.5 | **Land `mobile-release.yml` on `main`.** GitHub will not dispatch a `workflow_dispatch` workflow that does not exist on the **default branch** — `gh workflow run mobile-release.yml` currently returns `HTTP 404: workflow not found on the default branch`. Either merge PR #1953, or cherry-pick just the workflow file onto `main` to unblock step 4 early | [code] | step 4 | ✅ yes — the cherry-pick does not wait on the rest of the PR |
| 4 | Run **Mobile Release with `dry_run: true`** — proves signing, export, and App Store Connect validation without consuming a build number | [code] | first real upload | after 3 and 3.5 |
| 5 | **Stand up the reviewer-facing CI-Server** — seeded, public DNS, valid TLS, **no Cloudflare Access in front**. The demo *account* (`demo@ci.computer` at `hub.ci.computer`) already exists; the *instance* does not, and this is a self-hosted platform so someone has to build it | [acct] | *review approval on both stores* | ✅ **yes, and it is the true long pole after enrollment** |
| 6 | **Privacy policy URL, EULA, public account-deletion URL** | [acct] | submission forms | ✅ yes |
| 7 | **Nutrition label / Data Safety answers, EU trader status, age rating, screenshots** | [acct] | submission forms | ✅ yes (except iPad shots — see 9) |
| 8 | **Background purge job** consuming `purge_after` | [code] | truthful deletion claims in 6/7 | ✅ yes |
| 9 | **iPad layout pass** in `@ci/fe-web`, or set `TARGETED_DEVICE_FAMILY = 1` | [code] | iOS review (4.2/2.1) | ✅ yes — **decide this first, it changes the screenshot set** |
| 10 | **On-device Android + iOS pass** — cleartext/LAN, edge-to-edge, and the three things the simulator cannot prove (see below) | [both] | launch confidence | after 1–3 |

**Fastest defensible route to "in a store":** items 1–4 put builds in **TestFlight internal**
and **Play internal testing**, both of which distribute to your own testers. Neither is
an escape from policy, but internal tracks let the pipeline start proving itself while
5–7 are still being written.

**The two things most likely to slip the date, ranked:**

1. **The demo server (5).** A self-hosted client with no reviewer-reachable backend is a
   well-known automatic rejection, and it gates *every* review-based channel on *both*
   stores. It is not an engineering afterthought — treat it as the launch dependency.
   The demo *account* is done; the *instance* is not, and on a self-hosted platform that
   instance is real infrastructure work. Two traps, both already observed on live hosts:
   pointing review at the **Portal** (which has no `/api/graphql`) and putting the
   instance behind **Cloudflare Access** (which makes an otherwise healthy box
   indistinguishable, to a reviewer, from a dead one).
2. **iPad (9).** `Info.plist` declares all iPad orientations today, so the binary **will
   be reviewed on iPad** whether or not anyone designed for it. Deciding late is
   expensive because it invalidates the screenshot set.

**Known-unfixed defects that should not ship, in severity order** *(all acknowledged in
the PR that added them — listing them here so they are visible from the delivery plan,
not only from a PR description)*:

- 🟠 **iOS API key was backup-migratory — now mitigated, not yet properly fixed.**
  `capacitor-secure-storage-plugin` writes with `kSecAttrAccessibleAfterFirstUnlock`, not
  `…ThisDeviceOnly`, so the appliance API key rode along in encrypted backups and
  **restored onto different hardware.** `ios/App/App/KeychainHardening.swift` now sweeps
  every `cap_sec` item to `…ThisDeviceOnly` at launch and on backgrounding; verified at
  runtime on an iOS 27 simulator (`ck` → `cku`, idempotent, secret preserved). The proper
  fix is still S0 in `SECURITY_ARCHITECTURE.md` — a native store that writes the right
  class in the first place. Downgraded 🔴→🟠, **not** cleared.
- 🔴 **Android Keystore silently degrades** to plain Base64 in SharedPreferences if
  Keystore init throws — logging an error while reporting success.
- 🟠 **The outbox is not encrypted at rest** (plaintext SQLite behind the app sandbox).
  Fine to ship *only* if the privacy policy and Data Safety answers don't imply otherwise.
- 🟠 **Android app-wide `usesCleartextTraffic="true"`** — the deferred item above, and a
  User Data policy violation once sensitive data flows.

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

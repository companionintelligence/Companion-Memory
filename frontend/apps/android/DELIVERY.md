# Companion Android — App Store / Play Store Delivery & Roadmap

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**
>
> Delivery readiness + forward roadmap for the Capacitor app (`@ci/fe-android`,
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
| ✅ **In-app account deletion, end to end** — `DELETE /account` (access revoked immediately) + Settings → Account, **and** the background purge that destroys the data 30 days later | `backend/.../auth/controllers/AccountController.ts`, `backend/.../user/services/AccountPurgeService.ts`, `frontend/apps/web/src/pages/SettingsPage/sections/AccountSection.tsx` |
| ⚠️ **Signed store lanes** — TestFlight `.ipa` + Play internal `.aab`, with build numbers stamped from CI. **Authored and merged to `main`, but never yet exercised: no run has produced either artifact** (see the note below the table) | `.github/workflows/mobile-release.yml`, `android/app/build.gradle` |

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

> ### ⚠️ 2026-09-07 — the release lane has still never produced an artifact
> Several items below are ticked `[x]` on the strength of the **code being written**, which
> is fair, but the wording let them read as *"a build has shipped."* None has. Checked
> against the live repo and Actions history on 2026-09-07:
>
> - **`mobile-release.yml` has run exactly twice, and produced nothing either time.** The
>   2026-08-13 run (`31747207062`) is marked *success* but finished in **24 seconds**: it
>   took the documented "skip rather than fail when secrets are absent" path and skipped
>   every build step from `Node.js + Corepack` onward. The 2026-08-27 run
>   (`33049609481`) **failed** in the `Resolve version` job before either platform started.
>   **No `.aab` and no `.ipa` has ever come out of CI.**
> - **Zero `ios-v*`, `android-v*`, or `mobile-release-v*` tags exist** — so the release
>   lane's tag-push path (the one that *always submits*) has never fired. The only mobile
>   tag in the repo is `mobile-v0.1.0-appstoreprep-97ae319e`, which belongs to the naming
>   scheme of the **unsigned** lane, `mobile-build.yml` — and even that triggers nothing
>   today: that workflow's `on:` block is `workflow_dispatch` only, its `mobile-v*` trigger
>   having been removed (see its "GATED TO MANUAL" header). Pushing a `mobile-v*` tag
>   builds nothing at all.
> - **This is not a criticism of the lanes.** `mobile-build.yml` genuinely works and has
>   produced artifacts on several green runs (debug APK + Simulator `.app`), and the release
>   workflow is carefully built — the skip-on-missing-secrets behaviour above is *by design*
>   and is why the 24s run is green rather than red. What is unproven is only the end of the
>   pipe: signing, export, and store upload have never executed. **Step 4 of §1e (a
>   `dry_run: true` run) is still the first real test of them,** and per §1a it now also
>   needs the target-API-36 blocker cleared before any upload can be accepted.

---

## 1. Pre-submission checklist

Severity: 🔴 **P0** = blocks submission/approval · 🟠 **P1** = should fix before launch · 🟢 **P2** = polish.
Owner: **[code]** = doable in-repo · **[acct]** = needs an Apple/Google/Sentry account, a secret, or a hosted asset · **[both]**.

### 1a. Code / config (in-repo)

- [x] 🔴 **[code]** iOS Privacy Manifest — *done.*
- [ ] 🟠 **[code]** `ITSAppUsesNonExemptEncryption`, `arm64`, Android `allowBackup=false` — *`arm64` and `allowBackup=false` are done; the export-compliance key is **re-opened**.* ⚠️ It was ticked on the basis that the app used “only exempt standard cryptography (HTTPS/TLS via the OS, Keychain)”. Bundling SQLCipher for outbox encryption at rest makes that stated basis untrue — the app now performs AES-256 of its own, not merely via an OS service. The likely determination is still *exempt* (mass-market, standard algorithm, published open-source implementation, applied to the app's own data at rest), **but that is a different exemption argument and it needs counsel's confirmation** — including whether an annual self-classification report is owed. `Info.plist` still declares `false` and now carries the full reasoning inline; flip it to `true` if counsel prefers answering the App Store Connect questionnaire per upload.
- [x] 🔴 **[code]** **In-app account deletion** (Apple 5.1.1(v) + Google Play Data Deletion) — *done: `DELETE /account` + Settings → Account, both CI-green.* **Not exempt** — `SignupPage.tsx` is a real in-app registration flow, so the *initiation* path must live in the app even though data resides on the user's appliance.
  - ⚠️ **What this uncovered:** a hard delete is impossible today. `DELETE FROM ci.users` raises a foreign-key violation for any account with data — `UserService.remove()` has always had this bug and survives only because nothing calls it. Several user-scoped tables are also TimescaleDB hypertables, so even with cascades a synchronous delete would lock for a long time.
    - 📌 **Corrected 2026-08-13, against the live schema at HEAD** (the earlier "33 tables with no `ON DELETE` clause" was wrong in both directions). Reading `pg_constraint`: **18** constraints reference `users(id)` with **`NO ACTION`** (`actions`, `capture_events`, `connections`, `content`, `notes`, `pairings`, `provider_keys`, `questions.is_private_to`, `saved_searches`, `sessions`, `users.created_by`, and seven `hbpe.*`), **28** already **`CASCADE`** (`events`, `files`, `threads`, `messages`, `answers`, `communications`, `position`, …), and **9** are **`SET NULL`**. `embeddings` and `tags` were listed as blockers but do not reference `users` at all — which is the bigger finding: **14 user-scoped tables have no foreign key to `ci.users` whatsoever**, including `ci_search.embeddings`, `ci_search.vectors`, `ci_search.tags`, `ci.browser_activity`, `ci.file_chunks` and `ci.agent_memories`. A cascade-based delete would have reported success and left the vector form of every memory in place.
  - **Chosen strategy: soft-delete + background purge.** `deleted_at` is a TypeORM `@DeleteDateColumn`, so every read on the user repository skips the row — all three auth entry points (`findById` for JWT *and* API-key, `validatePassword`, `findByEmail`) inherit the gate for free and no future auth path can forget it. `purge_after` is pinned at request time so config changes can't rewrite a promise already made.
  - [x] 🔴 **[code]** **The background purge job — *done*.** `AccountPurgeService` + `AccountPurgeCron` (hourly) consume `purge_after`: batched (`ctid IN (… LIMIT n)`), resumable (each batch commits), idempotent (every statement scoped by "belongs to this account"), and hypertable-aware (chunk-by-chunk, because `ctid` is only unique within one physical table). The plan is **derived from the live catalog on every run** rather than from a committed table list, so a new user-scoped table is covered the run after it lands — see [`docs/architecture/account-deletion.md`](../../../docs/architecture/account-deletion.md) for why that beat `ON DELETE CASCADE`. Covers 68 tables, deletes the uploaded objects from the object store too (nothing in the repo had ever deleted one), and records every purge in `ci.account_purges`. Verified end to end against a throwaway database with all migrations applied.
  - [ ] 🔴 **[acct]** **Remaining: the public web deletion URL** Google requires (in addition to the in-app path) — reachable **without installing the app**, and it must say what is deleted and what is retained. The copy for it is now writable: `docs/architecture/account-deletion.md` §"What is true afterwards" is the source of truth, including the three residues the page must not paper over (nulled attributions on other accounts' rows, the retained purge-audit uuid, and backups).
- [x] 🔴 **[code]** **Signed release CI lanes** — *written and merged to `main`: [`mobile-release.yml`](../../../.github/workflows/mobile-release.yml).* ⚠️ **"Done" here means the lane exists, not that it has delivered a build — no run has yet produced a `.aab` or `.ipa` (§0, 2026-09-07).** iOS `xcodebuild archive → -exportArchive` (`app-store-connect`) → `.ipa` → `altool --validate-app` → TestFlight; Android `bundleRelease` → signed `.aab` → Play **internal** track. Notes on how it behaves:
  - **`dry_run` defaults to true** on manual runs: it builds, signs, and *validates* against App Store Connect but does not submit. Use it to prove the signing chain before burning a build number — both stores permanently consume a build number on upload, so a failed submission after a successful one still costs you that number. Pushing `ios-v*`, `android-v*`, or `mobile-release-v*` **always submits** (iOS-only, Android-only, or both).
  - Each platform **skips rather than fails** when its secrets are absent, so iOS and Android can be wired up independently.
  - The Android half is verified locally end-to-end: a throwaway keystore produced a signed `app-release.aab` (`META-INF/*.RSA` present) with `versionCode` stamped from the environment. The iOS half is unverifiable without a real Apple Developer account — the certs/profile/API key are all [acct] work, so **first run it with `dry_run: true`.**
  - `./gradlew bundleRelease` now **fails at configuration time** when no keystore is configured, instead of quietly emitting an unsigned bundle that Play rejects at the end of the upload — a failure that otherwise lands very far from its cause.
- [ ] 🟠 **[code]** **Scope Android cleartext** — replace app-wide `usesCleartextTraffic="true"` with an `android:networkSecurityConfig`. ⚠️ **Deferred deliberately:** the appliance can be *any* user-entered LAN/tailnet http host, so a scoped config still has to permit cleartext broadly; changing it risks regressing the hard-won LAN-http connectivity. Do this only with an on-device Android retest. Keep the iOS `NSAllowsArbitraryLoadsInWebContent` scoping as the model. Reconcile with the Data Safety "encrypted in transit" answer (see C3 below). ℹ️ **The iOS ATS decision that used to be copied here verbatim has been removed** — it is iOS-only, it drifted (the Android copy kept an "Applied now" claim the iOS copy had already corrected), and Android has no `Info.plist` at all. It lives in [`../ios/DELIVERY.md`](../ios/DELIVERY.md) §1a, referenced rather than duplicated, the same way the iPad item below is.
- [x] 🟠 **[code]** **Version/build automation** — *implemented for both native apps; **never yet exercised end to end**.* The only run that reached the build steps' version inputs did not build, and the 2026-08-27 dispatch failed inside the `Resolve version` job itself (§0) — so the resolution logic below is reviewed code, not observed behaviour. `mobile-release.yml` resolves the version once and hands the same numbers to both stores: marketing version from the `mobile-release-v*` tag (or a manual input), build number from `github.run_number`, which is monotonic per workflow and so satisfies the "never repeats, always increases" rule both stores enforce. iOS takes them as `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` xcodebuild overrides; Android reads `ANDROID_VERSION_NAME` / `ANDROID_VERSION_CODE` in `build.gradle`, with the old literals kept only as the local-dev fallback. *(A web build id is still unstamped — 🟢, it does not gate a store upload.)*
- [x] 🟠 **[code]** **iPad — not an Android concern; settled on the iOS side.** Decided 2026-08-19: ship **iPhone-only** (`TARGETED_DEVICE_FAMILY = 1`). Full rationale in [`../ios/DELIVERY.md`](../ios/DELIVERY.md) §1a — this file inherited the item because the iOS/Android split copied the delivery doc verbatim.
  - ⚠️ **The Android-side analogue is real and still open.** The shared `@ci/fe-web` layout has no tablet tier — one `MOBILE_BREAKPOINT = 896` boolean in `@ci/common`, no `isTablet`, no split-view handling. Play delivers to **tablets and Chromebooks by default** and there is no `TARGETED_DEVICE_FAMILY` equivalent to opt out with, so Android large screens get that layout whether or not anyone designed for it. Not a submission gate (unlike iPad review), but it is the one place where the iOS decision does **not** cover Android. Tracked in §3 Later.
- [x] 🟢 **[code]** `CODE_SIGN_IDENTITY = "iPhone Developer"` (the pre-Xcode-9 name) and `CODE_SIGN_STYLE = Automatic` with no `DEVELOPMENT_TEAM` — *handled, deliberately without touching the pbxproj.* Automatic signing cannot work on a runner with no Apple ID session, so the release job overrides `CODE_SIGN_STYLE=Manual`, `CODE_SIGN_IDENTITY='Apple Distribution'`, `DEVELOPMENT_TEAM`, and `PROVISIONING_PROFILE_SPECIFIER` on the `xcodebuild` command line. Opening the project in Xcode locally therefore behaves exactly as before. If you later prefer the settings baked in, change them in Xcode and drop the overrides — but *not* both half-done.
- [ ] 🔴 **[code]** **Target API 36 — the Play deadline has already passed, and this is blocked on an AGP upgrade.** `android/variables.gradle` pins `compileSdkVersion`/`targetSdkVersion` at **35**. Verified against [Play Console Help](https://support.google.com/googleplay/android-developer/answer/11926878) on **2026-09-07**: since **31 August 2026** *new apps and app updates* must target **API 36 (Android 16)** to be submitted at all. That cutover is behind us. (An extension bought until **1 November 2026** — a date still ahead of us — but it had to be *requested from a Play Console account*, and per step 2 of §1e we do not have one yet, so that route was never open to this app.) So the first `.aab` we upload is **rejected by the Play Console at upload time** — i.e. *after* `mobile-release.yml` has consumed a `github.run_number` version code, which neither store ever gives back. This is a submission gate, not polish.
  - ⚠️ **Do not "just bump it" — and two numbers an earlier revision of this file gave were wrong.** Re-verified against primary sources on **2026-09-07**:
    - **Capacitor 7 cannot target 36 at all**, at any AGP version. [Capacitor's own docs](https://capacitorjs.com/docs/android/setting-target-sdk): *"Capacitor Android does not support custom target SDK versions. Each version of Capacitor Android requires a specific target SDK version and support is only provided for that matching version."* Its matrix is **7.x → 35, 8.x → 36**. This, not AGP, is the real gate.
    - The AGP floor is **8.10.0, not 8.9.1**. [AGP 8.9 release notes](https://developer.android.com/build/releases/past-releases/agp-8-9-0-release-notes) state *"Maximum API Level: API level 35"*; [8.10.0](https://developer.android.com/build/releases/agp-8-10-0-release-notes) is the first with *"Maximum API Level Supported: API level 36"*.
    - **"The wrapper is already sufficient at 8.11.1" was also wrong** for the path we would actually take: Capacitor 8 ships **AGP 8.13.0** and moves the wrapper to **Gradle 8.14.3** (read from the published `@capacitor/android` 8.5.1 tarball, `capacitor/build.gradle`).
  - **What Capacitor 8 costs beyond the SDK pin:** Kotlin **2.2.20**, google-services **4.4.4**, Java **21**, Node **22+**, `cordovaAndroidVersion` **10.1.1 → 14.0.1**, an androidx sweep (activity 1.11.0, appcompat 1.7.1, core 1.17.0, fragment 1.8.9, webkit 1.14.0, espresso 3.7.0, androidx-junit 1.3.0), and **minSdk 23 → 24**, which drops Android 6.0/6.0.1 — a product decision, not a build edit.
  - 🚧 **The blocker upstream of all of it:** [`@capacitor-community/background-geolocation`](https://github.com/capacitor-community/background-geolocation) has **no Capacitor 8 release** and is effectively unmaintained (its own `android/build.gradle` still pins AGP 8.0.0 / compileSdk 33). It is what provides this app's **background location** *and* its **foreground-service `location` type** — precisely the two features whose Play declarations already gate the first upload (§1c). **Migrating to Capacitor 8 therefore starts with replacing, forking or vendoring that plugin**, and that decision should be made before any version numbers move.
  - **Unblock sequence:** (1) decide the background-geolocation plugin's future — replace, fork or vendor; (2) migrate to Capacitor 8 per its [upgrade guide](https://capacitorjs.com/docs/updating/8-0), taking AGP 8.13.0 + Gradle 8.14.3 + Kotlin 2.2.20 with it; (3) accept and communicate the minSdk 24 floor; (4) bump both values in `variables.gradle`; (5) change `sdkmanager` to `"platforms;android-36" "build-tools;36.0.0"` in **both** [`mobile-build.yml`](../../../.github/workflows/mobile-build.yml) *and* [`mobile-release.yml`](../../../.github/workflows/mobile-release.yml) — the release lane compiles against whatever it installed, so missing it there breaks the only lane that matters; (6) re-run the edge-to-edge and 16 KB checks below, because both are targetSdk-sensitive and a target bump is exactly the event that regresses them.
  - 🔁 **This recurs every year — treat it as a standing checklist item, not a one-off.** Google raises the required target API annually with a **31 August** cutover (35 in 2025, 36 in 2026), and it binds *updates* as well as new apps, so an app already on the store stops being updatable. **Each year by ~Q2: confirm the new required level, and budget for the AGP/Capacitor upgrade it implies** — as this entry shows, the toolchain, not the one-line SDK pin, is the long pole. Re-verify at the Play Console Help link above rather than trusting this paragraph's numbers.
- [ ] 🟠 **[code]** Verify Android 15 **edge-to-edge** (targetSdk 35 forces it; re-verify at 36 — see the target-API item above) + **16 KB page size** on an API-35 device. ⚠️ **No longer a no-op — the “no native libs” premise is wrong.** The app ships native libraries from two sources: `@ci/capacitor-local-llm` pulls `com.google.ai.edge.litertlm:litertlm-android` (`libLiteRt.so`, `libLiteRtClGlAccelerator.so`, `liblitertlm_jni.so`), and `@ci/capacitor-local-hub` now pulls `net.zetetic:sqlcipher-android` (`libsqlcipher.so`) for outbox encryption at rest. *Checked on the current debug APK:* every packaged `.so` reports ELF `p_align = 0x4000` and every `lib/**` zip entry is stored uncompressed at a 16 KB-aligned offset, so the build is compliant today — but this is now a real check that can regress on any native-dependency bump, not a formality. Raised 🟢→🟠 for that reason.

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
  - ✅ **The deletion answers are now truthful.** Both forms ask whether users can request their data be deleted, not just their account deactivated. Since 2026-08-13 the answer is yes: rows across 68 tables and the uploaded objects are destroyed, no later than `purge_after`, and the purge is recorded. **Write the answers from** [`docs/architecture/account-deletion.md`](../../../docs/architecture/account-deletion.md) — its "What is true afterwards" section also lists the three things the forms must not overstate (attributions on other accounts' rows are nulled not deleted; a purge-audit uuid is retained as proof; backups are out of scope).
  - **C2 is no longer conditional.** It used to read "*if* the Lifescope demo server is stood up…" — but §1b now commits to standing one up, and the Portal account `demo@ci.computer` on `hub.ci.computer` is already a Lifescope-operated identity. So data flowing to Lifescope-operated infrastructure **is** developer-accessible, and the label must say so. "The user hosts it themselves" is true of the product and **not** true of the demo path a reviewer will exercise — answering as though only the self-hosted case exists would be a false declaration on the very flow Apple and Google actually test.
  - **C3:** cleartext means you **cannot** claim "encrypted in transit = Yes" for LAN flows — disclose accurately. The demo instance being HTTPS keeps that answer truthful *for the reviewer path* but does not retroactively make it true for a user pointing the app at `http://` on their tailnet.
  - **C2 is no longer conditional.** It used to read "*if* the Lifescope demo server is stood up…" — but §1b now commits to standing one up, and the Portal account `demo@ci.computer` on `hub.ci.computer` is already a Lifescope-operated identity. So data flowing to Lifescope-operated infrastructure **is** developer-accessible, and the label must say so. "The user hosts it themselves" is true of the product and **not** true of the demo path a reviewer will exercise — answering as though only the self-hosted case exists would be a false declaration on the very flow Apple and Google actually test.
  - **C3:** cleartext means you **cannot** claim "encrypted in transit = Yes" for LAN flows — disclose accurately. The demo instance being HTTPS keeps that answer truthful *for the reviewer path* but does not retroactively make it true for a user pointing the app at `http://` on their tailnet.
- [ ] 🔴 **[acct]** **Play background-location declaration + demo video, and a foreground-service `location` type declaration + its own video** — no longer deferrable. As of the `@capacitor-community/background-geolocation` integration, `ACCESS_BACKGROUND_LOCATION` ships in `AndroidManifest.xml` on this platform too (see [`DEVICE_DATA_COMPLIANCE.md`](./DEVICE_DATA_COMPLIANCE.md) §3.4/§7). Both declarations must be filed and approved **before this build goes to any Play track, including internal testing** — a manifest permission with no matching declaration is a hard rejection, not a warning.
- [ ] 🔴 **[acct]** **EU trader status** (App Store Connect + Play Console, DSA) — a hard submission gate for EU distribution since 2024. Verify Lifescope's trader identity.
- [ ] 🟠 **[acct]** **EULA / Terms of Use** — distinct from the privacy policy; both stores expect one for account apps (Apple's standard EULA is fine). Link in-app next to Privacy + Delete-account.
- [ ] 🟠 **[acct]** **Age rating** — Apple Age Rating + Google IARC. UGC + open LLM chat push this to a mature tier; recommend an **adults-only (17+/"Not directed to children")** posture to avoid COPPA / Play Families data restrictions.
- [ ] 🟠 **[acct]** **Screenshots + listing metadata** — **Android phone** screenshots, description, keywords, support URL, category. Both stores block submission without the minimum set. Android **tablet/large-screen** captures are *not* a Play submission gate, but Play does surface a large-screen quality signal — optional listing polish, tied to the large-screen note in §1a. (iOS sets are covered in [`../ios/DELIVERY.md`](../ios/DELIVERY.md) §1c: iPhone-only, no iPad set.)
- [ ] 🟢 **[acct]** **App name "Companion" trademark/availability** — extremely crowded on both stores; the *display name* may collide even though the bundle id is unique. Clear it and have a fallback ready ("Companion Intelligence" / "CI Companion").

### 1d. Things that explicitly DON'T apply (don't waste cycles)

- **"Sign in with Apple" (4.8)** — N/A. The only federated login is first-party OIDC to your own CI-Portal; there's no Google/Apple/Facebook button and no `ASAuthorization`. Be ready to tell a reviewer CI-Portal is *your* IdP, not a covered third party.
- **UGC report/block/filter machinery (1.2)** — largely N/A: single-user, self-hosted memory app with no user-to-user surface. State that explicitly as the defense (a reviewer seeing "AI chat + capture" may ask).
- **Google Photo & Video Permissions policy** — sidestepped today because capture is `getUserMedia`, not `READ_MEDIA_IMAGES`. Do **not** add broad-storage/media-read permissions without the Play declaration (and note only the Photo-Library *Add* usage string exists on iOS — a future in-app library picker needs the *read* string too).

---

## 1e. The ASAP critical path (added 2026-08-13)

The checklist above is the full picture; this is the **ordered** version — what actually
gates the next store upload, and what can run in parallel. The honest summary: **the
remaining blockers are mostly `[acct]`, not `[code]` — with one hard `[code]` exception.**
Accounts, hosted assets, and legal copy carry most of the date. ⚠️ **Revised 2026-09-07:**
this used to read *"almost entirely `[acct]`"* with the implication that engineering could
no longer pull the date in. That is no longer true — **target API 36 (§1a) is a `[code]`
blocker that now gates every Play upload**, its deadline has already passed, and clearing
it means an AGP upgrade rather than a one-line edit. Start it in parallel with enrollment.

**Sequence — the long pole is Apple enrollment, so start it today.**

| # | Do this | Owner | Blocks | Can start now? |
|---|---|---|---|---|
| 1 | **Apple Developer Program enrollment** + App Store Connect app record for `com.companionintelligence.app` | [acct] | *everything* on iOS | ✅ yes — org verification alone can take days |
| 2 | **Google Play Console** account + app record; enroll in **Play App Signing**; generate the upload keystore | [acct] | everything on Android | ✅ yes |
| 3 | Create the **App Store Connect API key**, **Apple Distribution cert**, **App Store provisioning profile**; add all 11 secrets from §2 to the repo | [acct] | first TestFlight build | after 1 |
| ~~3.5~~ | ~~**Land `mobile-release.yml` on `main`**~~ — **done; this row was stale.** The workflow *is* on the default branch (confirmed 2026-09-07), so the `HTTP 404: workflow not found on the default branch` described here no longer happens and no cherry-pick is needed — it has in fact been dispatched from `main` twice since. ⚠️ Being dispatchable is **not** the same as having built anything: both runs ended without an artifact (see the 2026-09-07 correction in §0) | [code] | ~~step 4~~ | — |
| 4 | Run **Mobile Release with `dry_run: true`** — proves signing, export, and App Store Connect validation without consuming a build number. **Still the first run that will exercise any of that:** the two dispatches so far skipped or failed before building (§0, 2026-09-07) | [code] | first real upload | after 3 (3.5 is already done) |
| 4.5 | **Raise target API to 36** — which means **migrating to Capacitor 8** (Capacitor 7 cannot target 36 at any AGP version), and that in turn starts with deciding the future of the unmaintained `@capacitor-community/background-geolocation`. See §1a. Play has refused sub-36 uploads since 31 Aug 2026, so this gates the Android half of step 4 *and* every upload after it. Not a one-liner and not just an AGP bump: it is a framework major | [code] | any Play upload, incl. internal testing | ✅ yes — independent of every `[acct]` item |
| 5 | **Stand up the reviewer-facing CI-Server** — seeded, public DNS, valid TLS, **no Cloudflare Access in front**. The demo *account* (`demo@ci.computer` at `hub.ci.computer`) already exists; the *instance* does not, and this is a self-hosted platform so someone has to build it | [acct] | *review approval on both stores* | ✅ **yes, and it is the true long pole after enrollment** |
| 6 | **Privacy policy URL, EULA, public account-deletion URL** | [acct] | submission forms | ✅ yes |
| 7 | **Nutrition label / Data Safety answers, EU trader status, age rating, screenshots** | [acct] | submission forms | ✅ yes — Android phone set; tablet shots optional |
| ~~8~~ | ~~**Background purge job** consuming `purge_after`~~ — **done 2026-08-13**; 6/7 can now claim deletion, within the limits in `docs/architecture/account-deletion.md` | [code] | ~~truthful deletion claims in 6/7~~ | — |
| 9 | ~~**iPad layout pass**~~ — iOS-only; resolved 2026-08-19 as iPhone-only (see [`../ios/DELIVERY.md`](../ios/DELIVERY.md) §1a). **Android large screens remain unaddressed** and have no opt-out | [code] | large-screen quality on Play | not a submission gate |
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
2. ~~**iPad (9).**~~ **Not an Android risk, and resolved on iOS** 2026-08-19 as iPhone-only
   — see [`../ios/DELIVERY.md`](../ios/DELIVERY.md) §1a. What *does* carry over: Play ships
   to tablets and Chromebooks by default with no device-family opt-out, and the shared web
   layout has no tablet tier. That is a quality signal, not a submission blocker.

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
- 🟠 **The outbox *is* encrypted at rest — but the iOS ciphertext check has not been run.**
  Both platforms open the outbox as **SQLCipher (AES-256)**, keyed from the platform secure
  store as a raw key (`OutboxStore.kt`, `OutboxStore.swift`, `OutboxDatabaseKey`). ⚠️ This
  line previously read *"the outbox is not encrypted at rest (plaintext SQLite behind the
  app sandbox)"*, which was already untrue when written — see §1a, which correctly notes
  that shipping SQLCipher re-opens the export-compliance declaration. What remains open is
  narrower and specific to iOS: the Android suite asserts the file **does not** begin with
  `SQLite format 3`, and **no equivalent assertion has been reported on iOS**. Until it is,
  iOS encryption at rest is a property of the code, not an observed property of the file —
  and the failure mode is silent (`import SQLite3` instead of `import SQLCipher` compiles
  and runs cleanly against the OS's *unencrypted* SQLite). Do that check before any Data
  Safety answer leans on it.
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

> **Not the same thing as the in-app camera scan already shipped.** The "Scan QR Code"
> button on the Memory Server URL screen (`ServerSettingsPage`, `scanQrCode()` in
> `@ci/common`'s native bridge) is a user-initiated camera scan of a plain `http(s)`
> origin — no deep link, no router, no OS-level handoff. The **QR server-pairing deep
> link** item above is a different mechanism: an *incoming* `companion://pair?origin=…`
> URL that the OS hands to the app (e.g. from tapping a QR result outside the app, or a
> notification), requiring the in-app deep-link router this table lists as a separate
> prerequisite. Building the camera-scan path does not close this item.

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
| **Tablet / large-screen adaptive layout** | L | Play delivers to tablets and Chromebooks by default and there is **no** `TARGETED_DEVICE_FAMILY`-style opt-out, so large screens get the phone/desktop layout as-is. Needs a real tablet tier in `@ci/fe-web` + `@ci/common`: a size-class layer replacing the `MOBILE_BREAKPOINT = 896` boolean — which is declared **twice**, in two unrelated packages (`frontend/packages/common/src/hooks/useDeviceLayout.ts:6` for `useDeviceLayout().isMobile` and `frontend/packages/shadcn/src/hooks/use-mobile.ts:3` for `useIsMobile()`), so both have to move together or the two halves of the layout will disagree about what "mobile" is; persistent labels on `SecondaryNavigation`'s icon rail under touch (hover-only `Tooltip`s never appear on a tablet); and no component-tree swap across the breakpoint (`ResponsiveLoader` remounts `MemoryPage`/`SearchPage` on rotate). Shared with the iOS iPad re-entry — see [`../ios/DELIVERY.md`](../ios/DELIVERY.md) §3. |

---

## 4. Legal / compliance artifacts (own these before EU launch)

Beyond "publish a privacy policy," a personal-data client needs: **controller/processor determination** (the user is arguably the controller for their own appliance; the demo server makes Lifescope a controller/processor for demo data), **GDPR Art. 13/14 disclosures + lawful basis + DPA/RoPA**, **CCPA/CPRA** notice-at-collection (no "sale" → no Do-Not-Sell mechanism, worth stating), **UK-GDPR**, **DSA trader identity**, a **EULA**, an **age/COPPA posture** (recommend 17+), and **EAA accessibility** for EU. Demo-server opsec: TLS-only, isolated/throwaway, rate-limited, residency-considered.

> **See also:** [`SECURITY_ARCHITECTURE.md`](./SECURITY_ARCHITECTURE.md) — encryption at rest, key management, biometric app-lock, remote revoke/wipe, egress accounting, transport, and third-party data minimization, with the hard gates on which device data source may not ship before which control exists.

---

_Audit basis: 5-dimension review + completeness critic, 2026-07-15, against the branch at
`frontend/apps/android`. Store policies change frequently — re-verify Apple App Review
Guidelines and Google Play policies at submission time._

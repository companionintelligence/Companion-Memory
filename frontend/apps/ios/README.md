# @ci/fe-ios — Native iOS shell (Capacitor)

A thin native **iOS** shell that wraps the existing **`@ci/fe-web`** React/Vite build and
points it at a remote, self-hosted **CI-Server**. Android lives in
[`frontend/apps/android`](../android) as its own package — do not merge them.

On first launch with no server set, the app routes to **`/device-connect`** (Portal
sign-in → pick a Memory Server). `/server` is the Advanced URL fallback. `/connect`
is Sources (OAuth accounts) and must not be reused.

The rest of this file is the iOS runbook (build, TestFlight, plugins). Android is a
separate package and must stay that way.

> 📦 **Shipping to the stores?** See **[`DELIVERY.md`](./DELIVERY.md)** — the
> App Store / Play Store pre-submission checklist (what's done vs. still blocking) and
> the phased roadmap (Sentry, push notifications, deep links, Apple Intents, offline).

## How it works

- `capacitor.config.ts` sets `webDir: '../web/dist'` — the app ships the `@ci/fe-web`
  production build. No separate mobile UI codebase.
- The web app detects the native runtime via the injected `window.Capacitor` global
  (`isNativePlatform()` in `@ci/common`) and reads its **configured server origin from
  `localStorage`**. On first launch with no server set, it routes to the in-app
  `/device-connect` screen (Portal picker). `/server` is Advanced URL entry.
- All `/api/...` calls resolve through `buildApiUrl()` (`@ci/common`): `''` on web
  (same-origin), the configured origin on native.
- The native web build sets `VITE_DISABLE_PWA=true` so the Workbox service worker
  doesn't fight Capacitor's local asset serving.

## Standalone project (not a yarn workspace)

The monorepo uses Yarn **PnP**, but the Capacitor CLI / CocoaPods / Gradle need a real
`node_modules` tree. So this package is deliberately **excluded** from the root
workspaces (`"!frontend/apps/ios"` and `"!frontend/apps/android"` in the root
`package.json`) and installed on its own. Its `.yarnrc.yml` sets
`nodeLinker: node-modules`, so `yarn install` *inside this directory* produces a
conventional `node_modules` + its own `yarn.lock` — the root PnP install is untouched.
It depends on the web app only as a build artifact (`webDir`), never as an npm import.

## Prerequisites

- macOS + **Xcode 26+** (the iOS 26 SDK is required — see SDK notes below) and
  **CocoaPods** (`brew install cocoapods`).
- Backend CORS already allows the native origins (`backend/apps/api/src/main.ts`:
  `capacitor://localhost`, `http(s)://localhost`, plus the `X-API-Key` header);
  operators can extend it with `CORS_ALLOWED_ORIGINS`.

## Supported devices — iPhone only

`TARGETED_DEVICE_FAMILY = 1` in **both** the Debug and Release configs of the App
target, and the `~ipad` orientation variants were removed from `Info.plist` so the
plist and the build setting cannot disagree. On iPad this ships as an
iPhone-compatibility app (Apple's scaled phone window), which the `@ci/fe-web` mobile
layout is designed for. Reversing it means editing **both** configs to `"1,2"`,
restoring the `~ipad` orientation key, and adding a tablet tier to the layout hooks —
the plist alone will not do it. See `DELIVERY.md` §1a.

## First-time setup

```bash
# 1) Install this project's deps (isolated from root PnP):
cd frontend/apps/ios && yarn install

# 2) Build the web bundle (from repo root, PWA disabled):
VITE_DISABLE_PWA=true yarn workspace @ci/fe-web build

# The ios/ project is committed. Only on a checkout that lacks it:
#   npx cap add ios   # ⚠️ then re-apply the iOS 26 fixes — see "iOS 26 SDK" below
yarn sync          # copies web assets + installs native plugin code
```

`yarn build` (= `build:web` + `cap sync`) rebuilds + syncs from this directory.
Android is a separate package — build it from [`frontend/apps/android`](../android).

## Safari Web Extension (bundled)

Memory is the containing iOS app for the Companion Memory Safari Web Extension.
`yarn sync` runs [`scripts/sync-safari-extension.sh`](scripts/sync-safari-extension.sh):
it builds `safari-mv3` from a sibling `CI-Browser-Extension` checkout, or downloads
the pinned GitHub `*-safari-mobile.zip` release, into
`ios/App/SafariWebExtension/Resources`. Xcode embeds that as
`com.companionintelligence.app.SafariWebExtension`. Do not generate a second App
Store wrapper with `safari-web-extension-converter`.

## Run in a simulator

Set `DEVELOPER_DIR` if your active toolchain isn't full Xcode (e.g. Xcode-beta):

```bash
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer   # or Xcode-beta
VITE_DISABLE_PWA=true yarn workspace @ci/fe-web build
yarn cap sync ios && cd ios/App
SIM=$(xcrun simctl list devices available | grep -m1 'iPhone' | grep -oE '[0-9A-F-]{36}')
xcodebuild -workspace App.xcworkspace -scheme App -configuration Debug \
  -destination "id=$SIM" -derivedDataPath ./DerivedData build
xcrun simctl install $SIM ./DerivedData/Build/Products/Debug-iphonesimulator/App.app
xcrun simctl launch  $SIM com.companionintelligence.app
```

Simulator ad-hoc signing has no Keychain entitlement, so the native store
keeps `ci.apiKey` in the app container on Simulator only. Device and store
builds still use the Keychain. `CODE_SIGNING_ALLOWED=NO` remains CI-only.
List sims with `xcrun simctl list devices available`.

## CI builds (GitHub Actions)

`.github/workflows/mobile-build.yml` builds both apps in CI (modelled on CI-Hub's
`desktop-build.yml`).

> ⚠️ **Manual dispatch only.** The `mobile-v*` tag trigger was removed — pushing a tag
> builds nothing, and the workflow never runs on a pull request. **CI silence means
> nobody dispatched it, not that anything passed.** Run it deliberately:
>
> ```bash
> gh workflow run mobile-build.yml --ref <branch-or-tag>
> ```
>
> or from **Actions → Mobile Build → Run workflow**.

Two jobs run in parallel and upload their output as run artifacts:

| Job | Runner | Artifact | Installable on |
|-----|--------|----------|----------------|
| **Android (APK)** | `ubuntu-latest` | `companion-android-apk` (debug APK) | any device via `adb install` / sideload |
| **iOS (Simulator .app)** | `macos-latest` | `companion-ios-simulator-app` (zipped `.app`) | iOS Simulator only |

Each job runs: root `yarn install` → `yarn workspace @ci/fe-web build` (PWA disabled via
the `VITE_DISABLE_PWA` env) → mobile `yarn install` → `cap sync` → native build
(`gradlew assembleDebug` / `xcodebuild -sdk iphonesimulator`) → `upload-artifact`.
Download the artifacts from the run's summary page, then:

```bash
# Android — unzip the artifact, then:
adb install -r app-debug.apk

# iOS Simulator — unzip companion-ios-simulator.app.zip, then:
xcrun simctl install booted App.app
xcrun simctl launch booted com.companionintelligence.app
```

## Store releases (`.github/workflows/mobile-release.yml`)

`mobile-build.yml` above is the **credential-free** lane — unsigned artifacts, no secrets.
`mobile-release.yml` is the **only** store lane: a signed `.ipa` to TestFlight and a
signed `.aab` to Play's internal track. Xcode Cloud is not part of this chain —
turn it off (see below).

```bash
# Rehearsal: build + sign + validate with Apple, submit nothing.
# Always dispatch on a BRANCH. dry_run defaults to true; platform defaults to ios.
gh workflow run mobile-release.yml --ref main -f dry_run=true -f platform=ios

# The real thing — tag the commit you want, then push the tag.
git tag -a ios-v1.0.0 -m "iOS 1.0.0"
git push origin ios-v1.0.0
```

Tag prefixes pick the lane:

| Tag | What submits |
|---|---|
| `ios-v1.0.0` | TestFlight only |
| `android-v1.0.0` | Play internal only |
| `mobile-release-v1.0.0` | both |

A tag **push** always submits. A manual dispatch honours `dry_run` even if `--ref`
points at a tag. Marketing version comes from the tag suffix (or `version_name`);
the build number is `github.run_number`.

> GitHub only exposes a `workflow_dispatch` workflow that exists on the default branch,
> so a copy living only on a feature branch answers
> `HTTP 404: workflow not found on the default branch` — even with `--ref`. Both mobile
> workflows are on `main` today; this matters only when editing them on a branch.

**Always do a `dry_run: true` run first.** Both stores permanently consume a build number
on upload, so a failed submission *after* a successful one still costs you that number.
The dry run exercises the whole chain — keychain import, archive, export, and
`altool --validate-app`, which catches most rejections (missing icons, bad entitlements,
a build number already used) — and stops short of submitting.

Each platform **skips rather than fails** when its secrets are missing, so you can wire up
one store before the other.

## Xcode Cloud (`ci_scripts/ci_post_clone.sh`) — do not use for TestFlight

`App | BuildTestFlight` in App Store Connect is a **second, automatic** route to
TestFlight. It starts from branch activity, not from a release tag, and that is
too easy to fire by accident. **Delete the workflow**:

App Store Connect → Xcode Cloud → Manage Workflows → `App | BuildTestFlight`
→ Delete Workflow.

Repo-side equivalent (App Store Connect API; run once from `main` after
`APPSTORE_*` secrets are set):

```bash
gh workflow run xcode-cloud-manual-only.yml --ref main
```

Keep the `ci_scripts/ci_post_clone.sh` bootstrap in the repo so a future
intentional Xcode Cloud run still works. It is not a trigger.

Xcode Cloud clones the repo and runs `xcodebuild` against `ios/App/App.xcworkspace`
directly. It has no equivalent of a workflow step, so everything the GitHub Actions lanes
do before building has to happen in a post-clone script instead. Without one the build
fails before compiling anything:

```
Unable to open base configuration reference file
'.../ios/App/Pods/Target Support Files/Pods-App/Pods-App.debug.xcconfig'
```

That file — like `App/Pods`, `App/App/public` and `App/App/capacitor.config.json` — is
generated and correctly gitignored. `ci_scripts/ci_post_clone.sh` at the repository root
creates them, running the same sequence as `mobile-build.yml`'s iOS job: install Node 22
and CocoaPods (Xcode Cloud images ship neither), root `yarn install`, `yarn build:web`,
then `cap sync ios`, which is what finally runs `pod install`.

> **`NODE_AUTH_TOKEN` must be set on the workflow, as a secret.** `@ci/fe-web` depends on
> `@companionintelligence/tokens` from GitHub Packages, whose archive URL answers `401`
> unauthenticated, and this repo is not zero-install — so a cold runner has to fetch it.
> Add it under App Store Connect → Xcode Cloud → Manage Workflows → Environment →
> Environment Variables, ticking **Secret**, using a GitHub token with `read:packages`.
> The script fails immediately with this instruction when the variable is absent, rather
> than letting `yarn install` die on an opaque 401 several minutes in.

A copy of the script also exists at `ios/App/ci_scripts/ci_post_clone.sh`, forwarding to
the root one. Apple documents `ci_scripts/` as living beside the Xcode project, but
repository-root placement is also common and which one a workflow honours depends on its
configuration; both exist so the script cannot silently fail to run. **Once a build log
shows which location was used, delete the other.**

### Required secrets

| Secret | What it is |
|---|---|
| `APPSTORE_ISSUER_ID` | App Store Connect → Users and Access → Integrations |
| `APPSTORE_KEY_ID` | that API key's ID |
| `APPSTORE_PRIVATE_KEY` | the `AuthKey_<KEYID>.p8` contents (PEM text) |
| `APPLE_TEAM_ID` | 10-character team ID |
| `IOS_DIST_CERT_P12_BASE64` | base64 of the Apple Distribution `.p12` |
| `IOS_DIST_CERT_PASSWORD` | that `.p12`'s password |
| `IOS_PROVISIONING_PROFILE_BASE64` | base64 of the App Store `.mobileprovision` for `com.companionintelligence.app` |
| `ANDROID_KEYSTORE_BASE64` | base64 of the upload `.jks` |
| `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD` | keystore credentials |
| `PLAY_SERVICE_ACCOUNT_JSON` | Play service account with *Release to testing tracks* |

An App Store Connect **API key** is used rather than an Apple ID so CI never faces a 2FA
prompt.

### Version numbers are stamped by CI, not committed

`versionCode` / `versionName` in `build.gradle` and `MARKETING_VERSION` /
`CURRENT_PROJECT_VERSION` in the Xcode project are **local-dev fallbacks only**. The
release workflow resolves one version per run and hands identical numbers to both stores:
the marketing version comes from the `version_name` dispatch input, falling back to an
`ios-v*` / `android-v*` / `mobile-release-v*` tag suffix and then to `0.1.0`; the build
number comes from `github.run_number` (monotonic per workflow, which is exactly the
"never repeats, always increases" rule both stores enforce). Don't hand-bump the
literals expecting them to reach a store.

Android's local release-build rules live in the Android package —
[`frontend/apps/android/README.md`](../android/README.md#local-release-builds).

## On-device live reload

Run the web dev server (`yarn workspace @ci/fe-web dev`, bound to `0.0.0.0`), then:

```bash
CAP_SERVER_URL=http://<lan-or-tailscale-ip>:5173 yarn run   # = cap run ios
```

Point the in-app `/server` setting at your API origin so data calls resolve. Unset
`CAP_SERVER_URL` for a bundled build.

## App icons & splash

Source artwork lives in `assets/` (committed); platform icons + splash are generated
into `ios/` with
[`@capacitor/assets`](https://github.com/ionic-team/capacitor-assets):

```bash
cd frontend/apps/ios
# assets/ holds: icon-only.png, icon-foreground.png, icon-background.png (1024²)
#                splash.png, splash-dark.png (2732²)
npx @capacitor/assets generate \
  --iconBackgroundColor '#000000' --iconBackgroundColorDark '#000000' \
  --splashBackgroundColor '#ffffff' --splashBackgroundColorDark '#0b1f28'
```

The home-screen icon is the Companion Memory mark from CI-Marketplace
(`apps/ci-memory/metadata/logo.png` — neural-map brain on black). The splash
keeps the CI globe, slightly larger than the original 201px mark. Re-run after
changing the artwork, then rebuild. (Note: `icon-only.png` is required for the
flat iOS/legacy icon; without it the iOS icon falls back to the tool's placeholder.)

## iOS 26 SDK compatibility (re-apply if you regenerate `ios/`)

Capacitor 7's generated iOS project does **not** build against the iOS 26 SDK out of
the box. The committed `ios/` already includes these fixes; if you delete and
`cap add ios` again, re-apply them:

1. **Deployment target 14 → 15** (Xcode 26 dropped iOS 14): `platform :ios, '15.0'` in
   `ios/App/Podfile` **plus** a `post_install` loop forcing every pod target's
   `IPHONEOS_DEPLOYMENT_TARGET = 15.0` (Capacitor's `assertDeploymentTarget` only
   warns), and the App project's targets — then `pod install`.
2. **UIScene adoption** (the SDK *traps* at launch — `EXC_BREAKPOINT` — without a real
   `UIWindowSceneDelegate`): `ios/App/App/SceneDelegate.swift` builds the window from
   the `Main` storyboard; `Info.plist` declares a `UIApplicationSceneManifest` →
   `UISceneConfigurations` with `UISceneDelegateClassName =
   $(PRODUCT_MODULE_NAME).SceneDelegate`, and drops `UIMainStoryboardFile`.

## Native auth (wired)

Email/password sign-in works on native without cookies: after login the app mints a
long-lived **API key** (`POST /api/keys`), stores it in the OS keystore
(`capacitor-secure-storage-plugin`), and sends `x-api-key` on every request. The key
is restored from the keystore on startup, so sessions persist across launches. Logout
clears the local key (server-side revocation is in Settings → API Keys — the
`/api/keys` revoke endpoint is JWT-only).

**OIDC ("Sign in with CI Portal")** opens the **system browser**
(`@capacitor/browser`) and returns into the app via the **`companion://` deep link**
(`@capacitor/app` `appUrlOpen`): the backend redirects the native callback to
`companion://oidc/callback?code=<one-time-code>`, which the app exchanges for a
session. Keep the scheme in sync across `ios/App/App/Info.plist` (`CFBundleURLTypes`),
the Android `AndroidManifest.xml` intent-filter (documented in `capacitor.config.ts`),
`@ci/common`'s `OIDC_NATIVE_SCHEME`, and `auth.oidc.nativeRedirectScheme`.

## Native capabilities & permissions

**Camera + microphone (capture).** The existing in-webview capture (`@ci/capture`,
`navigator.mediaDevices.getUserMedia`) works natively once the OS permissions are
declared — the webview's permission request maps to the OS prompt on first use. Wired:
- **iOS** (`Info.plist`): `NSCameraUsageDescription`, `NSMicrophoneUsageDescription`,
  `NSPhotoLibraryAddUsageDescription`, `NSPhotoLibraryUsageDescription`.
- **Android** (`AndroidManifest.xml`): `CAMERA`, `RECORD_AUDIO`,
  `MODIFY_AUDIO_SETTINGS` (+ `<uses-feature camera required="false">`).

**Status bar + splash (branding).** Configured in `capacitor.config.ts` under
`plugins`. The splash shows the CI globe on a brand background until the web app mounts
(`SplashScreen.launchAutoHide: false`; `useNativeShell` calls `hideSplashScreen()` after
first paint to avoid a flash). The status bar is **theme-aware**: `useNativeShell`
mirrors the web app's light/dark theme (the `dark` class on `<html>`) onto
`@capacitor/status-bar` — light glyphs over a dark bar in dark mode, dark glyphs over a
light bar in light mode — and re-applies on theme change via a `MutationObserver`.

**Local notifications.** `@capacitor/local-notifications` is wired through `@ci/common`
(`requestNotificationPermission`, `hasNotificationPermission`, `scheduleLocalNotification`)
with a web no-op fallback. Android 13+ needs the `POST_NOTIFICATIONS` runtime permission
(declared). All native-bridge helpers are unit-tested in
`frontend/apps/web/src/test/nativeBridge.test.ts`.

These bridges live in `@ci/common/src/utils/nativeBridge.ts` and reach the plugins via
the runtime `window.Capacitor.Plugins` global (no `@capacitor/*` import in the web
bundle); the standalone mobile project declares the actual plugin packages.

**Apple App Intents (iOS, Siri / Shortcuts / Spotlight).** Native Swift App Intents in
`ios/App/App/` expose Companion's core actions to the system (gated `@available(iOS
16+)`; the app still supports iOS 15, where they're simply absent):
- **Ask Companion** (`AskCompanionIntent`) — asks a question via `POST /api/llm/generate`
  and speaks the answer (parses the endpoint's length-prefixed binary text frames).
- **Search Memory** (`SearchMemoryIntent`) — runs the GraphQL `search` query and reports
  the match count + top titles.
- **Remember** (`RememberIntent`) — creates a note via the `createNote` mutation.
- **Open Companion** (`OpenCompanionIntent`) — launches the app.

`CompanionShortcuts` (an `AppShortcutsProvider`) registers Siri phrases so the actions
appear in Spotlight and the Shortcuts app automatically — no extension or special
entitlement needed. The intents run **outside the webview**, so they read config from
the Keychain rather than `localStorage`: `CompanionConfig` reads the API key
(`cap_sec`/`ci.apiKey`, already written by the auth flow) and the server origin
(`cap_sec`/`ci.apiBaseUrl`, mirrored from localStorage by `syncNativeIntentConfig()` in
`useNativeShell`). `CompanionAPI` is a small `URLSession` client that authenticates with
`x-api-key`. Intents short-circuit with a friendly Siri error when the user hasn't set a
server / signed in. (Execution is direct REST/GraphQL today; it can later target a
deterministic Intent-Catalog execute endpoint when `feat/intent-catalog` lands.)

**On-device chat completion (LocalLLM, early preview).** A `LocalLLM` Capacitor plugin
(`android/.../localllm/`, `ios/App/App/LocalLLM/`) starts a loopback-only HTTP server
(`127.0.0.1`, random port, per-launch bearer token) exposing an OpenAI-compatible
`POST /v1/chat/completions` (SSE) backed by [LiteRT-LM](https://github.com/google-ai-edge/LiteRT-LM)
running fully on-device — no appliance connection needed. JS reaches it via
`@ci/common`'s `startLocalLlm`/`loadLocalLlmModel`/etc. (`nativeBridge.ts`) plus a direct
SSE client (`localLlm.ts`); try it from Settings → On-device model. This is a skeleton,
not the full offline-mode design: no model download UI wired to a real source yet (push
a `.litertlm` file onto the device and paste its path), no capability gating, no
integration with the appliance-routed chat page.

- **Android:** minSdk stays 23; the plugin itself gates on `Build.VERSION.SDK_INT >= 31`
  (LiteRT-LM's AAR requires Android 12), so older devices keep the rest of the app.
- **iOS:** the LiteRT-LM Swift package is vendored, not consumed via SPM — Apple blocks
  an Xcode *target* from linking a *remote* SPM package that declares unsafe linker
  flags (LiteRT-LM needs `-Xlinker -all_load`), so `ios/App/App/Vendor/LiteRTLM/` holds
  the package's own Swift wrapper source directly, and `ios/App/Frameworks/` holds the
  binary `CLiteRTLM.xcframework` it links against as a plain framework instead. **That
  xcframework is 81MB and not committed** — run
  `ios/App/Frameworks/fetch-clitertlm-xcframework.sh` once before building for iOS (also
  needed in any CI job that builds this target).
- Neither platform's Simulator/emulator reliably runs LiteRT-LM inference (confirmed via
  an open upstream issue for iOS Simulator; untested on Android emulator) — test on a
  real device.

## On-device agent tooling (intent hooks, both platforms)

The local model can call CI's **published intents** as tools, so it answers from your memory instead
of its own weights. Enable it per platform with `LocalLLM.configureIntentTools({ baseUrl, apiKey })`;
the plugin then fetches the intent catalog with `?tier=local` and binds what the appliance allows.

> **Watch the doubled `/api`.** `IntentsController` is `@Controller('api/intents')` while the
> fronting proxy already strips a leading `/api`, so from an app holding the proxy origin the real
> path is `<base>/api/api/intents?tier=local` — which is exactly what `CompanionIntentClient`
> requests on both platforms. `McpController` is `@Controller('mcp')`, so it is reached at the
> ordinary `<base>/api/mcp`. (`/api/agent/intents` is the canonical prefix for new callers;
> `/api/intents` still serves and is what these clients use.)

**One security rule, not three.** The appliance computes the `execute` / `queue` / `deny` ruling
(`dispatchPolicy.ts`) and publishes it per intent; the phone reads `dispatch.decision` and obeys it.
Neither Kotlin nor Swift re-derives the policy — `dispatchPolicy.ts` says why ("two copies of a
security rule are two rules"), and it means a policy change ships with the appliance instead of
waiting on two app-store releases. Destructive and external intents always queue on-device.

**The binding is per-platform, because the runtimes genuinely differ:**

| | Android | iOS |
|---|---|---|
| Mechanism | `OpenApiTool` — runtime JSON-schema string + raw args | `Tool` protocol — `Mirror` over compile-time `@ToolParam` |
| Coverage | **Every** published intent, automatically | Hand-written struct per intent |
| New server-side intent | Picked up on next catalog fetch | Needs an app release |

That asymmetry is structural, not an oversight: the LiteRT-LM Swift surface has no `OpenApiTool`
equivalent (verified against the vendored source — 18 public types, one tool protocol, no
schema-string entry point), so iOS cannot construct tools dynamically at all.

Execution goes over MCP `tools/call` (`POST /mcp`) — there is no REST "execute this intent"
endpoint — authenticated with the same `x-api-key` the App Intents already use.

**iOS.** The iOS plugin implements the same JS contract as `@ci/capacitor-local-llm`
(`isAvailable`/`getModelStatus`/`downloadModel`/`deleteModel`/`loadModel`/`generate`/`generateStream`/
`cancel`, plus the `llmToken` and `modelDownloadProgress` events), so `@ci/common`'s
`generateOffline()` picks it up with no web changes. Downloads are resumable: a partial lands in
`<name>.part` and the next attempt continues with an HTTP `Range` request, so a force-quit or a lost
connection costs nothing. It still lives in the app target rather than that package (which declares
itself Android-only); moving it there needs a podspec + vendored xcframework + Podfile regeneration.

> ✅ **Fixed 2026-08-26 — Android's model catalog used to be broken.** It pointed at
> `litert-community/Gemma3-1B-IT`, a repo Hugging Face now serves `gated: "auto"`, so the `.task`
> URL in `LocalLlmModels.kt` / `definitions.ts` answered `401 GatedRepo` to an anonymous download —
> meaning no new Android user could fetch the only model offered. Android now ships the same
> ungated Qwen3-0.6B iOS already used (`litert-community/Qwen3-0.6B`); both platforms ship the
> identical model file. See `LocalLLMModels.swift` and `LocalLlmModels.kt` for the measurements.

**Also fixed 2026-08-26, same pass:**

- **iOS had no multi-turn memory.** `LocalLLMEngine` used to create a fresh, historyless
  `Conversation` on every `generate()`/`generateStream()` call; Android kept one alive across
  calls. Both platforms now keep a single `Conversation` per loaded model, created once in
  `load()` (which is also where tools are now bound, not per-call), so turn history
  accumulates natively on both platforms the same way.
- **No thermal or battery governor existed at all.** Both platforms now check the OS's live
  thermal signal (`ProcessInfo.thermalState` / `PowerManager.getCurrentThermalStatus()`) before
  starting generation, and cancel an in-flight one if the device crosses `.critical` /
  `THERMAL_STATUS_SEVERE` mid-stream.
- **Nothing protected an in-flight generation from being killed if briefly backgrounded** — only
  the model *download* had that. Android now wraps `generate()`/`generateStream()` in a
  foreground service; iOS wraps them in `beginBackgroundTask`. Both are best-effort, not a
  guarantee — see `LocalLLMPlugin.swift`'s doc comment for why `BGContinuedProcessingTask`
  (iOS 26+) is the fuller answer and a separate, UX-affecting change.
- **The Android AAR and iOS xcframework had drifted** (0.11.0 vs 0.14.0 of the same upstream
  LiteRT-LM release) with no record of why. Reconciled to 0.14.0 on both.
- **The RAM floor was unreconciled 2x between platforms** (Android 3 GB total RAM vs iOS 6 GB
  physical memory) for models with the same ~2 GB estimated peak RSS. Both now gate at 4 GB.
- **LiteRT-LM's own constrained-decoding flag** (`enableConversationConstrainedDecoding`) is now
  wired on both platforms but left `false` — Google's own default, and it stays that way until
  someone can verify it against a real device rather than flip an experimental native decoding
  path on top of a baseline no commit has confirmed runs inference at all. See the constant's
  doc comment in `LocalLLMEngine.swift` / `LocalLlmEngine.kt` to turn it on once that's possible.

## Not yet wired (later phases)

- **APNs / FCM keys on the appliance** — the app registers a device push token with
  `POST /api/devices`. Delivery goes through Portal (`PORTAL_PUSH_RELAY_URL`), not a
  LAN box holding the app's push key. Until that relay is populated, local
  notifications still work.
- **iOS Screen Time / installed-app inventory** — impossible on iOS (`DeviceActivityReport`
  cannot leave its extension). Do not build it. Android `PACKAGE_USAGE_STATS` is a
  later Android-only feature.
- **Contacts and Health** — gated by DEVICE_DATA_COMPLIANCE / SECURITY_ARCHITECTURE.
  Picker-first photos ship; full-library photo access, contacts, and HealthKit do not.

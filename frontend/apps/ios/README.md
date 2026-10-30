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
  (same-origin), the configured origin on native. That covers every `fetch`, XHR,
  `src`, `href` and `window.open`, not just GraphQL: the page origin is
  `capacitor://localhost`, so a bare `/api/...` or `/static/...` there is a request to
  the app's own bundle. Media paths go through `resolveMediaUrl()` (it adds the
  `/static` prefix and the origin), and a link meant for another device — a share
  link, a QR code, a webhook address — takes `getWebOrigin()`, never
  `window.location.origin`.
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

## Supported devices — Universal (iPhone + iPad)

`TARGETED_DEVICE_FAMILY = "1,2"` in **both** the Debug and Release configs of the App
and SafariWebExtension targets, paired with `UISupportedInterfaceOrientations~ipad` in
`Info.plist` (all four orientations) and the 3-tier `compact`/`medium`/`expanded`
adaptive layout classification in `@ci/common` (`useDeviceLayout`) and `@ci/fe-web`
(`useDeviceBreakpoint`).

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

`cap sync` runs `pod install`, which rewrites `ios/App/Podfile.lock` whenever the plugin set changes (a new
`@ci/capacitor-*` package, a version bump). **Commit the lock when it changes**: Xcode refuses to build if the
`Pods/` it finds was installed from a different lock than the committed one ("The sandbox is not in sync with the
Podfile.lock"), and a lock that lags leaves every sync with a dirty tree. Likewise a Swift file added under
`ios/App/App` has to be added to the `App` target in `App.xcodeproj` (the Xcode app does it; by hand, use the
`xcodeproj` gem that ships with CocoaPods). `capacitorPluginContract.test.ts` fails when either drifts.

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
signed `.aab` to Play's internal track.

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

The script is `yarn ios` (= `cap run ios`). It used to be called `run`, but Yarn's
own `run` command shadows a script of that name: a bare `yarn run` only prints the
script list and exits 0, so nothing was ever built or deployed.

Run the web dev server on every interface
(`DEV_LISTEN_HOST=0.0.0.0 yarn workspace @ci/fe-web dev`; without the variable it
listens on `127.0.0.1` only and the device cannot reach it), then:

```bash
CAP_SERVER_URL=http://<lan-or-tailscale-ip>:5173 yarn ios
```

`CAP_SERVER_URL` is baked into the app: the WebView loads the whole web app from
that URL. Unset it for a bundled build.

**Signing in.** Vite proxies `/api`, so the dev-server URL is a complete API origin.
On first launch the app routes to `/device-connect` (Portal). There is no in-app
field for a local server origin yet (`/device-connect/advanced` only stores the
Portal URL). To sign in with an email/password account, set the origin from Safari
Web Inspector (Develop → device → the app's WebView), then open `/login` and choose
"Sign in with email instead". Use the LAN or Tailscale IP, not `localhost`: on iOS a
`localhost`, `*.localhost` or `*.local` origin always routes back to `/device-connect`.

```js
localStorage.setItem('ci.apiBaseUrl', 'http://<lan-or-tailscale-ip>:5173'); location.href = '/login';
```

## App icons & splash

Source artwork lives in `assets/` (committed); platform icons + splash are generated
into `ios/` with
[`@capacitor/assets`](https://github.com/ionic-team/capacitor-assets):

```bash
cd frontend/apps/ios
# assets/ holds: icon-only.png, icon-foreground.png (identical), icon-background.png (1024²)
#                splash.png, splash-dark.png (2732²)
# icon-only/-foreground ARE the Companion Memory store icon (opaque 1024², the artwork the App
# Store listing shows). They are NOT mirrors of @companionintelligence/assets (whose
# logos/app-icon-source.png is the company aperture mark), so `brand:sync` does not touch them.
npx @capacitor/assets generate \
  --iconBackgroundColor '#041620' --iconBackgroundColorDark '#041620' \
  --splashBackgroundColor '#ffffff' --splashBackgroundColorDark '#0b1f28'
```

The home-screen icon is the Companion Memory store icon: a solid teal brain with a white
node network and a dark M on `#041620`. iOS needs it opaque with no alpha, so
`ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png` is the same bytes as
`assets/icon-only.png` (re-running the generator above reproduces it pixel for pixel; the
iOS generator reads only `icon-only.png`, and `--iconBackgroundColor` is a no-op on an
opaque source). `icon-background.png` is flat `#041620` to match. The splash keeps the CI
globe, slightly larger than the original 201px mark. Re-run after changing the artwork, then
rebuild. (Note: `icon-only.png` is required for the flat iOS/legacy icon; without it the
iOS icon falls back to the tool's placeholder.)

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

**OIDC ("Sign in with CI Portal")** on iOS presents an in-app Safari authentication
sheet (`ASWebAuthenticationSession` via `LocalHub.startAuthSession`), not the Safari
app and not `SFSafariViewController` (that sheet swallows `companion://`). The session
hands the callback to `ApplicationDelegateProxy`, which raises `@capacitor/app`
`appUrlOpen`. The backend redirects the native callback to
`companion://oidc/callback?code=<one-time-code>`, which the app exchanges for a
session. Android still opens the system browser. Keep the scheme in sync across
`ios/App/App/Info.plist` (`CFBundleURLTypes`), the Android `AndroidManifest.xml`
intent-filter (documented in `capacitor.config.ts`), `@ci/common`'s
`OIDC_NATIVE_SCHEME`, and `auth.oidc.nativeRedirectScheme`.

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

**On-device chat (LocalLLM).** A `LocalLLM` Capacitor plugin runs a language model fully on the
phone through [LiteRT-LM](https://github.com/google-ai-edge/LiteRT-LM) — the runtime Google's
[AI Edge Gallery](https://github.com/google-ai-edge/gallery) ships, whose model allowlist and
`LlmChatModelHelper` this is modelled on. Android implements it in
`frontend/packages/capacitor-local-llm/android/`; iOS implements the **identical JS contract** in the app
target (`ios/App/App/LocalLLM/`). Nothing you type leaves the device and it works with no connection.

The web layer is `@ci/common`'s `localLlm.ts` (probe / download / load / stream over the runtime
`window.Capacitor.Plugins.LocalLLM` bridge), `localLlmCatalog.ts` (the model list) and
`localLlmPrefs.ts` (per-device routing preferences). The UI is **Settings → On-device model** and the
chat page; `nativeBridge.generateOffline()` remains the one-shot helper.

**Models.** The catalog is Gallery's allowlist cut down to what an anonymous in-app download can fetch.
Every entry is Apache-2.0, ungated, and **pinned to a Hugging Face commit** with its exact byte size — the
download is verified against that size, and a pinned URL cannot drift under it.

| Model | Size | Min RAM | Backends | Reasoning | Photos | Memory tools | Platforms |
|---|---|---|---|---|---|---|---|
| Gemma 4 E2B | 2.4 GB | 6 GB (GPU from 8 GB) | CPU, GPU | ✓ | ✓ | ✓ | Android |
| Gemma 4 E4B | 3.4 GB | 12 GB | CPU, GPU | ✓ | ✓ | ✓ | Android |

Left out on purpose: Gemma 3n, Gemma3-1B-IT and the FunctionGemma fine-tunes. Hugging Face serves them
`gated` (an account plus a licence click-through), so an anonymous download answers `401 GatedRepo` — the
bug that once left Android with no downloadable model at all. They return with an HF sign-in flow.
Gemma 4 is Android-only because the iOS app has no `com.apple.developer.kernel.increased-memory-limit`
entitlement (an App ID capability only the account owner can enable), and a 2.6–3.7 GB model would be
jetsam-killed without it.

**What the user sees.** Settings → On-device model lists the models this device can hold (with the reason
when it cannot), downloads with live progress and **Cancel**, deletes, loads and unloads, and offers CPU/GPU,
"Think before answering" and "Look things up in Memory". *When to use it* is a separate choice and defaults
to the appliance:

- **Always use my Companion** — the on-device model is never used.
- **Use my Companion, fall back to this phone** — chat goes to the appliance; a dropped connection or a
  502/503/504 answers on the phone instead, with a toast. A 401/403/500 is *not* treated as offline.
- **Always answer on this phone** — never calls the appliance. If the model is missing it refuses rather than
  quietly falling through, and attachments (which live on the appliance) are refused rather than dropped.
  With a Gemma 4 model, "attach" picks photos that are read on the phone as base64 and never uploaded.

A reply from the phone shows *Answered on this phone · model · tok/s · time to first token*. "New chat" and
switching threads call `resetConversation()` so turns do not leak between chats. On-device turns are not
saved as appliance threads.

**Contract additions (v2).** `cancelDownload`, `getLoadedModel`, `resetConversation`; `loadModel` takes
`accelerator` (a GPU that will not initialise falls back to the CPU and says so) and
`enableSpeculativeDecoding`; `generate*` take `enableThinking` and `images`; results and the terminal
`llmToken` event carry `thought` and `stats` (`timeToFirstTokenMs`, `decodeTokensPerSecond`, …);
`isAvailable` reports `totalMemoryBytes` and `freeDiskBytes`. The disk check is now per model (remaining
bytes + 512 MiB) instead of a global 1 GiB, and `downloadModel` refuses any URL not on `huggingface.co`.
`capacitorPluginContract.test.ts` parses `definitions.ts`, the Kotlin and the Swift catalogs and both
method lists, so the halves cannot drift.

**Known limits (measured on LiteRT-LM 0.14.0 with the Android emulator; the app links 0.18.0 since the bump, re-measure on a device).**

- A cancelled conversation cannot be reused, so after **Stop** — or a failed turn — the next message starts a
  fresh conversation and the model forgets earlier turns, even though the chat still shows them. Replaying
  history through `initialMessages` is the follow-up.
- Gemma 4 fixes thinking on or off at the first turn of a conversation, so toggling "Think before answering"
  mid-chat also starts a fresh conversation.
- A GPU backend can pass `initialize()` and fail only on its first token ("Can not find OpenCL library"), so a
  GPU load probes one token and falls back to the CPU itself (`fellBackToCpu`). The plugin manifest declares
  `libOpenCL.so` / `libvndksupport.so` (`required=false`), which Android 12+ needs before an app targeting API 31+
  may open the vendor OpenCL library; that effect needs a real GPU device to confirm.
- The catalog is pinned to revisions that load on the runtime both platforms link (0.18.0). Qwen3's pin is the 0.17.1+ re-export; any further repin goes on both
  platforms *before* repinning it.
- **Play Console:** the Android plugin manifest again declares `FOREGROUND_SERVICE_DATA_SYNC` and
  `foregroundServiceType="dataSync"` on both `LocalLlmGenerationService` and WorkManager's
  `SystemForegroundService` (removed in #2776 while nothing could start a download; restored now that Settings →
  On-device model and on-device chat can). Without them Android 14+ throws `SecurityException` and Android 10+
  `IllegalArgumentException` from `startForeground()` the moment a user taps Download or sends a message. Play
  needs the dataSync declaration (a 0.3–3.6 GB resumable model download) and a demo of that screen.
- A conversation whose context window fills (Qwen3: 1,024 tokens, Gemma 4: 4,000) answers every later message with
  nothing. The web layer detects that empty completed turn, says so, resets the conversation and asks once more —
  the model loses the earlier turns, the screen does not. A native token-count check that resets *before* sending
  is the cleaner follow-up.
- On-device turns are ephemeral, and per-call `maxTokens`/`topK`/`topP`/`temperature` on `generate` are ignored:
  LiteRT-LM fixes the sampler when the conversation is created.

**Not verified on a device.** Nothing here has run inference on a real phone. On an Android emulator (CPU) the
engine was exercised for Qwen3 (the pinned revision), Qwen2.5, and Gemma 4 E2B — load, streaming, reset, cancel,
thinking, a vision prompt, and the speculative-decoding flag; Gemma 4 E4B (3.65 GB) did not fit that emulator, and
nothing on iOS has run inference at all (it compiles and its pure logic and downloader were exercised off-device).
Compiled and unit-tested: the catalog, download resume/verification, policy decisions (RAM/disk/URL), stats maths,
image sizing and the web layer. **Unverified until someone runs a phone:** actual generation,
GPU/Metal init, multi-token prediction, whether a model emits the `thought` channel or leaks `<think>` tags,
photo input on Gemma 4, and memory headroom (iOS `physicalMemory` reports below the marketing figure — a
"6 GB" iPhone reports ~5.6 GB and will not be offered Qwen2.5). **Not built** from Gallery: Prompt Lab,
Agent Skills, Mobile Actions (FunctionGemma), audio input, the benchmark screen, importing a model file,
and NPU backends.

**Checking the iOS pure logic on a Mac.** `bash scripts/test-local-llm-pure.sh` (from this directory; needs only
`swiftc`) compiles the app's own `LocalLLMStreaming.swift`, `LocalLLMPolicy.swift` and `LocalLLMModels.swift`, plus
the vendored `LiteRTLMError.swift`, together with `tests/local-llm-pure/main.swift`, and runs it — reply assembly
(including the stripping of leaked chat-template markers such as `<|endoftext|>`), how a failed generation is worded
for the log and for JS, and the shaping of tool results. The project has no XCTest target, so these are plain
assertions that exit non-zero; anything that needs the engine, Capacitor or the xcframework is out of reach there.

**Checking the phone's own search on a Mac.** `bash scripts/test-local-search.sh` (needs `swiftc`, `clang` and a
prior `yarn cap sync ios`, which leaves the SQLCipher pod's sources in `ios/App/Pods`) builds that pod for the Mac,
compiles the app's own `LocalSearchStore.swift` with `tests/local-search/main.swift`, and runs `knowledge_search`'s
store against a real encrypted SQLite file with the replica's table and FTS index: text and count queries, type and
date filters, ordering, a wrong key, and the keychain lookup (it adds and removes one test item in the login
keychain). What it does not cover is the phone: the file's real location (`iosDatabaseLocation`) and the plugin's
real keychain item, which exist only after the web layer has opened the replica on a device that is signed in.

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
- The **iOS Simulator** does not reliably run LiteRT-LM inference (an open upstream issue) — test
  on a real device. The Android emulator does run it, on the CPU only (see "Known limits" below).

## On-device agent tooling (intent hooks, both platforms)

The local model can call CI's **published intents** as tools, so it answers from your memory instead
of its own weights. Enable it per platform with `LocalLLM.configureIntentTools({ baseUrl, apiKey })`;
the plugin then fetches the intent catalog with `?tier=local` and binds what the appliance allows.

> **One `/api`, for both.** The fronting proxy strips a leading `/api` and Nest sets no global
> prefix, so `IntentsController` (mounted at the bare `intents`) is reached at
> `<base>/api/intents?tier=local` and `McpController` (`mcp`) at `<base>/api/mcp` — which is what
> `CompanionIntentClient` requests on both platforms. The catalog used to be `<base>/api/api/intents`,
> while the controller baked its own `api/` into its mount; #2653 removed that, the clients kept asking
> for the doubled path, and on-device tools silently never bound against a current appliance (a 404 is
> swallowed so the model still loads, toolless). `capacitorPluginContract.test.ts` now checks both
> clients' paths against the controllers' real mounts. (`/api/agent/intents` is the canonical prefix for
> new callers; `/api/intents` still serves and is what these clients use.)

**One security rule, not three.** The appliance computes the `execute` / `queue` / `deny` ruling
(`dispatchPolicy.ts`) and publishes it per intent; the phone reads `dispatch.decision` and obeys it.
Neither Kotlin nor Swift re-derives the policy — `dispatchPolicy.ts` says why ("two copies of a
security rule are two rules"), and it means a policy change ships with the appliance instead of
waiting on two app-store releases. Destructive and external intents always queue on-device.

**A tool's result is bounded before the model sees it (iOS).** The appliance answers a tool call with the whole
result, pretty-printed — 25 hits from `knowledge_search` is ~45 KB — and a small model's context window cannot hold
it: Qwen3-0.6B's is 1,024 tokens, and its system prompt and tool declarations already take ~500 of them. Left alone,
that is many times the window. `ToolResultShaper` (in `LocalLLMPolicy.swift`) cuts it to half the window in bytes
(`toolResultByteBudget(contextTokens:)` — 512 for Qwen3-0.6B): a result that fits goes through untouched; otherwise
JSON is re-emitted compactly with long strings capped, each hit's `type`/`link`/`title` first, the search header
whole and as many whole hits as fit, and a closing note saying how many were left out. It is the device twin of the
appliance's own `toolResultBudget.ts`, and the budget is an estimate to tune on a device. `CompanionToolContext`
logs sizes only (`[LocalLLM] knowledge_search returned 45598 bytes; passing 482 …`), never the result. The Android
adapter returns the result unbounded and does not yet do this.

**The binding is per-platform, because the runtimes genuinely differ:**

| | Android | iOS |
|---|---|---|
| Mechanism | `OpenApiTool` — runtime JSON-schema string + raw args | `Tool` protocol — `Mirror` over compile-time `@ToolParam` |
| Coverage | **Every** published intent, automatically | Hand-written struct per intent |
| New server-side intent | Picked up on next catalog fetch | Needs an app release |

That asymmetry is structural, not an oversight: the LiteRT-LM Swift surface has no `OpenApiTool`
equivalent (verified against the vendored source — 18 public types, one tool protocol, no
schema-string entry point), so iOS cannot construct tools dynamically at all.

**What iOS binds today.** Three hand-written structs in `CompanionIntentTools.swift`: `knowledge_search`
(the tool for "what do I know about X", "when did I …", "how many …"), `people_find`, and `memory_recall`,
which is a graph lookup of a *person* and who they are connected to — it takes `personName` and nothing
else, because the appliance's `memory.recall` has no free-text or date-range parameter. Each `@ToolParam` must
be a same-named property of the intent's published schema and each `run()` must send exactly those;
`IntentCatalogService.realTools.test.ts` (backend) reads the Swift file against the real tool classes and fails
when they drift (the app used to send `query` / `startDate` / `endDate` to `memory_recall`, which the server
silently dropped, and `content` to `memory_remember`, which it rejected). `memory.remember` is **not** offered on
iOS: it writes graph entities (`operations: [{ kind: "entity.create", … }]`), not a Note, and no intent the local
tier may run creates a Note. Android still binds it, with the published schema, because it binds every
`execute` intent.

Execution goes over MCP `tools/call` (`POST /mcp`) — there is no REST "execute this intent"
endpoint — authenticated with the same `x-api-key` the App Intents already use.

**iOS.** The iOS plugin implements the same JS contract as `@ci/capacitor-local-llm`
(`isAvailable`/`getModelStatus`/`downloadModel`/`deleteModel`/`loadModel`/`generate`/`generateStream`/
`cancel`, plus the `llmToken` and `modelDownloadProgress` events), so `@ci/common`'s
`generateOffline()` picks it up with no web changes. Downloads are resumable: a partial lands in
`<name>.part` and the next attempt continues with an HTTP `Range` request, so a force-quit or a lost
connection costs nothing. It still lives in the app target rather than that package (which declares
itself Android-only); moving it there needs a podspec + vendored xcframework + Podfile regeneration.

Because it lives in the app target, **nothing generated knows it exists**: the `packageClassList` that
`cap sync` writes into `capacitor.config.json` is built from the `ios/` sources of *installed npm
packages*, and Capacitor 7 has no runtime scan. `ios/App/App/MainViewController.swift` is what puts it on
the bridge — a `CAPBridgeViewController` subclass whose `capacitorDidLoad()` calls
`bridge?.registerPluginInstance(LocalLLMPlugin())` (not `registerPluginType`, which is a no-op with the
default auto-registration). Three hand-maintained pieces must stay joined — the class, the root
`customClass` in `Main.storyboard`, and the file's entry in the App target's Sources — and `cap sync`
touches none of them, but `cap add ios` would restore the stock class: Settings → On-device model would
then read "On-device models run in the iOS and Android apps." on a phone.
`capacitorPluginContract.test.ts` fails if any of the three drifts.

> ✅ **Fixed 2026-09-29 — Qwen3's `resolve/main` URL had drifted twice over.** The 2026-08-26 fix recorded
> `Qwen3-0.6B` at 344,437,808 bytes against a `resolve/main` URL. On 2026-09-20 Hugging Face's `main` became a
> re-export (344,671,744 bytes) that needs LiteRT-LM 0.17.1+: the downloader fetched all of it and failed its
> `length != expected` check on every attempt, and had it passed, the file fails `Engine.initialize()` on the
> 0.14.0 both platforms link. Every catalog URL is now pinned to a commit (`resolve/<sha>/…`), Qwen3 to the
> last revision that loads on 0.14.0 (`154c5de0…`, exercised on an emulator), and a test refuses `resolve/main`.
> Bumping LiteRT-LM is what would unlock the newer file.

> ✅ **Fixed 2026-08-26 — Android's model catalog used to be broken.** It pointed at
> `litert-community/Gemma3-1B-IT`, a repo Hugging Face now serves `gated: "auto"`, so the `.task`
> URL in `LocalLlmModels.kt` / `definitions.ts` answered `401 GatedRepo` to an anonymous download —
> meaning no new Android user could fetch the only model offered. Android now ships the same
> ungated Qwen3 iOS already used (`litert-community/Qwen3-*`); both platforms ship the
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
- **Bumped to 0.18.0 on both (2026-10-12).** Android: Kotlin plugin 2.4.21 (the AAR carries 2.4 metadata),
  minSdk 24 (the AAR declares it), `Capabilities` → `ModelInfo`. iOS: re-vendored `swift/` with the
  patches in `Vendor/LiteRTLM/PATCHES.md` re-applied, two of them now upstream. Qwen3 repinned to the
  0.17.1+ re-export (`a6e678a1…`, 344,671,744 bytes).
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

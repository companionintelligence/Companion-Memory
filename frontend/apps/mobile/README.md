# @ci/fe-mobile — Native iOS + Android shell (Capacitor)

A thin native shell that wraps the existing **`@ci/fe-web`** React/Vite build and
points it at a remote, self-hosted **CI-Server**. The server stays the brain; the app
is a thin client. **Both iOS and Android build and run today** (verified in the iOS
Simulator and an Android emulator).

> 📦 **Shipping to the stores?** See **[`DELIVERY.md`](./DELIVERY.md)** — the
> App Store / Play Store pre-submission checklist (what's done vs. still blocking) and
> the phased roadmap (Sentry, push notifications, deep links, Apple Intents, offline).

## How it works

- `capacitor.config.ts` sets `webDir: '../web/dist'` — the app ships the `@ci/fe-web`
  production build. No separate mobile UI codebase.
- The web app detects the native runtime via the injected `window.Capacitor` global
  (`isNativePlatform()` in `@ci/common`) and reads its **configured server origin from
  `localStorage`**. On first launch with no server set, it routes to the in-app
  `/server` screen to enter + health-check a CI-Server URL.
- All `/api/...` calls resolve through `buildApiUrl()` (`@ci/common`): `''` on web
  (same-origin), the configured origin on native.
- The native web build sets `VITE_DISABLE_PWA=true` so the Workbox service worker
  doesn't fight Capacitor's local asset serving.

## Standalone project (not a yarn workspace)

The monorepo uses Yarn **PnP**, but the Capacitor CLI / CocoaPods / Gradle need a real
`node_modules` tree. So this package is deliberately **excluded** from the root
workspaces (`"!frontend/apps/mobile"` in the root `package.json`) and installed on its
own. Its `.yarnrc.yml` sets `nodeLinker: node-modules`, so `yarn install` *inside this
directory* produces a conventional `node_modules` + its own `yarn.lock` — the root PnP
install is untouched. It depends on the web app only as a build artifact (`webDir`),
never as an npm import.

## Prerequisites

- **iOS:** macOS + **Xcode 26+** (the iOS 26 SDK is required — see SDK notes below) and
  **CocoaPods** (`brew install cocoapods`).
- **Android:** **Android Studio** (bundles a JDK + SDK), or a standalone **JDK 21** +
  Android SDK with `platform-tools`, `platforms;android-35`, `build-tools;35.0.0`.
- Backend CORS already allows the native origins (`backend/apps/api/src/main.ts`:
  `capacitor://localhost`, `http(s)://localhost`, plus the `X-API-Key` header);
  operators can extend it with `CORS_ALLOWED_ORIGINS`.

## First-time setup

```bash
# 1) Install this project's deps (isolated from root PnP):
cd frontend/apps/mobile && yarn install

# 2) Build the web bundle (from repo root, PWA disabled):
VITE_DISABLE_PWA=true yarn workspace @ci/fe-web build

# The ios/ and android/ projects are committed. Only on a checkout that lacks them:
#   yarn add:ios   # ⚠️ then re-apply the iOS 26 fixes — see "iOS 26 SDK" below
#   yarn add:android
yarn sync          # copies web assets + installs native plugin code
```

`yarn build` (= `build:web` + `cap sync`) rebuilds + syncs from this directory.

## Run in a simulator / emulator

**iOS** — set `DEVELOPER_DIR` if your active toolchain isn't full Xcode (e.g. Xcode-beta):

```bash
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer   # or Xcode-beta
VITE_DISABLE_PWA=true yarn workspace @ci/fe-web build
cd frontend/apps/mobile && yarn cap sync ios && cd ios/App
SIM=$(xcrun simctl list devices available | grep -m1 'iPhone' | grep -oE '[0-9A-F-]{36}')
xcodebuild -workspace App.xcworkspace -scheme App -configuration Debug \
  -destination "id=$SIM" -derivedDataPath ./DerivedData CODE_SIGNING_ALLOWED=NO build
xcrun simctl install $SIM ./DerivedData/Build/Products/Debug-iphonesimulator/App.app
xcrun simctl launch  $SIM com.companionintelligence.app
```

**Android** — Android Studio's bundled JBR is a convenient JDK 21:

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
VITE_DISABLE_PWA=true yarn workspace @ci/fe-web build
cd frontend/apps/mobile
echo "sdk.dir=$ANDROID_HOME" > android/local.properties
yarn cap sync android
(cd android && ./gradlew assembleDebug)
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.companionintelligence.app/.MainActivity
```

(Simulator builds need **no code signing**. List iOS sims with
`xcrun simctl list devices available`; Android AVDs with `emulator -list-avds`.)

## CI builds (GitHub Actions)

`.github/workflows/mobile-build.yml` builds both apps in CI (modelled on CI-Hub's
`desktop-build.yml`). Trigger it from **Actions → Mobile Build → Run workflow**, or by
pushing a `mobile-v*` tag:

```bash
git tag mobile-v0.1.0 && git push origin mobile-v0.1.0
```

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
`mobile-release.yml` is the **distribution** lane: a signed `.ipa` to TestFlight and a
signed `.aab` to Play's internal track.

```bash
# Rehearsal: build + sign + validate with Apple, but submit nothing.
gh workflow run mobile-release.yml -f dry_run=true

# The real thing (a tag push always submits — dry_run does not apply):
git tag mobile-release-v0.1.0 && git push origin mobile-release-v0.1.0
```

> **This workflow is not dispatchable until it is on the default branch.** GitHub only
> exposes a `workflow_dispatch` workflow that exists on `main`, so until this file is
> merged, `gh workflow run mobile-release.yml` answers
> `HTTP 404: workflow not found on the default branch` — even with `--ref`. To rehearse
> signing before the rest of the branch is ready, cherry-pick just this file onto `main`.

**Always do a `dry_run: true` run first.** Both stores permanently consume a build number
on upload, so a failed submission *after* a successful one still costs you that number.
The dry run exercises the whole chain — keychain import, archive, export, and
`altool --validate-app`, which catches most rejections (missing icons, bad entitlements,
a build number already used) — and stops short of submitting.

Each platform **skips rather than fails** when its secrets are missing, so you can wire up
one store before the other.

## Xcode Cloud (`ci_scripts/ci_post_clone.sh`)

There is a **second** route to TestFlight: an Xcode Cloud workflow named
`App | BuildTestFlight`, configured in App Store Connect rather than in this repository.
Nothing in the repo declares it, so it is easy to miss when reasoning about why an iOS
build is red — check App Store Connect → Xcode Cloud → Manage Workflows.

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
the marketing version comes from the `mobile-release-v*` tag, and the build number from
`github.run_number` (monotonic per workflow, which is exactly the "never repeats, always
increases" rule both stores enforce). Don't hand-bump the literals expecting them to
reach a store.

### Local release builds

`./gradlew bundleRelease` **fails at configuration time** unless signing is configured —
deliberately, because Gradle will otherwise produce an *unsigned* release bundle that Play
only rejects at the end of the upload, far from the cause. To build one locally:

```bash
export ANDROID_KEYSTORE_PATH=/path/to/upload.jks
export ANDROID_KEYSTORE_PASSWORD=… ANDROID_KEY_ALIAS=… ANDROID_KEY_PASSWORD=…
cd android && ./gradlew bundleRelease
```

For a sideload build, use `./gradlew assembleDebug` — it needs no keystore.

## On-device live reload

Run the web dev server (`yarn workspace @ci/fe-web dev`, bound to `0.0.0.0`), then:

```bash
CAP_SERVER_URL=http://<lan-or-tailscale-ip>:5173 yarn run:ios   # or run:android
```

Point the in-app `/server` setting at your API origin so data calls resolve. Unset
`CAP_SERVER_URL` for a bundled build.

## App icons & splash

Source artwork lives in `assets/` (committed); platform icons + splash are generated
into `ios/` and `android/` with
[`@capacitor/assets`](https://github.com/ionic-team/capacitor-assets):

```bash
cd frontend/apps/mobile
# assets/ holds: icon-only.png, icon-foreground.png, icon-background.png (1024²)
#                splash.png, splash-dark.png (2732²)
npx @capacitor/assets generate \
  --iconBackgroundColor '#ffffff' --iconBackgroundColorDark '#0b1418' \
  --splashBackgroundColor '#ffffff' --splashBackgroundColorDark '#0b1418'
```

The current icon is the CI globe mark (rendered from
`frontend/apps/web/public/logo.svg` at 1024px). Re-run after changing the artwork,
then rebuild. (Note: `icon-only.png` is required for the flat iOS/legacy icon; without
it the iOS icon falls back to the tool's placeholder.)

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

Android (Capacitor 7 defaults: compileSdk 35, AGP 8.7.2, JDK 21) builds cleanly with
no source changes — it only needs the `platforms;android-35` SDK component installed.

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
  `NSPhotoLibraryAddUsageDescription`.
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

## Not yet wired (later phases)

- **Local-first sync (PowerSync client)** — the on-device SQLite layer. The server
  scaffold + `GET /api/powersync/token` already exist (see `infrastructure/powersync/`).
- **Push notifications** — needs backend APNs/FCM infrastructure + a device-token
  registration endpoint. Local notifications work today; remote push is deferred.
</content>

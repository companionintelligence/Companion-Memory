# @ci/fe-android — Native Android shell (Capacitor)

A thin native **Android** shell that wraps the existing **`@ci/fe-web`** React/Vite build and
points it at a remote, self-hosted **CI-Server**. iOS lives in
[`frontend/apps/ios`](../ios) as its own package — do not merge them.

On first launch with no server set, the app routes to **`/device-connect`** (Portal
sign-in → pick a Memory Server). `/server` is the Advanced URL fallback. `/connect`
is Sources (OAuth accounts) and must not be reused.

The rest of this file is the Android runbook. iOS is a separate package and must
stay that way.

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

- **Android Studio** (bundles a JDK + SDK), or a standalone **JDK 21** +
  Android SDK with `platform-tools`, `platforms;android-36`, `build-tools;36.0.0`.
  Play requires target API 36. The project compiles with compileSdk 36, AGP 8.10.0,
  JDK 21 — install `platforms;android-36` before building.
- Backend CORS already allows the native origins (`backend/apps/api/src/main.ts`:
  `capacitor://localhost`, `http(s)://localhost`, plus the `X-API-Key` header);
  operators can extend it with `CORS_ALLOWED_ORIGINS`.

## First-time setup

```bash
# 1) Install this project's deps (isolated from root PnP):
cd frontend/apps/android && yarn install

# 2) Build the web bundle (from repo root, PWA disabled):
VITE_DISABLE_PWA=true yarn workspace @ci/fe-web build

# The android/ project is committed. Only on a checkout that lacks it:
#   npx cap add android
yarn sync          # copies web assets + installs native plugin code
```

`yarn build` (= `build:web` + `cap sync`) rebuilds + syncs from this directory.
iOS is a separate package — build it from [`frontend/apps/ios`](../ios).

## Run in an emulator

Android Studio's bundled JBR is a convenient JDK 21:

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
VITE_DISABLE_PWA=true yarn workspace @ci/fe-web build
cd frontend/apps/android
echo "sdk.dir=$ANDROID_HOME" > android/local.properties
yarn cap sync android
(cd android && ./gradlew assembleDebug)
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.ci.memory/com.companionintelligence.app.MainActivity
```

(Debug builds need no release keystore. List AVDs with `emulator -list-avds`.)

## Tests

Two kinds, and the difference is whether a device is involved.

### Unit tests (JVM — no emulator, no device)

**100 tests across four modules**, run from the repo root:

```bash
make test-android
```

That checks the prerequisites first (JDK 21; an Android SDK with
`platforms;android-36`, found through `ANDROID_HOME`, then `ANDROID_SDK_ROOT`, then
`android/local.properties`'s `sdk.dir`; and this project's own `yarn install`, which is
what materializes the `portal:` symlinks the three plugin modules reach the build
through) and then runs, from `frontend/apps/android/android`:

```bash
./gradlew testDebugUnitTest
```

No module prefix, so every module with a unit-test source set is picked up — a new
plugin package needs no edit anywhere.

| Module | Source set | Tests |
|---|---|---|
| `:app` | `app/src/test/java/com/companionintelligence/app` | 14 |
| `:ci-capacitor-local-hub` | [`frontend/packages/capacitor-local-hub/android/src/test`](../../packages/capacitor-local-hub/android/src/test) | 35 |
| `:ci-capacitor-local-llm` | [`frontend/packages/capacitor-local-llm/android/src/test`](../../packages/capacitor-local-llm/android/src/test) | 35 |
| `:ci-capacitor-speech` | [`frontend/packages/capacitor-speech/android/src/test`](../../packages/capacitor-speech/android/src/test) | 16 |

Reports land in each module's `build/reports/tests/testDebugUnitTest/index.html`.
Pass extra Gradle flags through the make target, e.g.
`make test-android GRADLE_ARGS="--rerun"` to defeat Gradle's up-to-date check, or run
a single module directly:

```bash
cd frontend/apps/android/android
./gradlew :ci-capacitor-speech:testDebugUnitTest --tests '*SpeechRecognitionLogicTest*'
```

Several of these tests read files from **outside** the Gradle build — `definitions.ts`
in the plugin packages, the iOS `Info.plist`, the backend's `config/default.json` — to
pin declarations that span the two sides of a boundary. Those files are declared as
task `inputs` in the relevant `build.gradle` so an edit on the far side actually
re-runs the check; without that, Gradle would report the task UP-TO-DATE through
exactly the change the test exists to catch.

### Instrumented tests (need a booted device)

`src/androidTest` in `capacitor-local-hub` and `capacitor-speech` — real sockets, a real
SQLCipher database, the real AndroidKeyStore, the real speech framework. They are in
**neither** `make test-android` nor CI, because both would need an emulator. Run them
by hand against a booted device:

```bash
cd frontend/apps/android/android
./gradlew connectedDebugAndroidTest                                  # everything
./gradlew :ci-capacitor-local-hub:connectedDebugAndroidTest          # one module
```

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

The **Android** job adds one step the iOS job has no equivalent for: right after
`assembleDebug` it runs `./gradlew testDebugUnitTest --continue`, the same 100 JVM
tests as `make test-android`. It is nearly free — the JDK, the SDK and the Gradle
cache are already warm from the build above — and on a red run it uploads the HTML
and XML reports from all four modules as **`android-unit-test-reports`**. On a green
run it uploads nothing, because the log already says everything the reports would.

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
# Rehearsal: build + sign + validate, submit nothing. Dispatch on a BRANCH.
gh workflow run mobile-release.yml --ref main -f dry_run=true -f platform=android

# The real thing — tag the commit you want, then push the tag.
git tag -a android-v1.0.0 -m "Android 1.0.0"
git push origin android-v1.0.0
```

Tag prefixes pick the lane: `ios-v*` (TestFlight), `android-v*` (Play internal),
`mobile-release-v*` (both). A tag **push** always submits. A manual dispatch
honours `dry_run` even if `--ref` points at a tag.

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
the marketing version comes from the `version_name` dispatch input, falling back to a
`mobile-release-v*` tag ref and then to `0.1.0`; the build number comes from
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
CAP_SERVER_URL=http://<lan-or-tailscale-ip>:5173 yarn run   # = cap run android
```

Point the in-app `/server` setting at your API origin so data calls resolve. Unset
`CAP_SERVER_URL` for a bundled build.

## App icons & splash

Source artwork lives in `assets/` (committed); platform icons + splash are generated
into `android/` with
[`@capacitor/assets`](https://github.com/ionic-team/capacitor-assets):

```bash
cd frontend/apps/android
# assets/ holds: icon-only.png, icon-foreground.png, icon-background.png (1024²).
# icon-only/-foreground are verified copies of @companionintelligence/assets logos/app-icon-source.png
# (logo.app-icon) — regenerate them with `yarn workspace @ci/fe-web brand:sync`, never hand-edit.
#                splash.png, splash-dark.png (2732²)
npx @capacitor/assets generate \
  --iconBackgroundColor '#ffffff' --iconBackgroundColorDark '#0b1418' \
  --splashBackgroundColor '#ffffff' --splashBackgroundColorDark '#0b1418'
```

The current icon is the CI globe mark (rendered from
`frontend/apps/web/public/logo.svg` at 1024px). Re-run after changing the artwork,
then rebuild. (`assets/` is shared in shape with the iOS package but generated
separately; `icon-only.png` is what the iOS side needs, so keep it present.)

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
session. Keep the scheme in sync across the `AndroidManifest.xml` intent-filter
(documented in `capacitor.config.ts`), the iOS package's `Info.plist`
(`CFBundleURLTypes`), `@ci/common`'s `OIDC_NATIVE_SCHEME`, and
`auth.oidc.nativeRedirectScheme`.

## Native capabilities & permissions

**Camera + microphone (capture).** The existing in-webview capture (`@ci/capture`,
`navigator.mediaDevices.getUserMedia`) works natively once the OS permissions are
declared — the webview's permission request maps to the OS prompt on first use. Wired in
`AndroidManifest.xml`: `CAMERA`, `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`
(+ `<uses-feature camera required="false">`).

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

**Apple App Intents** are iOS-only and live in the iOS package — see
[`frontend/apps/ios/README.md`](../ios/README.md#native-capabilities--permissions).
Android has no equivalent wired today.

**On-device chat completion (LocalLLM, early preview).** The `@ci/capacitor-local-llm`
Kotlin plugin (`frontend/packages/capacitor-local-llm/android/`) starts a loopback-only
HTTP server (`127.0.0.1`, random port, per-launch bearer token) exposing an OpenAI-compatible
`POST /v1/chat/completions` (SSE) backed by [LiteRT-LM](https://github.com/google-ai-edge/LiteRT-LM)
running fully on-device — no appliance connection needed. JS reaches it via
`@ci/common`'s `startLocalLlm`/`loadLocalLlmModel`/etc. (`nativeBridge.ts`) plus a direct
SSE client (`localLlm.ts`); try it from Settings → On-device model. This is a skeleton,
not the full offline-mode design: no model download UI wired to a real source yet (push
a `.litertlm` file onto the device and paste its path), no capability gating, no
integration with the appliance-routed chat page.

- minSdk stays 23; the plugin itself gates on `Build.VERSION.SDK_INT >= 31`
  (LiteRT-LM's AAR requires Android 12), so older devices keep the rest of the app.
- The package declares itself **Android-only** — it has no `ios/` folder and does not
  appear in the iOS Podfile. iOS ships its own in-app Swift implementation instead
  (a different model, too); see the iOS README.
- The emulator does not reliably run LiteRT-LM inference (untested; the iOS Simulator
  has a confirmed upstream issue) — test on a real device.

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

- **FCM keys on the appliance** — the app registers a device push token with
  `POST /api/devices`. Delivery goes through Portal (`PORTAL_PUSH_RELAY_URL`), not a
  LAN box holding the app's push key. Until that relay is populated, local
  notifications still work.
- **iOS Screen Time** is not an Android problem; do not port a Screen Time ingest.
  Android `PACKAGE_USAGE_STATS` is a later, Android-only feature.
- **Contacts and Health Connect** — gated by DEVICE_DATA_COMPLIANCE. Picker-first
  photos ship; full-library access, contacts, and health do not.

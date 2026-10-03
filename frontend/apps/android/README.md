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
  (same-origin), the configured origin on native. That covers every `fetch`, XHR,
  `src`, `href` and `window.open`, not just GraphQL: the page origin is
  `https://localhost`, so a bare `/api/...` or `/static/...` there is a request to
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
| Qwen3 0.6B | 328 MB | 4 GB | CPU | ✓ | | ✓ | iOS, Android |
| Qwen2.5 1.5B Instruct | 1.5 GB | 6 GB | GPU, CPU | | | | iOS, Android |
| Gemma 4 E2B | 2.4 GB | 8 GB | GPU, CPU | ✓ | ✓ | ✓ | Android |
| Gemma 4 E4B | 3.4 GB | 12 GB | GPU, CPU | ✓ | ✓ | ✓ | Android |

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

**Known limits (measured on LiteRT-LM 0.14.0 with the Android emulator).**

- A cancelled conversation cannot be reused, so after **Stop** — or a failed turn — the next message starts a
  fresh conversation and the model forgets earlier turns, even though the chat still shows them. Replaying
  history through `initialMessages` is the follow-up.
- Gemma 4 fixes thinking on or off at the first turn of a conversation, so toggling "Think before answering"
  mid-chat also starts a fresh conversation.
- A GPU backend can pass `initialize()` and fail only on its first token ("Can not find OpenCL library"), so a
  GPU load probes one token and falls back to the CPU itself (`fellBackToCpu`). The plugin manifest declares
  `libOpenCL.so` / `libvndksupport.so` (`required=false`), which Android 12+ needs before an app targeting API 31+
  may open the vendor OpenCL library; that effect needs a real GPU device to confirm.
- The catalog is pinned to revisions that load on 0.14.0. Qwen3's `main` needs 0.17.1+, so bump LiteRT-LM on both
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
photo input on Gemma 4, whether the tool-result budget leaves a small model room to answer, and memory headroom
(iOS `physicalMemory` reports below the marketing figure — a
"6 GB" iPhone reports ~5.6 GB and will not be offered Qwen2.5). **Not built** from Gallery: Prompt Lab,
Agent Skills, Mobile Actions (FunctionGemma), audio input, the benchmark screen, importing a model file,
and NPU backends.

- minSdk stays 23; the plugin itself gates on `Build.VERSION.SDK_INT >= 31`
  (LiteRT-LM's AAR requires Android 12), so older devices keep the rest of the app.
- The package declares itself **Android-only** — it has no `ios/` folder and does not
  appear in the iOS Podfile. iOS ships its own in-app Swift implementation of the same
  JS contract; see the iOS README.
- An arm64 API 34 emulator (8 GB RAM) **does** run LiteRT-LM on the CPU — that is how the catalog revisions
  were checked — but it has no GPU/OpenCL and its speeds mean nothing. The iOS Simulator has a confirmed
  upstream issue. Test GPU, speed and memory on a real device.

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

**A tool's result is bounded before the model sees it.** The appliance answers a tool call with the whole result,
pretty-printed — 25 hits from `knowledge_search` is ~45 KB — and a small model's context window cannot take that in:
Qwen3-0.6B's is 1,024 tokens, and its system prompt and tool declarations already use ~500 of them. So `IntentTool`
passes every successful result through `ToolResultShaper` before it goes back to LiteRT-LM, with a budget of
`LocalLlmPolicy.toolResultByteBudget(maxTokens)` — half the window in bytes, never under 256 or over 16,384 (512 for
Qwen3-0.6B, 2,000 for Gemma 4) — which `loadModel` works out from the window it just configured. A result that fits
goes through byte for byte. Otherwise JSON is pruned and re-emitted compactly: unset columns (`null`, `false`, `""`,
`[]`, `{}`) and foreign-key UUIDs are dropped, since a hit is mostly those; each object is written answer-first (`type`
/ `link` / `title`, then when, then what it says, the rest, bookkeeping last) and loses its last members first; strings
are capped; and every list — the `items` of a search, the `nodes` and `edges` of `memory_recall` — gets an equal share
of what the object's other members leave, in which the first three hits share the room and a closing note says how
many were left out. Anything that is not JSON is cut at the budget and ends `…[truncated]`, and so is JSON whose
budget is too small for that (under about 800 bytes: at Qwen3-0.6B's 512 the synthetic dentist and graph results end
that way). A refusal or a failed call is a sentence and is not shaped; an error response's body is cut to its first 200
characters before it becomes one. This is a port of iOS's `ToolResultShaper` (`LocalLLMPolicy.swift`, which is in turn
the device twin of the appliance's `toolResultBudget.ts`) and is written to give the same text for the same input:
`SwiftParityTest` checks it against answers the Swift shaper gave for ~360 inputs, and fails when the Swift
shaper's code is no longer the one those answers were recorded from; after a change to either side,
`frontend/packages/capacitor-local-llm/android/scripts/regenerate-swift-parity.sh` (it needs `swiftc`) records them
again. `IntentTool` logs sizes only (`knowledge_search returned 45598 bytes; passing 482 to the model
(budget 512)`), never the result. The budget is an estimate no device run has measured; `toolResultByteBudget` is the one
place to tune it, on both platforms.

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

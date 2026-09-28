# Companion Memory Desktop (macOS / Windows / Linux)

A native desktop app (Tauri) that brings up CI-Server's own Docker Compose
stack **locally** and shows it — a local orchestrator, not a thin client.

This is architecturally different from [`frontend/apps/ios`](../ios) and
[`frontend/apps/android`](../android): those wrap the built web app and point
it at a **remote**, already-running CI-Server appliance. This app manages its
**own local** backend: it starts CI-Server's containers on your machine, waits
for them to become healthy, then shows the real web UI.

## How it works

1. On launch, the app copies its bundled compose files
   (`docker-compose.yml`, `docker-compose.production.yml`, and a desktop-only
   overlay, `docker-compose.desktop.yml`) into an OS-appropriate app-data
   directory, and writes a `.env` alongside them (no secrets — see below).
2. It runs `docker compose --profile production up -d` against those files.
3. A splash page (`bootstrap/`) polls a Rust-backed health check
   (`gateway`'s `/api/health`, which proxies to `api`'s own health endpoint)
   every second.
4. Once healthy, the window navigates (`window.location.replace()`) to
   `http://127.0.0.1:8642/` — from that point on it's the real CI-Server web
   app, served by the `gateway` container, on a normal same-origin browser
   session (standard cookie auth — no CORS/CSRF wiring needed for this app).
5. A tray icon lets you show/hide the window, manually start/stop the stack,
   and view the desktop log, without quitting.

Images are pulled from `ghcr.io/companionintelligence/companion/*` (see
`../../../scripts/publish/images.sh`) at a version tag resolved at build time
by `scripts/sync-compose-resources.cjs` — **never `:latest`** (a stale
`companion/*:latest` tag orphaned once before; see that script's comments).

**No secrets are generated or touched by this app.** `generate-secrets`
(`ci/setup-secrets` → `companion/setup-secrets`) creates every auth/DB secret
into a Docker-managed volume on first boot, exactly as it does for
`make production` — see `../../../infrastructure/setup-secrets/entrypoint.sh`.

## Setup

Prerequisites:

- [Rust](https://rustup.rs) (stable)
- [Docker](https://www.docker.com/products/docker-desktop/) (Compose CLI ≥
  2.24 — see the note on `!reset` below)
- Platform Tauri build dependencies:
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Linux** (Ubuntu/Debian): `build-essential pkg-config curl wget file
    libssl-dev libwebkit2gtk-4.1-dev libgtk-3-dev
    libayatana-appindicator3-dev librsvg2-dev patchelf`, plus `rpm` and
    `libfuse2`/`xdg-utils` if you also want to build/run an AppImage locally
  - **Windows**: WebView2 Runtime (preinstalled on modern Windows), Visual
    Studio Build Tools ("Desktop development with C++")

```bash
cd frontend/apps/desktop
yarn install    # installs @tauri-apps/cli only — this is a standalone project,
                # not part of the root Yarn workspace; see .yarnrc.yml
```

## Run in development

```bash
yarn dev
```

This syncs the compose resources (`scripts/sync-compose-resources.cjs`) —
which resolves `CI_SERVER_IMAGE_TAG` from your current git checkout the same
way `scripts/publish/publish.sh` does — then runs `cargo tauri dev`. That
resolved tag must actually exist under
`ghcr.io/companionintelligence/companion/*`; if you're not on a published
release tag, export one explicitly:

```bash
CI_SERVER_IMAGE_TAG=<a tag publish.yml has pushed> yarn dev
```

The bundled `docker-compose.yml` / `docker-compose.production.yml` come from
that same release (`git show v<tag>:…`), **not your working tree**, unless HEAD
is that release or the script fell back to `dev-<sha>`: a compose change can
depend on images only a newer release has, so compose and images are always
taken from one release. The sync log says which (`synced … from v<tag>`).

Docker must be running (`docker info` should succeed) before launch.

## Build

```bash
yarn build
```

Produces the platform's native bundle(s) via `cargo tauri build` (dmg/app on
macOS, msi/nsis on Windows, deb/rpm on Linux locally — AppImage is added only
in CI where `linuxdeploy` is installed, via `-b deb,rpm,appimage`).

## Icon

`src-tauri/icons/app-icon-source.png` is the Companion Memory logo from
`CI-Marketplace/apps/ci-memory/metadata/logo.png` (2048×2048). Every other
file in `src-tauri/icons/` is generated from it via `yarn icons` (`tauri icon`)
— re-run that after replacing the source, don't hand-edit the generated sizes.

## Local model (chat + embeddings) without a separate Ollama install

CI-Server's `api` service already treats its chat backend as swappable
(`LLM_API_BASE`/`LLM_API_KEY` override the default `OLLAMA_HOST` fallback —
see `backend/apps/api/src/domains/llm/services/LlmEndpointService.ts`). This
app uses that same mechanism so a first-time user doesn't have to separately
install Ollama and pull a large model just to get chat + RAG embeddings
working. Resolved once per launch, cheapest option first:

1. **You already run Ollama** (something answers `127.0.0.1:11434`) — used
   as-is, unchanged. Nothing else in this list applies.
2. **Apple on-device (macOS only)** — if Apple Intelligence is available
   (Apple Silicon, macOS 26+, enabled in System Settings), chat is served by
   Apple's on-device `FoundationModels` framework via a small bundled Swift
   CLI (`apple-bridge/`, compiled by `build.rs`), reached through a tiny local
   HTTP shim (`src-tauri/src/local_model/apple_bridge.rs`) that speaks just
   enough of the OpenAI chat-completions protocol for `OpenAiCompatChatDriver`
   to work against it. FoundationModels has no embeddings API, so embeddings
   still come from option 3 below in this configuration — just a much smaller
   download, since no chat-model weights are needed.
3. **Bundled Ollama** — otherwise, this app finds (`ollama` already on PATH)
   or downloads (Ollama's own official release archive, checksum-verified,
   into this app's data directory) a copy of Ollama, runs it on port 11434,
   and pulls two ungated models: `gemma4:e4b` for chat (skipped in
   configuration 2) and `nomic-embed-text` for embeddings. The chat tag must
   equal `DEFAULT_CHAT_MODEL` in `backend/apps/api/src/configuration.ts`, which
   is the source of truth — the sidecar also writes it into the generated
   `.env` as `LLM_DEFAULT_CHAT_MODEL` so the API cannot ask for a model that
   was never pulled. It is the efficient `e4b` tier, not a 1B model: a tag too
   small to hold a JSON schema silently disables the schema-bound features
   (titles, task breakdown, summaries), which is why the earlier `gemma3:1b`
   default was retired.

   The sidecar binds **`127.0.0.1` on every platform**. On macOS and Windows
   that is all it needs: Docker Desktop's VM tunnels `host.docker.internal`
   back to the host's loopback.

   On **Linux** the containers reach the host through
   `host.docker.internal:host-gateway`, which on native Docker Engine is the
   docker bridge gateway rather than the host's loopback — so loopback alone
   would leave `api`/`hbpe-service` unable to call the model while the stack
   still reported healthy. `local_model::bridge_relay` closes that gap: it
   discovers the bridge gateway from the daemon (`docker network inspect
   bridge`) and runs a plain TCP relay bound to **that one address**, forwarding
   to the loopback sidecar.

   This replaced a `0.0.0.0` bind, which was too wide for a reason worth
   recording: Ollama has no server-side authentication on any route, and
   binding non-loopback additionally disables its own host-header guard. Any
   LAN peer could run inference on your GPU and — more seriously — delete and
   recreate models, which the API's "use whatever model is served" fallback
   turns into a persistent model-substitution foothold. A single-address bind
   means the kernel drops anything arriving on the machine's real NICs.

   > **Under rootless Docker** no bridge gateway is discoverable (the
   > `host-gateway` alias resolves inside RootlessKit's namespace, moby#47684).
   > The relay is then simply not started and the sidecar stays loopback-only —
   > which is also the arrangement most likely to work there, since slirp4netns
   > forwards from the host's own namespace. It is not silent: `desktop.log`
   > carries a warning naming `docker network inspect bridge`. If the appliance
   > reports model errors on a rootless host, that line is the place to start.

See `src-tauri/src/local_model/mod.rs` for the exact resolution logic and
`ollama_sidecar.rs`/`apple_bridge.rs` for each backend. Known v1 limitations:

- **No tool-calling** on either the Apple bridge or the bundled-Ollama path —
  CI-Server's Intent Catalog tool loop just never sees a `tool_calls` field,
  so it degrades to "answered without calling a tool" the same way any model
  handed tools it can't invoke would.
- The Apple bridge assembles a full SSE response before sending it, rather
  than delivering it token-by-token over the wire — a real but currently
  accepted latency-vs-complexity tradeoff (see that file's module doc
  comment).
- Building the Apple bridge needs **Xcode 26+ with the macOS 26 SDK**
  specifically (`FoundationModels` isn't in older SDKs) — `build.rs` degrades
  to a warning, not a build failure, on anything older, and the app falls
  back to bundled Ollama.
- Windows/Linux installer size grows meaningfully (~1.3–1.5GB) the first time
  the bundled-Ollama fallback actually downloads its own copy, since Ollama's
  official release archives for those platforms bundle CUDA/ROCm; macOS's is
  much smaller (~150MB) since Metal is part of the OS. This only happens for
  users who reach configuration 3 above — most won't.

## "Sign in with CI-Portal"

Works out of the box against production Portal (`https://hub.ci.computer`).
Set `CI_PORTAL_URL` before `yarn dev` / launching the packaged app to point at
a different Portal instead (e.g. `https://hub.companionintelligence.com`, the
dev environment) — `stack_manager.rs` writes it into the generated `.env` as
`OIDC_ISSUER_URL`.

This needed two things neither `docker-compose.yml` nor
`docker-compose.production.yml` set on their own, both added to
`docker-compose.desktop.yml`'s `api` service:

- `OIDC_ISSUER_URL` — unset (the default everywhere else), the "Sign in"
  button redirects nowhere and just fails.
- `APP_BASE_URL` — unset, CI-Server derives the OIDC callback URL from the
  inbound request's `Host` header, but `gateway`'s nginx config forwards
  `Host: $host`, and nginx's `$host` strips the port. That would compute
  `http://127.0.0.1` (port 80, nothing listening) instead of
  `http://127.0.0.1:8642`, and the callback would never arrive. Setting
  `APP_BASE_URL` explicitly skips that derivation.

## A note on the `!reset` compose tag

`docker-compose.desktop.yml` uses the Compose Specification's `!reset` tag to
clear `hbpe-service`'s ROCm device passthrough (`devices`, `group_add`) that
`docker-compose.production.yml` unconditionally adds — Compose merges
list-valued keys across `-f` files by *concatenation*, so a plain override
can't remove them, and without `!reset` the stack would hard-fail
(`docker compose up`) on any machine that isn't an AMD ROCm box. This needs
Docker Compose CLI ≥ 2.24. If `docker compose up` fails with a parse error on
`!reset`, upgrade Docker/Compose.

## Deferred for v1

The following exist in CI-Hub's own Tauri desktop app
(`CI-Hub/packages/desktop`) but are deliberately **not** implemented here yet.
Not silently missing — just out of scope for this first pass:

- Docker / GPU-driver **auto-installers** — this app detects Docker's absence
  and links to the download page; it doesn't install Docker or GPU drivers
  for you. (Ollama itself is handled — see "Local model" above — but that's a
  narrower, self-contained download scoped to this app, not a system-wide
  Ollama install the way Docker Desktop would be.)
- GPU host-hardware auto-detection or Docker Desktop VM resource tuning.
- GPU-variant (CUDA/ROCm) image selection — always pulls the CPU-built
  `hbpe-service` image, with GPU device passthrough explicitly disabled (see
  above).
- A custom self-updater / in-app auto-update. Reinstall from a new release to
  upgrade.
- A watchdog that auto-restarts a crashed stack — the tray shows live status
  and offers manual Start/Stop only.
- mDNS discovery of other appliances on the LAN (not applicable — this app
  only ever manages its own local stack).
- A deep-link URL scheme / pairing flow (not applicable, for the same reason).
- Sentry crash reporting for the desktop shell itself.
- ARM Linux and Windows-ARM build legs (`desktop-build.yml`/
  `desktop-release.yml` currently build x86_64 Linux/Windows and both macOS
  architectures only).
- Persisted window geometry across relaunches.

## CI

- **`desktop-build.yml`** — `workflow_dispatch` only, unsigned. Produces
  downloadable dmg/deb/rpm/appimage/msi artifacts for verification.
- **`desktop-release.yml`** — tag-triggered (`desktop-v*`) + dispatch, signed.
  The macOS and Windows lanes **skip (not fail)** until Apple/Windows signing
  secrets are provisioned — see that workflow's header comment for the exact
  secret names needed. The Linux lane always runs unsigned (no signing
  convention exists for `.deb`/`.rpm` in this repo).

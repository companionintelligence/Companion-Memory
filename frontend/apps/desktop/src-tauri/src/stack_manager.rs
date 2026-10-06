//! Orchestrates CI-Server's own Docker Compose stack locally. This binary
//! runs natively on the host (not inside a container), so — unlike a backend
//! that must reach the host's docker.sock from inside its own container —
//! it just shells out to the `docker` CLI directly. No secret material is
//! ever generated or touched here: `generate-secrets` (image
//! `ci/setup-secrets` / `companion/setup-secrets`) creates every auth/DB
//! secret into a shared Docker volume on first boot, exactly as it does for
//! `make production` — see infrastructure/setup-secrets/entrypoint.sh at the
//! repo root.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;

/// What the splash is allowed to say about a start that is still running.
///
/// The whole cold start used to happen inside one awaited IPC call, so the page
/// could show exactly one sentence for the entire multi-gigabyte download and
/// then, if it failed, one generic sentence about it having taken too long. The
/// reason was always known — an unpullable tag, a full disk, a busy port — and
/// always discarded. This is the channel that carries it out.
#[derive(Clone, Debug, Default, Serialize)]
pub struct StartupProgress {
    /// Coarse machine-readable stage: `preflight` | `pulling` | `starting` | `ready` | `failed`.
    pub phase: String,
    /// One human-readable line — the compose step, or the failure.
    pub detail: String,
    /// Set only when the start actually failed; the message the user sees.
    pub error: Option<String>,
    /// True once a start has completed successfully at least once.
    pub done: bool,
}

pub type ProgressHandle = Arc<Mutex<StartupProgress>>;

pub fn new_progress() -> ProgressHandle {
    Arc::new(Mutex::new(StartupProgress {
        phase: "preflight".to_string(),
        detail: "Checking your machine…".to_string(),
        ..Default::default()
    }))
}

fn set_progress(progress: &ProgressHandle, phase: &str, detail: impl Into<String>) {
    if let Ok(mut guard) = progress.lock() {
        guard.phase = phase.to_string();
        guard.detail = detail.into();
        guard.error = None;
    }
}

fn fail_progress(progress: &ProgressHandle, message: impl Into<String>) {
    if let Ok(mut guard) = progress.lock() {
        let message = message.into();
        guard.phase = "failed".to_string();
        guard.detail = message.clone();
        guard.error = Some(message);
    }
}

/// Turn one line of `docker compose up` output into something worth showing.
///
/// Compose narrates itself in a shape that is almost right for a status line
/// already ("Pulling api", "api Pulled") — the job here is to keep the lines
/// that mark real progress and drop the per-layer noise, which changes many
/// times a second and reads as flicker rather than information.
fn describe_compose_line(line: &str) -> Option<String> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }

    let service_step = |verb: &str| {
        line.strip_suffix(verb)
            .map(|name| format!("{verb} {}", name.trim()))
    };

    if let Some(step) = service_step("Pulled") {
        return Some(step.replace("Pulled ", "Downloaded "));
    }
    if let Some(step) = service_step("Created").or_else(|| service_step("Started")) {
        return Some(step);
    }
    if let Some(name) = line.strip_prefix("Pulling ") {
        return Some(format!("Downloading {}…", name.trim()));
    }
    if line.contains("Waiting") && line.contains("healthy") {
        return Some("Waiting for services to become healthy…".to_string());
    }

    None
}

/// The only port CI-Server's production compose stack publishes to the host
/// (`gateway`, which serves the built web app and proxies `/api/*` — see
/// infrastructure/gateway/nginx.conf). Fixed rather than dynamically
/// reassigned: it's a deliberately unusual port with low collision risk, and
/// a moving target would complicate both the bootstrap page and the compose
/// overlay's `ports:` handling for little real benefit.
pub const GATEWAY_PORT: u16 = 8642;

pub(crate) const PROJECT_NAME: &str = "ci-server-desktop";

/// CI-Portal's production origin — the sensible default for "Sign in with
/// CI-Portal" (see write_env_file). Override with the CI_PORTAL_URL env var
/// (e.g. to `https://hub.companionintelligence.com`, the dev environment) for
/// testing against a non-production Portal.
const DEFAULT_PORTAL_URL: &str = "https://hub.ci.computer";

const COMPOSE_FILES: [&str; 3] = [
    "docker-compose.yml",
    "docker-compose.production.yml",
    "docker-compose.desktop.yml",
];
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StackStatus {
    DockerNotInstalled,
    DockerNotRunning,
    Stopped,
    Starting,
    Running,
}

#[derive(Debug, Clone)]
pub struct StackPaths {
    pub data_dir: PathBuf,
    pub compose_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub import_work_dir: PathBuf,
}

/// Creates the app-data directory layout, copies the bundled compose
/// resources into it, and (re)writes `.env`. Run once at startup, and safe to
/// re-run — it always overwrites the copied compose files + `.env` with the
/// current bundle's contents, so a version upgrade picks up compose changes
/// without any manual migration step.
pub fn initialize_stack(resource_dir: &Path, data_dir: &Path) -> Result<StackPaths, String> {
    let compose_dir = data_dir.join("compose");
    let logs_dir = data_dir.join("logs");
    let import_work_dir = data_dir.join("import-work");

    for dir in [&compose_dir, &logs_dir, &import_work_dir] {
        fs::create_dir_all(dir).map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;
    }

    let bundled_resources = resource_dir.join("resources");
    for name in COMPOSE_FILES {
        let src = bundled_resources.join(name);
        let dest = compose_dir.join(name);
        fs::copy(&src, &dest)
            .map_err(|e| format!("Failed to copy bundled resource {name} ({}): {e}", src.display()))?;
    }

    let image_tag = read_bundled_image_tag(&bundled_resources)?;
    write_env_file(&compose_dir.join(".env"), &image_tag, &import_work_dir)?;

    Ok(StackPaths {
        data_dir: data_dir.to_path_buf(),
        compose_dir,
        logs_dir,
        import_work_dir,
    })
}

/// The bundled server image tag, for callers outside this module — the
/// shell needs it to notice an upgrade (see `record_image_tag`).
pub fn bundled_image_tag(resource_dir: &Path) -> Result<String, String> {
    read_bundled_image_tag(&resource_dir.join("resources"))
}

/// What the last launch of this app pointed the webview at, and whether it
/// has moved. Compared against a marker file, never against `.env` — `.env` is
/// rewritten on every launch, so by the time anyone could read it the previous
/// tag is already gone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageTagChange {
    /// The tag the marker held before this call; None on a first launch, and
    /// on the first launch of a shell version that writes the marker at all.
    pub previous: Option<String>,
    /// True whenever the webview's cached frontend can no longer be trusted:
    /// a different tag, or no record of one.
    pub changed: bool,
}

const IMAGE_TAG_MARKER: &str = "webview-image-tag";

/// Says whether the image tag this launch runs differs from the one the
/// webview was last cleared for. Read-only: `mark_image_tag_seen` advances the
/// marker, and only the caller knows whether the clear that justifies
/// advancing it actually happened.
///
/// The web app registers a service worker that precaches its whole bundle,
/// and the webview keeps that worker across launches. So when the shell
/// pulled newer server images, the page it navigated to was served from the
/// OLD worker's cache — last release's frontend against this release's API —
/// and nothing on screen said so: the observed failure was a blank window
/// with not a single asset request reaching the gateway. In a browser the
/// worker would eventually update itself; here it never got the chance,
/// because the stale bundle broke before the registration code ran.
///
/// A missing marker counts as changed on purpose. Every install that predates
/// this marker is sitting on exactly that stale worker, and the one launch
/// that costs — a cleared session, a fresh sign-in — is the launch that fixes
/// it.
pub fn image_tag_change(data_dir: &Path, image_tag: &str) -> ImageTagChange {
    let marker = data_dir.join(IMAGE_TAG_MARKER);
    let previous = fs::read_to_string(marker).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let changed = previous.as_deref() != Some(image_tag);

    ImageTagChange { previous, changed }
}

/// Records that the webview has been cleared for this tag. Called only after
/// a clear that succeeded: a marker written before the clear would have
/// turned one failed clear into a permanently stale worker, since the next
/// launch would see nothing to do.
pub fn mark_image_tag_seen(data_dir: &Path, image_tag: &str) -> Result<(), String> {
    let marker = data_dir.join(IMAGE_TAG_MARKER);

    fs::write(&marker, format!("{image_tag}\n")).map_err(|e| format!("Failed to write {}: {e}", marker.display()))
}

/// The build-time-resolved default image tag, written by
/// scripts/sync-compose-resources.cjs (see that file for the resolution
/// algorithm — it mirrors scripts/publish/publish.sh's own VERSION logic and
/// deliberately never falls back to "latest"). Missing here means this
/// binary was built by invoking `cargo tauri build` directly instead of
/// going through `yarn build`/`yarn dev` — fail loudly rather than silently
/// guessing a tag.
fn read_bundled_image_tag(bundled_resources: &Path) -> Result<String, String> {
    let path = bundled_resources.join("image-tag.txt");
    let contents = fs::read_to_string(&path).map_err(|e| {
        format!(
            "Missing bundled {} ({e}). This app must be built via `yarn build` / `yarn dev` \
             (which run scripts/sync-compose-resources.cjs), not `cargo tauri build` directly.",
            path.display()
        )
    })?;
    let tag = contents.trim().to_string();
    if tag.is_empty() {
        return Err(format!("Bundled {} is empty.", path.display()));
    }
    Ok(tag)
}

fn write_env_file(env_path: &Path, image_tag: &str, import_work_dir: &Path) -> Result<(), String> {
    // No secrets here — see the module doc comment. COMPOSE_PROJECT_NAME is a
    // fixed constant, never changed across versions: it names the volumes
    // (${COMPOSE_PROJECT_NAME}-production-db-data etc.) holding the user's
    // actual data and generated secrets, so changing it would orphan them.
    // CI_IMPORT_WORK_DIR is written as an absolute path — a packaged binary
    // has no stable CWD for the compose files' own relative defaults to
    // resolve against. CI_LOCAL_ONLY=true is a privacy default appropriate
    // for a single-user local desktop app.
    //
    // OIDC_ISSUER_URL/APP_BASE_URL make "Sign in with CI-Portal" work at all
    // here — see docker-compose.desktop.yml's own comment on the `api`
    // service for exactly why both are needed (an unset issuer breaks the
    // redirect outright; an unset public base URL derives the wrong
    // redirect_uri port from gateway's forwarded, port-stripped Host header).
    // CI_PORTAL_URL is the one operator-facing override — set it before
    // `yarn dev`/launching the packaged app to point at a non-production
    // Portal (e.g. the dev environment) instead.
    //
    // LLM_DEFAULT_CHAT_MODEL pins the API's chat model
    // (backend/apps/api/config/custom-environment-variables.json maps that env
    // var to `llm.chatModel`) to the exact tag the local-model sidecar pulls,
    // so the two cannot silently disagree. They did: the sidecar's constant sat
    // at `gemma3:1b` after configuration.ts's own DEFAULT_CHAT_MODEL moved to
    // `gemma4:e4b`: every background inference path then failed with
    // OllamaService's `Invalid model specified: <id>`, per job, forever, while
    // interactive chat quietly ran the retired 1b tag instead via that
    // service's resolveServedChatModel whatever-is-served fallback.
    // configuration.ts remains the source of truth for WHICH model (see its
    // comment on the size/capability tier); this line only guarantees the
    // appliance asks for the one that is actually on disk.
    //
    // Reach, as rendered by `docker compose config` over the three bundled
    // files: this key reaches `api` (docker-compose.production.yml) and
    // `hbpe-service` (docker-compose.yml), but NOT `worker` — the worker keeps
    // riding the image's compiled-in default, so a later move of
    // configuration.ts's default that this constant does not follow would
    // still drift there. The hbpe-service copy is not inert either: once
    // LLM_API_BASE is also set (the Apple-on-device branch, appended by
    // apply_llm_env_override below), HBPE's _build_labeler stops falling back
    // to its bundled Qwen GGUF and labels through the Apple bridge instead —
    // which is single-flight (apple_bridge.rs serializes every request), so
    // label drains and interactive chat now share one queue on that branch.
    let chat_model = crate::local_model::ollama_sidecar::DEFAULT_CHAT_MODEL;
    let portal_url = std::env::var("CI_PORTAL_URL").unwrap_or_else(|_| DEFAULT_PORTAL_URL.to_string());
    let contents = format!(
        "COMPOSE_PROJECT_NAME={PROJECT_NAME}\n\
         CI_SERVER_IMAGE_TAG={image_tag}\n\
         APP_PUBLIC_HOSTNAME=127.0.0.1\n\
         CI_IMPORT_WORK_DIR={}\n\
         CI_LOCAL_ONLY=true\n\
         LLM_DEFAULT_CHAT_MODEL={chat_model}\n\
         OIDC_ISSUER_URL={portal_url}\n\
         APP_BASE_URL=http://127.0.0.1:{GATEWAY_PORT}\n",
        import_work_dir.display(),
    );
    fs::write(env_path, contents).map_err(|e| format!("Failed to write {}: {e}", env_path.display()))
}

/// Appends the LLM_API_BASE/LLM_API_KEY override
/// local_model::LocalModelHandles::resolve_once resolved (Apple-on-device-
/// for-chat only — every other outcome relies on the existing OLLAMA_HOST
/// default and calls this with an empty override, a harmless no-op).
/// Additive rather than rewriting write_env_file's own content: it never
/// writes these two keys itself, so there's no duplicate-key risk, and this
/// keeps "the no-secrets baseline env" and "the local-model resolution
/// result" as two independently reasoned-about writers. Must run before the
/// first `docker compose up` — Compose only reads `.env` when a container is
/// (re)created, not on every request. resolve_once itself only calls this
/// once (see its doc comment), so calling it twice is not a concern in
/// practice, but it would still duplicate lines if it ever were.
pub fn apply_llm_env_override(paths: &StackPaths, llm_env: &crate::local_model::LlmEnvOverride) -> Result<(), String> {
    let (Some(api_base), Some(api_key)) = (&llm_env.llm_api_base, &llm_env.llm_api_key) else {
        return Ok(());
    };
    let env_path = paths.compose_dir.join(".env");
    let addition = format!("LLM_API_BASE={api_base}\nLLM_API_KEY={api_key}\n");
    use std::io::Write;
    fs::OpenOptions::new()
        .append(true)
        .open(&env_path)
        .and_then(|mut file| file.write_all(addition.as_bytes()))
        .map_err(|e| format!("Failed to append LLM override to {}: {e}", env_path.display()))
}

/// Extra host-tool search dirs Docker Desktop/Docker Engine installers don't
/// always add to a GUI-launched app's PATH. Also reused by
/// local_model::ollama_sidecar to find a host-installed `ollama` binary,
/// since the same "GUI apps get a minimal PATH" problem applies there too.
pub(crate) fn extended_path_env() -> String {
    let existing = std::env::var("PATH").unwrap_or_default();
    let mut extra_dirs: Vec<String> = Vec::new();

    #[cfg(target_os = "macos")]
    {
        extra_dirs.push("/opt/homebrew/bin".to_string());
        extra_dirs.push("/usr/local/bin".to_string());
        extra_dirs.push("/Applications/Docker.app/Contents/Resources/bin".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(program_files) = std::env::var("ProgramFiles") {
            extra_dirs.push(format!("{program_files}\\Docker\\Docker\\resources\\bin"));
        }
    }
    #[cfg(target_os = "linux")]
    {
        extra_dirs.push("/usr/local/bin".to_string());
        extra_dirs.push("/usr/bin".to_string());
        // Docker's official rootless installer (`get.docker.com/rootless`) — the
        // only way to install Docker on Linux without root, and so the norm on
        // managed machines — puts `docker` in ~/bin, not anywhere under /usr. It
        // tells you to add that to PATH from your shell profile, which a
        // GUI-launched app never sources: the splash then says "Docker was not
        // found on this machine" on a box where Docker is installed and running.
        // Listed after the system dirs so a system-wide install still wins.
        if let Some(home) = std::env::var_os("HOME") {
            let home = std::path::Path::new(&home);
            for dir in [home.join(".local/bin"), home.join("bin")] {
                extra_dirs.push(dir.to_string_lossy().into_owned());
            }
        }
    }

    if extra_dirs.is_empty() {
        return existing;
    }
    let separator = if cfg!(target_os = "windows") { ";" } else { ":" };
    format!("{}{separator}{existing}", extra_dirs.join(separator))
}

/// The `DOCKER_HOST` this app should talk to, resolved once per launch, or
/// `None` to leave the CLI's own resolution alone.
///
/// Rootless Docker — the only way to install Docker on Linux without root, and
/// so the norm on managed machines — puts its socket at
/// `$XDG_RUNTIME_DIR/docker.sock` and tells you to export `DOCKER_HOST` at it
/// from your shell profile. A GUI launch never sources that profile, so the CLI
/// looks for the root daemon's `/var/run/docker.sock`, which a rootless install
/// doesn't have, and the splash says "Docker is installed but not running" on a
/// machine where it is both.
///
/// This probes rather than predicts. Reading `DOCKER_CONTEXT`/`currentContext`
/// to decide whether the user "already chose" a daemon looks equivalent and is
/// not: a `currentContext` left behind by an uninstalled Docker Desktop names an
/// endpoint that no longer exists, and deferring to it strands exactly the user
/// this is meant to help. So: let the CLI try first, and only step in when it
/// cannot reach a daemon on its own *and* a rootless socket answers.
#[cfg(target_os = "linux")]
fn resolved_docker_host() -> Option<&'static str> {
    static RESOLVED: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    RESOLVED
        .get_or_init(|| {
            let candidate = choose_docker_host(
                std::env::var_os("DOCKER_HOST").is_some(),
                daemon_reachable(None),
                rootless_socket_url(),
            )?;
            // Only take over when the fallback actually reaches a daemon, so a
            // wrong guess can never mask the CLI's own diagnosis.
            daemon_reachable(Some(&candidate)).then_some(candidate)
        })
        .as_deref()
}

/// The rootless daemon's conventional socket, if it is there at all.
#[cfg(target_os = "linux")]
fn rootless_socket_url() -> Option<String> {
    let socket = std::path::Path::new(&std::env::var_os("XDG_RUNTIME_DIR")?).join("docker.sock");
    socket
        .exists()
        .then(|| format!("unix://{}", socket.display()))
}

/// The decision behind [`resolved_docker_host`], split from the env, filesystem
/// and daemon probes that feed it so it is testable without mutating process env
/// vars — which races whatever else `cargo test` runs in parallel.
#[cfg(target_os = "linux")]
fn choose_docker_host(
    explicit_host: bool,
    reachable_unaided: bool,
    rootless_socket: Option<String>,
) -> Option<String> {
    if explicit_host || reachable_unaided {
        return None;
    }
    rootless_socket
}

fn daemon_reachable(host: Option<&str>) -> bool {
    docker_command_with_host(host)
        .arg("info")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn docker_command_with_host(host: Option<&str>) -> Command {
    let mut cmd = Command::new("docker");
    cmd.env("PATH", extended_path_env());
    if let Some(host) = host {
        cmd.env("DOCKER_HOST", host);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// A `docker` invocation pointed at whichever daemon this app resolved.
pub(crate) fn docker_command() -> Command {
    #[cfg(target_os = "linux")]
    let host = resolved_docker_host();
    #[cfg(not(target_os = "linux"))]
    let host = None;
    docker_command_with_host(host)
}

fn compose_command(paths: &StackPaths) -> Command {
    let mut cmd = docker_command();
    cmd.current_dir(&paths.compose_dir);
    cmd.args(["compose", "--env-file", ".env", "--project-name", PROJECT_NAME]);
    for name in COMPOSE_FILES {
        cmd.args(["-f", name]);
    }
    cmd.args(["--profile", "production"]);
    cmd
}

pub fn is_docker_installed() -> bool {
    // Deliberately unresolved: `--version` never contacts a daemon, so asking
    // which daemon to talk to first would spend two `docker info` probes to
    // answer a question about the binary.
    docker_command_with_host(None)
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn is_docker_available() -> bool {
    docker_command()
        .arg("info")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// At most one `docker compose up` for this project at a time, process-wide.
///
/// Three callers start the stack — main.rs's own startup task, the splash's
/// start_stack_command a moment later, and the tray — and nothing stood between
/// them and Compose. LocalModelHandles::resolve_once serialises only the model
/// resolution that precedes the `up`: the moment it reports Done, the caller
/// that was waiting on it runs its OWN `up` alongside the first. Two `up`s on
/// one project race for the same container names; the loser reads "name already
/// in use" as a stale-container failure and self-heals with `compose down` —
/// tearing the winner's network out from under it mid-pull — then retries,
/// loses again, and reports failure. The winner finishes anyway, which is how
/// the splash showed a container-name conflict over a stack that was healthy.
///
/// A caller that finds the lock held returns Ok without touching Compose. The
/// in-flight start owns the progress channel and the outcome, and every caller
/// already learns readiness by polling health, never from this return value.
static START_IN_FLIGHT: Mutex<()> = Mutex::new(());

/// `Some(guard)` if this caller now owns the start; `None` if another start is
/// already running and this one should stand down.
fn claim_start() -> Option<std::sync::MutexGuard<'static, ()>> {
    match START_IN_FLIGHT.try_lock() {
        Ok(guard) => Some(guard),
        // A start that panicked mid-way poisons the lock; the next start must
        // still be able to run, or the app is wedged until relaunch.
        Err(std::sync::TryLockError::Poisoned(poisoned)) => Some(poisoned.into_inner()),
        Err(std::sync::TryLockError::WouldBlock) => None,
    }
}

/// `start_stack`, reporting each step into `progress` as it goes.
///
/// Same sequence as `start_stack`; the difference is that compose's output is
/// streamed rather than buffered, so the splash can say which image is
/// downloading instead of one frozen line for the length of the pull.
pub fn start_stack_reporting(paths: &StackPaths, progress: &ProgressHandle) -> Result<(), String> {
    let Some(_in_flight) = claim_start() else {
        // Not "ready" and not an error: the other start will set both. Marking
        // ready here would flash "Ready" over a stack still pulling images.
        log::info!("start_stack: another start is already in flight; leaving it to finish");

        // One thing does need touching: a failure left over from an EARLIER
        // start. The splash treats `error` as terminal, so if a Retry stands
        // down behind a tray-driven start (which reports nothing), the old
        // message would sit on screen for the whole of a start that is in
        // fact going fine. Live progress from a reporting start is left alone.
        let stale_failure = progress.lock().map(|guard| guard.error.is_some()).unwrap_or(false);
        if stale_failure {
            set_progress(progress, "starting", "Starting Companion Memory…");
        }

        return Ok(());
    };

    let result = start_stack_inner(paths, Some(progress));

    match &result {
        Ok(()) => {
            if let Ok(mut guard) = progress.lock() {
                guard.phase = "ready".to_string();
                guard.detail = "Ready".to_string();
                guard.error = None;
                guard.done = true;
            }
        }
        Err(e) => fail_progress(progress, e.clone()),
    }

    result
}

pub fn start_stack(paths: &StackPaths) -> Result<(), String> {
    let Some(_in_flight) = claim_start() else {
        log::info!("start_stack: another start is already in flight; leaving it to finish");
        return Ok(());
    };

    start_stack_inner(paths, None)
}

fn start_stack_inner(paths: &StackPaths, progress: Option<&ProgressHandle>) -> Result<(), String> {
    if let Some(progress) = progress {
        set_progress(progress, "preflight", "Checking your machine…");
    }

    // The app's OWN gateway holds this port whenever the stack is already up,
    // and treating that as a foreign conflict made the error unrecoverable:
    // every Retry hit the same check and refused before compose could run. A
    // port held by our own running gateway is the normal case, not a problem.
    //
    // "Something answers on the port" is not that, though. This used to skip
    // the check on any TCP connect, so a port another program had taken was
    // never reported: compose then failed to start the gateway, left it
    // created, and readiness navigated the window into the other program's
    // page. Now the skip needs this project's gateway container running with
    // the port published.
    gateway_port_preflight(gateway_port_answers(), gateway_serves_port, || {
        crate::port_check::preflight_port(GATEWAY_PORT)
    })?;

    if !is_docker_installed() {
        return Err("Docker is not installed.".to_string());
    }
    if !is_docker_available() {
        return Err("Docker is installed but the daemon is not running. Start Docker and try again.".to_string());
    }
    if let Some(version_error) = compose_version_error() {
        return Err(version_error);
    }

    if let Some(progress) = progress {
        return start_stack_streaming(paths, progress);
    }

    // The tray's Start lands here (no progress handle). It goes through the
    // same self-heal as the splash: before this, a stale container left the
    // menu item permanently dead while the splash could recover from it.
    with_stale_container_retry(paths, None, || compose_up_blocking(paths))
}

fn compose_up_blocking(paths: &StackPaths) -> Result<(), String> {
    let output = compose_command(paths)
        // --scale powersync=0: powersync is in the "production" profile in
        // docker-compose.yml, so it's otherwise created by this `up`, but its
        // Postgres/JWT credentials (PS_STORAGE_URI, PS_JWT_SECRET_B64URL) come
        // from DATABASE_PASSWORD/POWERSYNC_JWT_SECRET, which this app's own
        // secrets model never populates — generate-secrets writes real
        // credentials straight into a Docker-managed volume for the other
        // services to read, not into compose-interpolated env vars (see the
        // module doc comment above). Left running, it crash-loops forever
        // (confirmed live: exit 150, first on its bind-mounted config
        // directory, then again on an empty JWT key) for a service nothing in
        // this app talks to yet — per infrastructure/powersync/README.md it's
        // an unverified, no-client-yet scaffold, excluded from the "local"
        // profile for the same reason. `--scale` (not a profiles/compose-file
        // override) sidesteps the docker-compose.yml service definition
        // entirely: profiles merge by concatenation like devices/group_add
        // above, and `!reset` clears a list to *empty*, which for `profiles`
        // means "no restriction — always active," the opposite of exclusion
        // (verified against this Compose CLI directly before choosing this
        // approach).
        //
        // Taken from UP_ARGS rather than re-typed here: this list used to be
        // duplicated as a literal, so the tray's start path and the splash's
        // streaming path could drift apart with nothing to catch it — and
        // .github/workflows/desktop-e2e.yml hand-mirrors the same list a third
        // time. One constant means the_compose_invocation_and_up_args_are_pinned
        // covers both in-process call sites.
        .args(UP_ARGS)
        .output()
        .map_err(|e| format!("Failed to run docker compose up: {e}"))?;

    append_desktop_log(paths, "start", &describe_output(&output));

    if !output.status.success() {
        return Err(format!(
            "docker compose up failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    clear_user_stopped(paths);
    Ok(())
}

/// The compose args shared by both start paths. `--scale powersync=0` and the
/// reasoning behind it are documented at the buffered call site above.
const UP_ARGS: [&str; 5] = ["up", "-d", "--remove-orphans", "--scale", "powersync=0"];

/// Failures that mean "the previous containers are stale", not "this machine
/// cannot run the stack".
///
/// Docker restarting — or the Mac sleeping — leaves containers pointing at a
/// network id that no longer exists, and leaves one-shot containers holding
/// names the next run needs. `docker compose up` then fails the same way every
/// time, so the splash's Retry button could never clear it: the user was stuck
/// on an app that refused to start until someone ran compose by hand. Both are
/// fixed by tearing the project down first, which is safe here because `down`
/// without `-v` keeps every volume, and volumes are where the memory lives.
fn is_stale_container_failure(transcript: &str) -> bool {
    let lower = transcript.to_lowercase();

    lower.contains("failed to set up container networking")
        || lower.contains("network") && lower.contains("not found")
        || lower.contains("is already in use by container")
}

/// Run an `up`, and if it failed on a stale container or network, tear the
/// project down once and run it again.
///
/// Shared by BOTH start paths deliberately. This retry lived inside the
/// streaming path, so the splash could recover but the tray's "Start Stack"
/// hit the identical conflict with no way out — the same dead end the retry
/// exists to remove, reachable from a different button.
///
/// `down` without `-v` keeps every volume, and volumes are where the memory
/// lives, so the recovery cannot cost the user data.
fn with_stale_container_retry<F>(
    paths: &StackPaths,
    progress: Option<&ProgressHandle>,
    attempt: F,
) -> Result<(), String>
where
    F: FnMut() -> Result<(), String>,
{
    let teardown = || {
        let down = compose_command(paths)
            .args(["down", "--remove-orphans"])
            .output()
            .map_err(|e| format!("Failed to run docker compose down: {e}"))?;

        // Log the whole result, not just stderr: a `down` that exits non-zero
        // is why the retry is about to fail the same way, and stderr alone does
        // not say whether it even ran.
        append_desktop_log(paths, "self-heal", &describe_output(&down));

        if !down.status.success() {
            return Err(describe_output(&down));
        }

        Ok(())
    };

    with_stale_container_retry_using(progress, attempt, teardown)
}

/// The retry logic itself, with the teardown injected.
///
/// Split out so the decision — retry on a stale container, never on anything
/// else — is testable without a Docker daemon. The production teardown is a
/// real `docker compose down`; a test passes a closure.
fn with_stale_container_retry_using<F, D>(
    progress: Option<&ProgressHandle>,
    mut attempt: F,
    teardown: D,
) -> Result<(), String>
where
    F: FnMut() -> Result<(), String>,
    D: FnOnce() -> Result<(), String>,
{
    match attempt() {
        Ok(()) => Ok(()),
        Err(err) if is_stale_container_failure(&err) => {
            log::warn!("compose up failed on stale containers, recreating the project: {err}");

            if let Some(progress) = progress {
                set_progress(progress, "starting", "Clearing a stale container from the last run…");
            }

            // A teardown that could not run is not fatal: retrying costs one
            // more `up`, and the ORIGINAL conflict is the error worth showing
            // the user — not "Failed to run docker compose down", which is
            // what propagating this hid the first error behind.
            if let Err(e) = teardown() {
                log::warn!("self-heal teardown did not complete: {e}");
            }

            attempt()
        }
        Err(err) => Err(err),
    }
}

fn start_stack_streaming(paths: &StackPaths, progress: &ProgressHandle) -> Result<(), String> {
    with_stale_container_retry(paths, Some(progress), || run_compose_up(paths, progress))
}

fn run_compose_up(paths: &StackPaths, progress: &ProgressHandle) -> Result<(), String> {
    set_progress(progress, "pulling", "Starting Docker services…");

    let mut child = compose_command(paths)
        .args(UP_ARGS)
        // Compose writes its progress to stderr and its results to stdout;
        // both are merged here so the status line follows whichever is talking.
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run docker compose up: {e}"))?;

    let mut transcript = Vec::new();

    if let Some(stderr) = child.stderr.take() {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if let Some(step) = describe_compose_line(&line) {
                let phase = if step.starts_with("Downloading") { "pulling" } else { "starting" };
                set_progress(progress, phase, step);
            }
            transcript.push(line);
        }
    }

    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            transcript.push(line);
        }
    }

    let status = child
        .wait()
        .map_err(|e| format!("Failed to wait for docker compose up: {e}"))?;

    append_desktop_log(paths, "start", &transcript.join("\n"));

    if !status.success() {
        return Err(describe_compose_failure(&transcript));
    }

    clear_user_stopped(paths);

    Ok(())
}

/// The one line out of a failed `docker compose up` worth putting on the splash.
///
/// Compose narrates every step that succeeded before it stopped, so the last
/// error-ish line is the one that actually explains the failure — an unpullable
/// tag, a full disk, a port already bound. Searching from the end matters:
/// compose commonly emits a transient early "error" while retrying a registry
/// connection it then recovers from, and reporting *that* sends the user after
/// the wrong problem.
///
/// Split out of [`run_compose_up`] because the surrounding function needs a
/// spawned `docker` to reach it at all, while this — the part that decides what
/// the user is told — is pure.
fn describe_compose_failure(transcript: &[String]) -> String {
    let reason = transcript
        .iter()
        .rev()
        .find(|line| {
            let l = line.to_lowercase();
            l.contains("error") || l.contains("failed") || l.contains("no space")
        })
        .cloned()
        .unwrap_or_else(|| transcript.last().cloned().unwrap_or_default());

    if reason.trim().is_empty() {
        "docker compose up failed. See the desktop log for details.".to_string()
    } else {
        reason.trim().to_string()
    }
}

/// Whether anything at all accepts a connection on the gateway port. It says
/// nothing about what: pair it with [`gateway_serves_port`] before treating
/// the answer as this app's own stack.
fn gateway_port_answers() -> bool {
    std::net::TcpStream::connect_timeout(
        &format!("127.0.0.1:{GATEWAY_PORT}").parse().expect("valid loopback address"),
        Duration::from_millis(400),
    )
    .is_ok()
}

/// The start preflight's ruling on the gateway port, split from the probes
/// that feed it so it is testable without Docker or a real listener. A port
/// that answers is fine only when this project's gateway container is the one
/// holding it; a port that does not answer must still be free to bind.
fn gateway_port_preflight(
    port_answers: bool,
    gateway_serves_port: impl FnOnce() -> bool,
    port_is_free: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if !port_answers {
        return port_is_free();
    }

    if gateway_serves_port() {
        Ok(())
    } else {
        Err(foreign_port_holder_message())
    }
}

/// What the splash says when the gateway port is taken and this project's
/// gateway container is not the one holding it.
fn foreign_port_holder_message() -> String {
    format!(
        "Port {GATEWAY_PORT} is already in use, and not by this app's own stack. \
         Quit whatever is using it and try again."
    )
}

/// The bundled overlay uses the Compose Specification's `!override` tag (on the
/// gateway's `ports:`), which first shipped in Compose 2.24.4 (compose-go
/// v2.0.0-rc.3). Older CLIs do not reject it: they ignore the tag and append the
/// overlay's loopback mapping to production's all-interfaces one, so the gateway
/// either fails to bind or answers on every interface again. Nothing in that
/// failure mentions versions, so check up front and say so plainly.
fn compose_version_error() -> Option<String> {
    let output = docker_command().args(["compose", "version", "--short"]).output().ok()?;
    compose_version_error_in(&String::from_utf8_lossy(&output.stdout))
}

/// The oldest Compose that honours `!override`; see [`compose_version_error`].
const MIN_COMPOSE_VERSION: (u32, u32, u32) = (2, 24, 4);

/// The version comparison itself, split from the `docker compose version` call
/// so the boundary (2.24.3 refused, 2.24.4 accepted) and the unreadable-output
/// escape hatch can be covered without a Docker daemon.
fn compose_version_error_in(raw: &str) -> Option<String> {
    let version = raw.trim().trim_start_matches('v');
    let mut parts = version.split('.');

    // The major component must actually parse. Coercing a failed parse to 0 (as this
    // used to) reads a *newer* Compose as an older one whenever the output is not the
    // bare `--short` form: "Docker Compose version v2.39.1" splits into
    // ["Docker Compose version v2", "39", "1"], which became (0, 39) — not (0, 0), so
    // the escape hatch below did not fire — and a current CLI was refused with a
    // message quoting its own version back at it.
    let major = parts.next().and_then(|p| p.parse::<u32>().ok());
    let minor = parts.next().and_then(|p| p.parse::<u32>().ok()).unwrap_or(0);
    // Only the leading digits: Docker Desktop reports versions such as
    // `2.24.6-desktop.1`, and a pre-release such as `2.24.4-rc1` counts as 2.24.4.
    let patch = parts
        .next()
        .map(|p| {
            p.chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>()
        })
        .and_then(|digits| digits.parse::<u32>().ok())
        .unwrap_or(0);

    // Unreadable version — let compose speak for itself. `Some(0)` is kept in this
    // branch because no Compose that can run the bundled overlay reports major 0.
    let major = major.filter(|&major| major > 0 || minor > 0)?;

    if (major, minor, patch) < MIN_COMPOSE_VERSION {
        let (need_major, need_minor, need_patch) = MIN_COMPOSE_VERSION;
        return Some(format!(
            "Docker Compose {version} is too old. Companion Memory needs {need_major}.{need_minor}.{need_patch} or newer. Update Docker Desktop and try again."
        ));
    }

    None
}

pub fn stop_stack(paths: &StackPaths) -> Result<(), String> {
    let output = compose_command(paths)
        .arg("down")
        .output()
        .map_err(|e| format!("Failed to run docker compose down: {e}"))?;

    append_desktop_log(paths, "stop", &describe_output(&output));

    if !output.status.success() {
        return Err(format!(
            "docker compose down failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    mark_user_stopped(paths);
    Ok(())
}

/// Coarse, tray-facing status. `Starting` vs `Stopped` is disambiguated by
/// the user-stopped marker file rather than container inspection, since a
/// container that's still pulling its image looks identical to a stopped one
/// from the health endpoint's perspective — both simply don't answer yet.
pub async fn probe_status(paths: &StackPaths) -> StackStatus {
    if !is_docker_installed() {
        return StackStatus::DockerNotInstalled;
    }
    if !is_docker_available() {
        return StackStatus::DockerNotRunning;
    }
    if is_healthy().await {
        return StackStatus::Running;
    }
    if is_user_stopped(paths) {
        StackStatus::Stopped
    } else {
        StackStatus::Starting
    }
}

/// The single source of truth for "is CI-Server actually serving requests" —
/// used both by the bootstrap page's polling loop (via
/// check_stack_status_command) and by the tray's background status loop.
/// Proxied through `gateway` to `api`'s own `/health` — see
/// infrastructure/gateway/nginx.conf's `location /api/` block.
/// The tag of an image reference — `ghcr.io/x/gateway:2026.9.10` -> `2026.9.10`.
/// None when the last path segment carries no tag, so a registry port
/// (`localhost:5000/x/gateway`) is never mistaken for one.
pub fn image_tag_of(image_ref: &str) -> Option<&str> {
    let last_segment = image_ref.rsplit('/').next().unwrap_or(image_ref);

    last_segment.split_once(':').map(|(_, tag)| tag).filter(|tag| !tag.is_empty())
}

/// What `docker inspect` says about this project's gateway container: the
/// facts readiness and the start preflight rest on.
#[derive(Debug, Clone, PartialEq, Eq)]
struct GatewayContainer {
    /// `Config.Image`, the reference the container was created from.
    image: String,
    /// `State.Running`.
    running: bool,
    /// The container's own port bindings hold GATEWAY_PORT on the host. A
    /// container compose created but could not start, because something else
    /// had the port, has none.
    publishes_gateway_port: bool,
}

impl GatewayContainer {
    /// Running and holding the port itself, so what answers on
    /// 127.0.0.1:GATEWAY_PORT is this container and not another program.
    fn serves_gateway_port(&self) -> bool {
        self.running && self.publishes_gateway_port
    }

    /// Serving the port, and created from this build's image tag.
    fn serves_image_tag(&self, image_tag: &str) -> bool {
        self.serves_gateway_port() && image_tag_of(&self.image) == Some(image_tag)
    }
}

/// Reads a [`GatewayContainer`] out of `docker inspect`'s JSON, an array with
/// one object per name asked about. Split from the command so the decision is
/// testable without a Docker daemon.
fn parse_gateway_inspect(inspect_json: &str) -> Option<GatewayContainer> {
    let parsed: serde_json::Value = serde_json::from_str(inspect_json).ok()?;
    let container = parsed.get(0)?;

    let image = container.pointer("/Config/Image")?.as_str()?.to_string();
    let running = container
        .pointer("/State/Running")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let gateway_port = GATEWAY_PORT.to_string();
    let publishes_gateway_port = container
        .pointer("/NetworkSettings/Ports")
        .and_then(|ports| ports.get(format!("{GATEWAY_PORT}/tcp")))
        .and_then(serde_json::Value::as_array)
        .is_some_and(|bindings| {
            bindings.iter().any(|binding| {
                binding.get("HostPort").and_then(serde_json::Value::as_str)
                    == Some(gateway_port.as_str())
            })
        });

    Some(GatewayContainer {
        image,
        running,
        publishes_gateway_port,
    })
}

/// This project's gateway container, or None when it does not exist or Docker
/// cannot be asked.
fn inspect_gateway() -> Option<GatewayContainer> {
    let output = docker_command()
        .args([
            "inspect",
            "--type",
            "container",
            &format!("{PROJECT_NAME}-gateway-1"),
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    parse_gateway_inspect(&String::from_utf8_lossy(&output.stdout))
}

/// Is this project's gateway container running and holding the gateway port?
///
/// The health probe cannot tell: any program listening on 127.0.0.1:8642 can
/// answer `/api/health`. Only the container's own state and port bindings tie
/// the socket to it.
pub fn gateway_serves_port() -> bool {
    inspect_gateway().is_some_and(|gateway| gateway.serves_gateway_port())
}

/// Is the gateway container that answers on the port running THIS build's
/// images?
///
/// Health alone is not readiness across an upgrade. Quitting the app leaves
/// the containers running, so the next launch — of a newer shell — finds a
/// healthy gateway on the first poll, and the splash used to redirect into it
/// while `compose up` was still pulling the new images. That page was the OLD
/// release: it re-registered the old release's service worker, and when
/// compose swapped the containers underneath it a moment later the webview
/// was pinned to a frontend the API no longer matched. Gating on the gateway
/// (the last service compose recreates, since it depends on `api`) means the
/// page the shell navigates to is the one it shipped with.
///
/// The image alone is not enough either: `docker inspect` reports it for a
/// container that was created and never started, which is the state compose
/// leaves the gateway in when another program already holds the port. So the
/// container must also be running with the port published, see
/// [`gateway_serves_port`].
pub fn gateway_runs_image_tag(image_tag: &str) -> bool {
    inspect_gateway().is_some_and(|gateway| gateway.serves_image_tag(image_tag))
}

pub async fn is_healthy() -> bool {
    let url = format!("http://127.0.0.1:{GATEWAY_PORT}/api/health");
    let client = match reqwest::Client::builder().timeout(Duration::from_millis(2500)).build() {
        Ok(client) => client,
        Err(_) => return false,
    };
    match client.get(url).send().await {
        Ok(response) => response.status().is_success(),
        Err(_) => false,
    }
}

fn user_stopped_marker(paths: &StackPaths) -> PathBuf {
    paths.data_dir.join(".user-stopped")
}

fn mark_user_stopped(paths: &StackPaths) {
    let _ = fs::write(user_stopped_marker(paths), b"");
}

fn clear_user_stopped(paths: &StackPaths) {
    let _ = fs::remove_file(user_stopped_marker(paths));
}

fn is_user_stopped(paths: &StackPaths) -> bool {
    user_stopped_marker(paths).exists()
}

fn describe_output(output: &Output) -> String {
    format!(
        "exit={:?} stdout={} stderr={}",
        output.status.code(),
        String::from_utf8_lossy(&output.stdout).trim(),
        String::from_utf8_lossy(&output.stderr).trim()
    )
}

pub fn append_desktop_log(paths: &StackPaths, op: &str, message: &str) {
    append_desktop_log_in(&paths.logs_dir, op, message);
}

/// Same as [`append_desktop_log`], addressed by logs directory rather than by
/// [`StackPaths`].
///
/// The `log::` bridge and the panic hook both need to write before
/// `initialize_stack` has returned a `StackPaths` — and the whole point of
/// installing them early is to capture a failure *inside* that call. The logs
/// dir is just `<data_dir>/logs`, which is knowable from the app handle alone.
pub fn append_desktop_log_in(logs_dir: &Path, op: &str, message: &str) {
    let log_path = logs_dir.join("desktop.log");
    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
    let line = format!("[{timestamp}] {op}: {message}\n");

    // Simple size-based rotation — just start over past the cap, no need for
    // anything fancier at this app's log volume.
    if let Ok(meta) = fs::metadata(&log_path) {
        if meta.len() > MAX_LOG_BYTES {
            let _ = fs::remove_file(&log_path);
        }
    }

    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&log_path) {
        use std::io::Write;
        let _ = file.write_all(line.as_bytes());
    }
}

pub fn read_desktop_logs(paths: &StackPaths, max_lines: usize) -> String {
    let log_path = paths.logs_dir.join("desktop.log");
    let contents = fs::read_to_string(log_path).unwrap_or_default();
    let lines: Vec<&str> = contents.lines().collect();
    let start = lines.len().saturating_sub(max_lines);
    lines[start..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Docker's rootless installer puts `docker` in ~/bin, and a GUI launch's
    /// PATH contains neither ~/bin nor ~/.local/bin — so searching only /usr
    /// reported "Docker was not found" on machines where it was installed and
    /// running. Reads HOME rather than setting it: mutating env vars in a
    /// #[test] races the rest of the suite.
    #[cfg(target_os = "linux")]
    #[test]
    fn extended_path_env_searches_rootless_docker_install_dirs() {
        let home = std::env::var("HOME").expect("HOME is set for the test runner");
        let path = extended_path_env();
        let dirs: Vec<&str> = path.split(':').collect();

        assert!(dirs.contains(&format!("{home}/bin").as_str()));
        assert!(dirs.contains(&format!("{home}/.local/bin").as_str()));
        // A system-wide install still wins over a rootless one.
        let index = |dir: &str| dirs.iter().position(|d| *d == dir).unwrap();
        assert!(index("/usr/bin") < index(&format!("{home}/bin")));
    }

    /// Exporting DOCKER_HOST outranks the CLI's own context selection, so the
    /// rootless fallback only speaks up when the CLI cannot reach a daemon by
    /// itself — never merely because a context is configured. A `currentContext`
    /// left behind by an uninstalled Docker Desktop names a dead endpoint, and
    /// deferring to it stranded the very user this exists for.
    #[cfg(target_os = "linux")]
    #[test]
    fn rootless_fallback_only_applies_when_the_cli_cannot_reach_a_daemon() {
        let socket = || Some("unix:///run/user/1000/docker.sock".to_string());

        // Nothing else answers, and a rootless socket does.
        assert_eq!(
            choose_docker_host(false, false, socket()),
            socket(),
            "should fall back to the rootless socket",
        );
        // The CLI already reaches a daemon — a stale context is not our business.
        assert_eq!(choose_docker_host(false, true, socket()), None);
        // The user named a daemon explicitly; that always wins.
        assert_eq!(choose_docker_host(true, false, socket()), None);
        // Nothing to fall back to: let the CLI's own error stand.
        assert_eq!(choose_docker_host(false, false, None), None);
    }

    #[test]
    fn writes_env_file_with_no_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let env_path = dir.path().join(".env");
        let import_work_dir = dir.path().join("import-work");

        write_env_file(&env_path, "2026.8.25", &import_work_dir).unwrap();

        let contents = fs::read_to_string(&env_path).unwrap();
        assert!(contents.contains("COMPOSE_PROJECT_NAME=ci-server-desktop"));
        assert!(contents.contains("CI_SERVER_IMAGE_TAG=2026.8.25"));
        assert!(contents.contains("CI_LOCAL_ONLY=true"));
        assert!(contents.contains("APP_BASE_URL=http://127.0.0.1:8642"));
        // The API must be told the chat model the sidecar actually pulls, not
        // left on its own compiled-in default — that drift is what broke every
        // background inference job on the zero-install path (see write_env_file's
        // comment). Asserted against the sidecar constant rather than a literal
        // tag so bumping the model in one place keeps this test honest instead
        // of failing it.
        use crate::local_model::ollama_sidecar::DEFAULT_CHAT_MODEL;
        assert!(contents.contains(&format!("LLM_DEFAULT_CHAT_MODEL={DEFAULT_CHAT_MODEL}")));
        // Not asserting a specific OIDC_ISSUER_URL value: it reads the
        // CI_PORTAL_URL env var, which this test deliberately doesn't set or
        // unset (mutating process env vars in a #[test] races against
        // whatever else cargo test is running in parallel) — just that the
        // key is present with *some* value.
        assert!(contents.contains("OIDC_ISSUER_URL="));
        assert!(!contents.to_lowercase().contains("secret"));
        assert!(!contents.to_lowercase().contains("password"));
    }

    /// Every key write_env_file generates, in one list.
    ///
    /// ⚠️ `.github/workflows/desktop-e2e.yml` ("Write the desktop compose .env")
    /// re-types this file by hand into the runner's compose directory, so that
    /// the E2E suite boots the published images through the same interpolation
    /// the shipped app produces. Nothing but this constant connects the two,
    /// and they have already diverged in both directions: that workflow adds
    /// CI_REPO_DIR (docker-compose.production.yml defaults the api's read-only
    /// archive mount to `~/Downloads`, which no runner has) and omits
    /// LLM_DEFAULT_CHAT_MODEL (there is no model server in that job, so naming
    /// a model would only make the API ask for one that cannot exist). Both
    /// divergences are deliberate and explained in the workflow's own comment —
    /// what had no enforcement at all was noticing when THIS side moves.
    ///
    /// So: adding or removing a key here fails this test, and the fix is to
    /// update desktop-e2e.yml's heredoc (or its comment saying why the key is
    /// deliberately absent) in the same change. Otherwise the E2E suite quietly
    /// exercises a stack the app never produces.
    const EXPECTED_ENV_KEYS: [&str; 8] = [
        "COMPOSE_PROJECT_NAME",
        "CI_SERVER_IMAGE_TAG",
        "APP_PUBLIC_HOSTNAME",
        "CI_IMPORT_WORK_DIR",
        "CI_LOCAL_ONLY",
        "LLM_DEFAULT_CHAT_MODEL",
        "OIDC_ISSUER_URL",
        "APP_BASE_URL",
    ];

    /// Pins the key SET, not the values or the line order: compose does not
    /// care what order `.env` lines arrive in, and the values that can be
    /// asserted without racing the process environment already are, in
    /// writes_env_file_with_no_secrets above. What nothing else checks is
    /// *which keys exist* — see EXPECTED_ENV_KEYS for who mirrors this file.
    #[test]
    fn the_generated_env_file_holds_exactly_the_keys_desktop_e2e_yml_mirrors() {
        let dir = tempfile::tempdir().unwrap();
        let env_path = dir.path().join(".env");

        write_env_file(&env_path, "2026.8.25", &dir.path().join("import-work")).unwrap();
        let contents = fs::read_to_string(&env_path).unwrap();

        // split_once, not split: only the FIRST `=` separates the key, so a
        // value that ever contains one (a URL with a query string, say) is not
        // silently truncated into a bogus assertion.
        let entries: Vec<(&str, &str)> = contents
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| line.split_once('=').expect("every generated line is KEY=VALUE"))
            .collect();

        // Sorted on both sides so a reordering of write_env_file's format!
        // block — which changes nothing compose can observe — does not fail
        // this. A duplicate key still does: it survives the sort as an extra
        // element, and a duplicate is a real fault (apply_llm_env_override
        // APPENDS to this file and relies on write_env_file never writing
        // LLM_API_BASE/LLM_API_KEY itself).
        let mut keys: Vec<&str> = entries.iter().map(|&(key, _)| key).collect();
        keys.sort_unstable();
        let mut expected = EXPECTED_ENV_KEYS;
        expected.sort_unstable();
        assert_eq!(
            keys, expected,
            "write_env_file's keys changed — update EXPECTED_ENV_KEYS *and* the \
             \"Write the desktop compose .env\" step in .github/workflows/desktop-e2e.yml",
        );

        // A key with no value is not an error to compose: it interpolates as an
        // empty string, so an emptied APP_BASE_URL yields an OIDC redirect_uri
        // with no origin at runtime rather than a failure here. OIDC_ISSUER_URL
        // is exempt because its value comes from the CI_PORTAL_URL env var,
        // which this test deliberately neither sets nor unsets (mutating
        // process env vars in a #[test] races the rest of the suite).
        for &(key, value) in &entries {
            if key == "OIDC_ISSUER_URL" {
                continue;
            }
            assert!(!value.is_empty(), "{key} was written with an empty value");
        }
    }

    /// The compose invocation itself, pinned argument for argument.
    ///
    /// The `-f` order is load-bearing: docker-compose.desktop.yml MUST be last,
    /// because it is the overlay that rewrites every `ci/<name>` image
    /// reference to the published `companion/<name>` one — moved earlier, the
    /// base file wins and the app tries to run images that only exist on a
    /// developer's machine. `--profile production` is what makes the
    /// production-only services (generate-secrets among them, which mints every
    /// credential on first boot) exist at all.
    ///
    /// ⚠️ `.github/workflows/desktop-e2e.yml` re-types this entire invocation by
    /// hand in five places spread over four steps ("Start the desktop stack",
    /// "Wait for the appliance to answer" — which holds two, its `ps` and
    /// `logs` failure dumps — "Upload stack logs", and "Tear down the desktop
    /// stack"); grep that file for `--project-name` before believing you have
    /// found them all, because counting steps stops you one short —
    /// `--env-file .env`, `--project-name
    /// ci-server-desktop`, the three `-f` files in this order,
    /// `--profile production`, then the UP_ARGS tail. A change here that is not
    /// mirrored there leaves that suite testing a stack the app does not build.
    /// Asserted against literals rather than the constants they come from on
    /// purpose: the workflow's copy is literals, so a test reading the same
    /// constants the code reads would pass through any rename.
    #[test]
    fn the_compose_invocation_and_up_args_are_pinned() {
        let dir = tempfile::tempdir().unwrap();
        let paths = scratch_paths(&dir);

        // Construction only — nothing is spawned here. (On Linux, building the
        // command resolves the docker host once, which probes `docker info`;
        // that is the same work the app does at launch, and it degrades to
        // "leave the CLI alone" when no daemon answers.)
        let cmd = compose_command(&paths);
        let args: Vec<String> = cmd.get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();

        assert_eq!(
            args,
            [
                "compose",
                "--env-file",
                ".env",
                "--project-name",
                "ci-server-desktop",
                "-f",
                "docker-compose.yml",
                "-f",
                "docker-compose.production.yml",
                "-f",
                "docker-compose.desktop.yml",
                "--profile",
                "production",
            ],
        );

        // The tail both start paths append, and the reason `--scale` is spelled
        // out rather than expressed as a profile override, are documented at
        // compose_up_blocking.
        assert_eq!(UP_ARGS, ["up", "-d", "--remove-orphans", "--scale", "powersync=0"]);
    }

    #[test]
    fn stale_container_failures_are_told_apart_from_real_ones() {
        // The two shapes Docker actually produces after it restarts or the Mac
        // sleeps. Both used to leave the app failing identically on every
        // launch, with a Retry button that could not clear either.
        assert!(is_stale_container_failure(
            "Error response from daemon: failed to set up container networking: network 0361b91e not found"
        ));
        assert!(is_stale_container_failure(
            "Error response from daemon: Conflict. The container name \"/ci-server-desktop-generate-secrets-1\" is already in use by container \"b9a8df\"."
        ));

        // Anything a teardown would not fix must NOT trigger one — tearing the
        // project down on a genuine failure would just add a slow retry of the
        // same error.
        assert!(!is_stale_container_failure("no space left on device"));
        assert!(!is_stale_container_failure(
            "manifest for ghcr.io/companionintelligence/companion/api:2026.9.9 not found: manifest unknown"
        ));
        assert!(!is_stale_container_failure("Cannot connect to the Docker daemon"));
    }

    /// The retry must be reachable from BOTH start paths, not just the splash.
    ///
    /// It used to live inside `start_stack_streaming`, so the tray's "Start
    /// Stack" — which runs with no progress handle — hit the same stale
    /// container and dead-ended, while the splash recovered from it. This
    /// drives the shared helper the way the tray does (`progress: None`) and
    /// asserts the second attempt actually happens.
    #[test]
    fn the_stale_container_retry_covers_the_tray_start_path_too() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = StackPaths {
            data_dir: dir.path().to_path_buf(),
            compose_dir: dir.path().join("compose"),
            logs_dir: dir.path().join("logs"),
            import_work_dir: dir.path().join("import-work"),
        };
        std::fs::create_dir_all(&paths.logs_dir).expect("logs dir");

        let attempts = std::cell::Cell::new(0);
        let teardowns = std::cell::Cell::new(0);
        let result = with_stale_container_retry_using(None, || {
            attempts.set(attempts.get() + 1);

            if attempts.get() == 1 {
                Err("Error response from daemon: Conflict. The container name \"/x\" is already in use by container \"y\".".to_string())
            } else {
                Ok(())
            }
        }, || {
            teardowns.set(teardowns.get() + 1);
            Ok(())
        });

        assert!(result.is_ok(), "the retry should have recovered: {result:?}");
        assert_eq!(attempts.get(), 2, "the up should have been attempted twice");
        assert_eq!(teardowns.get(), 1, "the project should have been torn down once");
    }

    /// The marker answers "was the webview cleared for the release it is
    /// about to load?" — and a first launch has to answer no, because that
    /// is the state every install bitten by the stale-worker blank screen is
    /// in. It only advances when told to, so a launch whose clear failed asks
    /// the same question again next time instead of never.
    #[test]
    fn the_image_tag_marker_reports_a_change_until_a_clear_is_recorded_for_that_tag() {
        let dir = tempfile::tempdir().expect("tempdir");

        assert_eq!(image_tag_change(dir.path(), "2026.9.6"), ImageTagChange { previous: None, changed: true });

        // Nothing recorded (the clear failed, say): still a change next launch.
        assert!(image_tag_change(dir.path(), "2026.9.6").changed);

        mark_image_tag_seen(dir.path(), "2026.9.6").expect("marker");
        assert_eq!(
            image_tag_change(dir.path(), "2026.9.6"),
            ImageTagChange { previous: Some("2026.9.6".into()), changed: false }
        );

        assert_eq!(
            image_tag_change(dir.path(), "2026.9.10"),
            ImageTagChange { previous: Some("2026.9.6".into()), changed: true },
            "an upgrade is a change"
        );

        mark_image_tag_seen(dir.path(), "2026.9.10").expect("marker");
        assert!(!image_tag_change(dir.path(), "2026.9.10").changed);
        assert!(image_tag_change(dir.path(), "2026.9.6").changed, "so is a downgrade");
    }

    /// Holds START_IN_FLIGHT the way an in-flight `up` does — BLOCKING, not
    /// try_lock. The lock is one static shared by every test in this binary
    /// and cargo runs them on parallel threads, so two tests that each
    /// `claim_start().expect(..)` race each other: the second to arrive finds
    /// the lock held by the first and panics. That is how this suite went red
    /// on one CI runner and green on three others. Waiting our turn is what
    /// the real second caller never does; a test that only wants to BE the
    /// in-flight start can afford to.
    fn hold_start_lock_for_test() -> std::sync::MutexGuard<'static, ()> {
        START_IN_FLIGHT.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Two starts on one project must not both reach Compose. This holds the
    /// start lock the way an in-flight `up` does and checks that a second
    /// caller stands down: it returns Ok, and it leaves LIVE progress exactly
    /// as it found it — the state here is deliberately not what a fresh start
    /// would write, so an overwrite cannot hide behind a coincidence. Both
    /// entry points, since the tray's is the one a person reaches by clicking
    /// Start twice.
    #[test]
    fn a_second_start_stands_down_while_one_is_in_flight() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = StackPaths {
            data_dir: dir.path().to_path_buf(),
            compose_dir: dir.path().join("compose"),
            logs_dir: dir.path().join("logs"),
            import_work_dir: dir.path().join("import-work"),
        };
        std::fs::create_dir_all(&paths.logs_dir).expect("logs dir");

        let in_flight = hold_start_lock_for_test();

        let progress = new_progress();
        set_progress(&progress, "pulling", "Pulling companion/api 3 of 9…");

        assert_eq!(start_stack_reporting(&paths, &progress), Ok(()), "a second start must stand down quietly, not fail");

        let after = progress.lock().expect("progress").clone();
        assert_eq!(after.phase, "pulling", "the bystander must not touch a live phase");
        assert_eq!(after.detail, "Pulling companion/api 3 of 9…", "the bystander must not overwrite a live status line");
        assert_eq!(after.error, None);
        assert!(!after.done, "only the in-flight start may declare the stack ready");

        assert_eq!(start_stack(&paths), Ok(()), "the tray path stands down the same way");

        drop(in_flight);
    }

    /// The one thing a stand-down may change: a failure left by an earlier
    /// start. Otherwise a Retry that lands behind a tray-driven start (which
    /// reports nothing) re-shows the old error for as long as that start runs.
    #[test]
    fn a_stand_down_clears_a_stale_failure_but_nothing_else() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = StackPaths {
            data_dir: dir.path().to_path_buf(),
            compose_dir: dir.path().join("compose"),
            logs_dir: dir.path().join("logs"),
            import_work_dir: dir.path().join("import-work"),
        };
        std::fs::create_dir_all(&paths.logs_dir).expect("logs dir");

        let in_flight = hold_start_lock_for_test();

        let progress = new_progress();
        fail_progress(&progress, "Port 8642 is already in use.");

        assert_eq!(start_stack_reporting(&paths, &progress), Ok(()));

        let after = progress.lock().expect("progress").clone();
        assert_eq!(after.error, None, "the stale failure must be gone");
        assert_ne!(after.phase, "failed");
        assert!(!after.done);

        drop(in_flight);
    }

    /// Readiness needs the gateway container running AND holding 8642 itself.
    /// `docker inspect` reports `Config.Image` for a container compose created
    /// but could not start, which is the state another program holding the
    /// port leaves it in, so the image alone proved nothing.
    #[test]
    fn a_gateway_counts_only_when_it_runs_and_holds_the_port_itself() {
        let inspect = |running: bool, ports: &str| {
            format!(
                r#"[{{"Config":{{"Image":"ghcr.io/companionintelligence/companion/gateway:2026.9.10"}},"State":{{"Running":{running}}},"NetworkSettings":{{"Ports":{ports}}}}}]"#
            )
        };
        let serves = |running: bool, ports: &str| {
            parse_gateway_inspect(&inspect(running, ports))
                .expect("parses")
                .serves_gateway_port()
        };
        let published = r#"{"8642/tcp":[{"HostIp":"127.0.0.1","HostPort":"8642"}]}"#;
        let elsewhere = r#"{"8642/tcp":[{"HostIp":"127.0.0.1","HostPort":"18642"}]}"#;

        let up = parse_gateway_inspect(&inspect(true, published)).expect("parses");
        assert!(up.image.ends_with("/gateway:2026.9.10"));
        assert!(up.serves_gateway_port());
        assert!(up.serves_image_tag("2026.9.10"));
        assert!(
            !up.serves_image_tag("2026.9.6"),
            "another release's gateway is not ready"
        );

        // The right image is not enough on its own.
        let created = parse_gateway_inspect(&inspect(false, published)).expect("parses");
        assert!(!created.serves_image_tag("2026.9.10"));

        // Created and never started: what compose leaves behind when the
        // port was already taken.
        assert!(!serves(false, r#"{"8642/tcp":null}"#));
        assert!(!serves(false, published));

        // Running, but the port is not its own.
        assert!(!serves(true, "{}"));
        assert!(!serves(true, elsewhere));

        // No such container, or output that is not inspect's.
        assert_eq!(parse_gateway_inspect("[]"), None);
        assert_eq!(parse_gateway_inspect("Error: No such object"), None);
    }

    /// The preflight used to skip its port check whenever anything accepted a
    /// connection on 8642, so a port another program held was never reported.
    #[test]
    fn a_port_held_by_anything_but_our_gateway_fails_the_preflight() {
        let free = || Ok(());

        // Our own running gateway holds it: the normal case on a relaunch.
        assert_eq!(gateway_port_preflight(true, || true, free), Ok(()));

        // Something answers, and it is not our gateway.
        let err = gateway_port_preflight(true, || false, free).unwrap_err();
        assert!(
            err.contains("8642") && err.contains("not by this app"),
            "{err}"
        );

        // Nothing answers: binding the port decides, and Docker is not asked.
        assert_eq!(
            gateway_port_preflight(false, || unreachable!(), free),
            Ok(())
        );
        let taken = || Err("Port 8642 is already in use".to_string());
        assert!(gateway_port_preflight(false, || true, taken).is_err());
    }

    /// Readiness compares the gateway's running image tag with the bundled
    /// one, and an image reference's tag is not simply "after the colon".
    #[test]
    fn an_image_references_tag_is_read_from_its_last_segment_only() {
        assert_eq!(image_tag_of("ghcr.io/companionintelligence/companion/gateway:2026.9.10"), Some("2026.9.10"));
        assert_eq!(image_tag_of("gateway:dev-abc123"), Some("dev-abc123"));
        assert_eq!(image_tag_of("localhost:5000/companion/gateway"), None, "a registry port is not a tag");
        assert_eq!(image_tag_of("ghcr.io/x/gateway:"), None, "an empty tag is no tag");
        assert_eq!(image_tag_of("ghcr.io/x/gateway"), None);
    }

    /// The other half of the same contract: a failure a teardown cannot fix
    /// must not be retried at all, or every genuine error costs a slow
    /// `down` plus an identical second failure.
    #[test]
    fn an_unrelated_failure_is_not_retried() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = StackPaths {
            data_dir: dir.path().to_path_buf(),
            compose_dir: dir.path().join("compose"),
            logs_dir: dir.path().join("logs"),
            import_work_dir: dir.path().join("import-work"),
        };
        std::fs::create_dir_all(&paths.logs_dir).expect("logs dir");

        let attempts = std::cell::Cell::new(0);
        let teardowns = std::cell::Cell::new(0);
        let result = with_stale_container_retry_using(None, || {
            attempts.set(attempts.get() + 1);
            Err("no space left on device".to_string())
        }, || {
            teardowns.set(teardowns.get() + 1);
            Ok(())
        });

        assert!(result.is_err());
        assert_eq!(attempts.get(), 1, "a non-stale failure must not be retried");
        assert_eq!(teardowns.get(), 0, "and must not tear the project down");
    }

    #[test]
    fn initialize_stack_fails_clearly_without_a_bundled_image_tag() {
        let resource_dir = tempfile::tempdir().unwrap();
        let data_dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(resource_dir.path().join("resources")).unwrap();
        for name in COMPOSE_FILES {
            fs::write(resource_dir.path().join("resources").join(name), "services: {}\n").unwrap();
        }
        // Deliberately no image-tag.txt written.

        let result = initialize_stack(resource_dir.path(), data_dir.path());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("image-tag.txt"));
    }

    fn scratch_paths(dir: &tempfile::TempDir) -> StackPaths {
        StackPaths {
            data_dir: dir.path().to_path_buf(),
            compose_dir: dir.path().join("compose"),
            logs_dir: dir.path().join("logs"),
            import_work_dir: dir.path().join("import-work"),
        }
    }

    #[test]
    fn compose_progress_lines_become_status_text() {
        // The lines worth showing, in the shapes compose actually emits.
        assert_eq!(describe_compose_line(" Pulling api "), Some("Downloading api…".to_string()));
        assert_eq!(describe_compose_line(" api Pulled "), Some("Downloaded api".to_string()));
        assert_eq!(describe_compose_line(" gateway Started "), Some("Started gateway".to_string()));
        assert_eq!(describe_compose_line(" database Created "), Some("Created database".to_string()));
        assert_eq!(
            describe_compose_line(" Container ci-server-desktop-api-1  Waiting until healthy "),
            Some("Waiting for services to become healthy…".to_string()),
        );
    }

    #[test]
    fn per_layer_pull_noise_is_dropped() {
        // Layer chatter changes many times a second; showing it reads as flicker
        // rather than progress, so only the service-level lines survive.
        assert_eq!(describe_compose_line(""), None);
        assert_eq!(describe_compose_line("   "), None);
        assert_eq!(describe_compose_line(" 3f4e1a2b Downloading [====>  ]  41.2MB/98MB"), None);
        assert_eq!(describe_compose_line(" 9c1d0e77 Extracting  12.3MB/44MB"), None);
        assert_eq!(describe_compose_line(" 9c1d0e77 Download complete"), None);
    }

    #[test]
    fn progress_carries_the_failure_reason_out() {
        let progress = new_progress();

        // Starts in a state the splash can render before anything has happened.
        {
            let p = progress.lock().unwrap();
            assert_eq!(p.phase, "preflight");
            assert!(p.error.is_none());
            assert!(!p.done);
        }

        set_progress(&progress, "pulling", "Downloading api…");
        {
            let p = progress.lock().unwrap();
            assert_eq!(p.phase, "pulling");
            assert_eq!(p.detail, "Downloading api…");
            // A step that succeeds clears any earlier error rather than leaving a
            // stale one for the page to show.
            assert!(p.error.is_none());
        }

        fail_progress(&progress, "no space left on device");
        {
            let p = progress.lock().unwrap();
            assert_eq!(p.phase, "failed");
            // The reason reaches the user verbatim — the whole point of the
            // channel is that this is no longer flattened into "took too long".
            assert_eq!(p.error.as_deref(), Some("no space left on device"));
            assert_eq!(p.detail, "no space left on device");
        }
    }

    /// Compose narrates every step that succeeded before it stopped, and it
    /// routinely logs a transient "error" while retrying a registry connection
    /// it then recovers from. Searching from the end is what separates the
    /// failure from the noise that preceded it — dropping the `.rev()` leaves
    /// the splash confidently naming the wrong problem.
    #[test]
    fn the_last_error_line_is_what_reaches_the_splash_not_the_first() {
        let transcript: Vec<String> = [
            " Container ci-server-desktop-database-1  Started",
            "#4 ERROR: failed to do request: connection reset by peer (retrying)",
            " Container ci-server-desktop-api-1  Created",
            "failed to solve: no space left on device",
        ]
        .iter()
        .map(|l| l.to_string())
        .collect();

        assert_eq!(describe_compose_failure(&transcript), "failed to solve: no space left on device");
    }

    #[test]
    fn a_failure_with_nothing_error_shaped_in_it_still_says_something_useful() {
        // Nothing matches the error vocabulary: the last line compose printed
        // is still a far better guess than a generic sentence.
        let quiet: Vec<String> = ["Pulling api", " api Pulled", " Container x  Recreate"]
            .iter()
            .map(|l| l.to_string())
            .collect();
        assert_eq!(describe_compose_failure(&quiet), "Container x  Recreate");

        // A compose that exited non-zero having said nothing at all — and one
        // whose last line is only whitespace — must not surface as an empty
        // error, which renders on the splash as a failure with no explanation.
        assert_eq!(
            describe_compose_failure(&[]),
            "docker compose up failed. See the desktop log for details."
        );
        assert_eq!(
            describe_compose_failure(&["   ".to_string()]),
            "docker compose up failed. See the desktop log for details."
        );
    }

    /// The bundled overlay uses the Compose Specification's `!override` tag,
    /// which first shipped in 2.24.4. Below that, compose ignores the tag and
    /// appends the loopback mapping to production's all-interfaces one, and
    /// nothing in the result mentions versions, so this check is the only place
    /// the real reason gets said. The boundary has to be exactly right, or it
    /// either rejects working installs or lets the broken mapping through.
    #[test]
    fn compose_older_than_2_24_4_is_refused_and_2_24_4_itself_is_not() {
        assert!(compose_version_error_in("2.23.9").is_some());
        assert!(compose_version_error_in("2.24.0").is_some());
        assert!(compose_version_error_in("2.24.3").is_some());
        assert!(compose_version_error_in("2.24").is_some());
        assert!(compose_version_error_in("2.24.4").is_none());
        assert!(compose_version_error_in("2.25.0").is_none());
        assert!(compose_version_error_in("1.29.2").is_some());

        // Docker Desktop's own spelling: the patch is read up to its first
        // non-digit, so a suffix neither hides an old patch nor refuses a new one.
        assert!(compose_version_error_in("v2.24.6-desktop.1\n").is_none());
        assert!(compose_version_error_in("v2.24.3-desktop.1\n").is_some());

        // The `v` prefix and the trailing newline are what `docker compose
        // version --short` actually emits, in that order.
        assert!(compose_version_error_in("v2.39.1\n").is_none());
        assert!(compose_version_error_in(" v2.20.3 \n").is_some());

        // Two-digit minors must not be compared as strings — "2.9" is older
        // than "2.24" numerically and newer lexically.
        assert!(compose_version_error_in("2.9.0").is_some());
        assert!(compose_version_error_in("3.0.0").is_none());

        let message = compose_version_error_in("2.24.3").expect("2.24.3 is too old");
        assert!(message.contains("2.24.3"), "the user should see their own version: {message}");
        assert!(message.contains("2.24.4"), "and what they need: {message}");
    }

    /// An unparseable version must not become a hard stop. A Compose CLI that
    /// prints something this cannot read is far more likely to be newer than
    /// older, and blocking launch on it would strand the user behind an error
    /// about a version we never actually determined.
    #[test]
    fn an_unreadable_compose_version_lets_compose_speak_for_itself() {
        // Empty stdout — the shape left behind by a CLI that does not
        // understand `--short` and wrote its complaint to stderr — and a
        // version with no digits in it at all both reach the (0, 0) guard.
        assert!(compose_version_error_in("").is_none());
        assert!(compose_version_error_in("   \n").is_none());
        assert!(compose_version_error_in("unknown").is_none());

        // Long-form output — what `docker compose version` prints WITHOUT
        // `--short`. This is the case that used to be silently wrong: the
        // major component ("Docker Compose version v2") does not parse, and
        // coercing it to 0 left minor = 39, so the (0, 0) escape hatch missed
        // it and a *current* Compose was refused as too old. Unreachable while
        // the one caller passes `--short`, which is exactly why it needs a test
        // rather than a comment: the day someone drops the flag, or a CLI stops
        // honouring it, the failure is a launch blocked on a version that was
        // never actually read.
        assert!(compose_version_error_in("Docker Compose version v2.39.1").is_none());
        assert!(compose_version_error_in("Docker Compose version v2.20.3").is_none());

        // A trailing component that does not parse is not the same thing: the
        // major and minor are readable, so the comparison still applies.
        assert!(compose_version_error_in("2.23.0-rc1").is_some());
        assert!(compose_version_error_in("2.24.4-rc1").is_none());
        assert!(compose_version_error_in("2.25.x").is_none());
    }

    /// desktop.log is append-only for the life of the install, so without the
    /// size cap it is unbounded — and it is written from a `log::` bridge that
    /// fires on every warning the shell produces. Rotation here is "start
    /// over", so what matters is that it actually triggers and that the line
    /// which triggered it survives; losing that one would hide the very event
    /// that was being logged.
    #[test]
    fn the_desktop_log_starts_over_once_it_passes_its_size_cap() {
        let dir = tempfile::tempdir().unwrap();
        let logs_dir = dir.path();
        let log_path = logs_dir.join("desktop.log");

        append_desktop_log_in(logs_dir, "launch", "v0.1.0 starting");
        let first = fs::read_to_string(&log_path).unwrap();
        assert!(first.contains("launch: v0.1.0 starting"));

        // Still well under the cap: the second line joins the first.
        append_desktop_log_in(logs_dir, "start", "compose up");
        let both = fs::read_to_string(&log_path).unwrap();
        assert!(both.contains("v0.1.0 starting") && both.contains("compose up"));
        assert_eq!(both.lines().count(), 2);

        // Now push it past the cap and write once more.
        fs::write(&log_path, vec![b'x'; (MAX_LOG_BYTES + 1) as usize]).unwrap();
        append_desktop_log_in(logs_dir, "panic", "something went wrong (main.rs:1)");

        let rotated = fs::read_to_string(&log_path).unwrap();
        assert!(rotated.len() < MAX_LOG_BYTES as usize, "the log should have been rotated away");
        assert!(rotated.contains("panic: something went wrong (main.rs:1)"));
        assert_eq!(rotated.lines().count(), 1, "rotation starts over rather than trimming");
    }

    /// What the UI's log pane renders. The tail is the interesting end — a
    /// crash is at the bottom of the file — and asking for more lines than
    /// exist is the normal case on a fresh install, where an off-by-one would
    /// panic on a slice rather than showing the log.
    #[test]
    fn reading_the_desktop_log_returns_the_newest_lines_and_never_panics_when_short() {
        let dir = tempfile::tempdir().unwrap();
        let paths = scratch_paths(&dir);
        fs::create_dir_all(&paths.logs_dir).unwrap();

        // Nothing written yet — the pane must render empty, not fail.
        assert_eq!(read_desktop_logs(&paths, 200), "");

        for n in 1..=10 {
            append_desktop_log_in(&paths.logs_dir, "start", &format!("line {n}"));
        }

        let tail = read_desktop_logs(&paths, 3);
        assert_eq!(tail.lines().count(), 3);
        assert!(tail.contains("line 8") && tail.contains("line 10"));
        assert!(!tail.contains("line 7"), "only the newest lines belong in the tail");

        // Asking for more than exist returns everything, in order.
        let everything = read_desktop_logs(&paths, 200);
        assert_eq!(everything.lines().count(), 10);
        assert!(everything.lines().next().unwrap().contains("line 1"));
        assert!(everything.lines().last().unwrap().contains("line 10"));
    }

    #[test]
    fn user_stopped_marker_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let paths = scratch_paths(&dir);

        assert!(!is_user_stopped(&paths));
        mark_user_stopped(&paths);
        assert!(is_user_stopped(&paths));
        clear_user_stopped(&paths);
        assert!(!is_user_stopped(&paths));
    }
}

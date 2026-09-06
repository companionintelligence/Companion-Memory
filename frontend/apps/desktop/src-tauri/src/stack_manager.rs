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

const PROJECT_NAME: &str = "ci-server-desktop";

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
    let portal_url = std::env::var("CI_PORTAL_URL").unwrap_or_else(|_| DEFAULT_PORTAL_URL.to_string());
    let contents = format!(
        "COMPOSE_PROJECT_NAME={PROJECT_NAME}\n\
         CI_SERVER_IMAGE_TAG={image_tag}\n\
         APP_PUBLIC_HOSTNAME=127.0.0.1\n\
         CI_IMPORT_WORK_DIR={}\n\
         CI_LOCAL_ONLY=true\n\
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
    }

    if extra_dirs.is_empty() {
        return existing;
    }
    let separator = if cfg!(target_os = "windows") { ";" } else { ":" };
    format!("{}{separator}{existing}", extra_dirs.join(separator))
}

fn docker_command() -> Command {
    let mut cmd = Command::new("docker");
    cmd.env("PATH", extended_path_env());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
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
    docker_command()
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

/// `start_stack`, reporting each step into `progress` as it goes.
///
/// Same sequence as `start_stack`; the difference is that compose's output is
/// streamed rather than buffered, so the splash can say which image is
/// downloading instead of one frozen line for the length of the pull.
pub fn start_stack_reporting(paths: &StackPaths, progress: &ProgressHandle) -> Result<(), String> {
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
    start_stack_inner(paths, None)
}

fn start_stack_inner(paths: &StackPaths, progress: Option<&ProgressHandle>) -> Result<(), String> {
    if let Some(progress) = progress {
        set_progress(progress, "preflight", "Checking your machine…");
    }

    // The app's OWN gateway holds this port whenever the stack is already up,
    // and treating that as a foreign conflict made the error unrecoverable:
    // every Retry hit the same check and refused before compose could run. A
    // port held by our own healthy stack is the normal case, not a problem.
    if !is_stack_healthy_blocking() {
        crate::port_check::preflight_port(GATEWAY_PORT)?;
    }

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
        .args(["up", "-d", "--remove-orphans", "--scale", "powersync=0"])
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

fn start_stack_streaming(paths: &StackPaths, progress: &ProgressHandle) -> Result<(), String> {
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
        // The last few lines are where compose says what actually went wrong
        // (an unpullable tag, a full disk, a port already bound); the rest is
        // the narration of everything that succeeded first.
        let reason = transcript
            .iter()
            .rev()
            .find(|line| {
                let l = line.to_lowercase();
                l.contains("error") || l.contains("failed") || l.contains("no space")
            })
            .cloned()
            .unwrap_or_else(|| transcript.last().cloned().unwrap_or_default());

        return Err(if reason.trim().is_empty() {
            "docker compose up failed. See the desktop log for details.".to_string()
        } else {
            reason.trim().to_string()
        });
    }

    clear_user_stopped(paths);

    Ok(())
}

/// Whether the gateway is already answering — used to tell "our own stack holds
/// the port" apart from "something else does".
fn is_stack_healthy_blocking() -> bool {
    std::net::TcpStream::connect_timeout(
        &format!("127.0.0.1:{GATEWAY_PORT}").parse().expect("valid loopback address"),
        Duration::from_millis(400),
    )
    .is_ok()
}

/// The bundled overlay uses the Compose Specification's `!reset` tag, which
/// needs Compose >= 2.24. Older CLIs fail on it with a YAML parse error that
/// says nothing about versions, so check up front and say so plainly.
fn compose_version_error() -> Option<String> {
    let output = docker_command().args(["compose", "version", "--short"]).output().ok()?;
    let raw = String::from_utf8_lossy(&output.stdout);
    let version = raw.trim().trim_start_matches('v');
    let mut parts = version.split('.').map(|p| p.parse::<u32>().unwrap_or(0));
    let (major, minor) = (parts.next().unwrap_or(0), parts.next().unwrap_or(0));

    if major == 0 && minor == 0 {
        return None; // unreadable version — let compose speak for itself
    }

    if (major, minor) < (2, 24) {
        return Some(format!(
            "Docker Compose {version} is too old — Companion Memory needs 2.24 or newer. Update Docker Desktop and try again."
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

/// Whether this machine has ever completed a start.
///
/// Drives the one-time disclosure on the splash: the first run downloads
/// several gigabytes of images and mounts a folder from the user's home
/// directory, and neither was stated anywhere before it happened.
pub fn is_first_run(paths: &StackPaths) -> bool {
    !paths.data_dir.join(".first-run-complete").exists()
}

pub fn mark_first_run_complete(paths: &StackPaths) {
    let _ = fs::write(paths.data_dir.join(".first-run-complete"), "");
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

fn append_desktop_log(paths: &StackPaths, op: &str, message: &str) {
    let log_path = paths.logs_dir.join("desktop.log");
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
        // Not asserting a specific OIDC_ISSUER_URL value: it reads the
        // CI_PORTAL_URL env var, which this test deliberately doesn't set or
        // unset (mutating process env vars in a #[test] races against
        // whatever else cargo test is running in parallel) — just that the
        // key is present with *some* value.
        assert!(contents.contains("OIDC_ISSUER_URL="));
        assert!(!contents.to_lowercase().contains("secret"));
        assert!(!contents.to_lowercase().contains("password"));
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
    fn first_run_marker_is_one_way() {
        let dir = tempfile::tempdir().unwrap();
        let paths = scratch_paths(&dir);

        // A machine that has never completed a start gets the disclosure.
        assert!(is_first_run(&paths));

        mark_first_run_complete(&paths);
        assert!(!is_first_run(&paths));

        // Marking again is harmless — the splash calls it on a path that can run
        // more than once if a start is retried.
        mark_first_run_complete(&paths);
        assert!(!is_first_run(&paths));
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

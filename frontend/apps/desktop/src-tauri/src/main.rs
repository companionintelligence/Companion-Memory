#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod local_model;
mod port_check;
mod stack_manager;
mod tray;

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::OnceLock;

use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;

/// Shared app state: the resolved on-disk paths for the compose files,
/// `.env`, and logs. Cloned cheaply (all fields are PathBuf) into each
/// command/tray-action invocation.
#[derive(Clone)]
pub struct StackPathsState(pub stack_manager::StackPaths);

/// Shared startup progress, written by whichever task is running the start and
/// read by the splash page's poll.
pub struct StartupProgressState(pub stack_manager::ProgressHandle);

/// The server image tag this build ships with — what `.env` pins and what the
/// splash waits for the gateway to be running before it navigates.
pub struct BundledImageTag(pub String);

/// A deep link that arrived before the frontend had a listener up — the cold-start
/// case (app not yet running when the OS delivers the URL) and, defensively, any
/// warm-start delivery that raced page load. `main.tsx`'s deep-link wiring drains
/// this via take_pending_deep_link_command on mount, THEN subscribes to the live
/// `companion-deep-link` DOM event for anything that arrives after — the same
/// two-mechanism shape iOS's getLaunchUrl (cold start) + appUrlOpen (live) already
/// uses, just adapted to Tauri's own event surface instead of Capacitor's.
#[derive(Default)]
struct PendingDeepLink(Mutex<Option<String>>);

/// Deliver a deep-link URL to the frontend: dispatch it live if a window exists
/// (covers the warm-start case, where the page — and hopefully its listener — is
/// already up), and ALWAYS also record it in PendingDeepLink so
/// take_pending_deep_link_command can hand it to a listener that mounts later,
/// whether that's because this delivery raced page load or because it arrived
/// before any window existed at all (true cold start).
///
/// The single caller is the on_open_url listener registered in .setup() below —
/// every platform's delivery mechanism (macOS/iOS's RunEvent::Opened, and
/// Windows/Linux's CLI-arg handling, both the plugin's own cold-start scan AND
/// the warm-start relaunch we feed it explicitly in the single-instance callback)
/// funnels through the SAME "deep-link://new-url" Tauri event the plugin emits,
/// so there is exactly one place downstream of the OS that needs to know how to
/// reach the frontend.
fn dispatch_deep_link(app: &tauri::AppHandle, url: &str) {
    log::info!("deep link received: {}", redacted_url_log_label(url));

    if let Ok(mut pending) = app.state::<PendingDeepLink>().0.lock() {
        *pending = Some(url.to_string());
    }

    // Looked up once and shared by every branch below — each needs the same
    // state, and the branches are mutually exclusive per call.
    let state = app.try_state::<StackPathsState>();

    if let Some(window) = app.get_webview_window("main") {
        // serde_json::to_string on a &str produces a properly quoted-and-escaped JS
        // string literal — the safe way to splice an arbitrary URL (OAuth `code`/
        // `state` params included) into an eval'd script.
        match serde_json::to_string(url) {
            Ok(js_literal) => {
                // Whether the eval reached the page is the other half of the answer:
                // a delivered-but-not-dispatched link and a never-delivered one look
                // identical from the frontend, and they have completely different fixes.
                let dispatched = window.eval(format!(
                    "window.dispatchEvent(new CustomEvent('companion-deep-link', {{ detail: {js_literal} }}));"
                ));

                if let Some(state) = state {
                    let outcome = match &dispatched {
                        Ok(()) => "dispatched to the webview".to_string(),
                        Err(e) => format!("FAILED to dispatch to the webview: {e}"),
                    };
                    stack_manager::append_desktop_log(&state.0, "deep-link", &outcome);
                }
            }
            Err(e) => {
                if let Some(state) = state {
                    stack_manager::append_desktop_log(
                        &state.0,
                        "deep-link",
                        &format!("FAILED to encode the URL for the webview: {e}"),
                    );
                }
            }
        }
    } else if let Some(state) = state {
        // The pending slot above still holds it, so this is recoverable rather
        // than lost — take_pending_deep_link_command hands it over on mount.
        stack_manager::append_desktop_log(
            &state.0,
            "deep-link",
            "no main window yet; held for take_pending_deep_link_command",
        );
    }
}

/// The only part of a URL that may reach the log file.
///
/// Both the incoming OIDC callback deep link and the outgoing sign-in URL this
/// app opens in the system browser carry short-lived (or, for `signup_code`,
/// single-use) credentials in their query string, and desktop.log is a file
/// the UI invites the user to open and paste into a bug report — so everything
/// from the first `?` on is dropped. What survives is enough to confirm which
/// URL was involved (`companion://auth/callback`, `.../api/authenticate/oidc`),
/// which is the whole reason the line exists.
///
/// Split out of its callers so the redaction is pinned by a test: it is one
/// `.split()` away from logging a live credential, and nothing else in this
/// file would notice if it went missing.
fn redacted_url_log_label(url: &str) -> &str {
    url.split('?').next().unwrap_or(url)
}

/// Where the `log::` bridge and the panic hook append, once the data dir is known.
///
/// Set once, early in `setup` — before `initialize_stack` runs, so a failure
/// inside that call is captured rather than being the one thing that still
/// vanishes.
static DESKTOP_LOG_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Sends `log::` records to the same file the UI's "View Logs" button opens.
///
/// `env_logger` writes to stderr, and a packaged .app has no stderr — macOS
/// discards it. A panic hook alone did not fix that: it captured panics while
/// every `log::error!` and `log::warn!` in this binary still went nowhere, so
/// the failures the shell actually reports about itself (a compose start that
/// returned non-zero, a self-heal that could not clear the conflict) remained
/// invisible. Records still go to stderr as well, which is what a `yarn dev`
/// run reads.
struct ShellLogger {
    level: log::LevelFilter,
}

impl log::Log for ShellLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= self.level
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }

        let line = format!("[{}] {}", record.target(), record.args());
        eprintln!("{} {line}", record.level());

        if let Some(dir) = DESKTOP_LOG_DIR.get() {
            stack_manager::append_desktop_log_in(dir, &record.level().to_string().to_lowercase(), &line);
        }
    }

    fn flush(&self) {}
}

/// Render a panic payload for the log line.
///
/// Rust stores the two common payload shapes differently and there is no
/// blanket "as a string" for `dyn Any`: `panic!("literal")` boxes a `&'static
/// str`, while any panic with formatting — `panic!("{e}")`, `.expect(&msg)`,
/// every `unwrap()` on an `Err` — boxes a `String`. Handling only the first
/// would silently reduce most real launch failures to "panic with no message",
/// which is exactly the blindness this logging exists to remove, so both are
/// tried before the fallback.
///
/// Takes the payload rather than the `PanicHookInfo` because that type has no
/// public constructor: passing `&dyn Any` is what makes the branch testable
/// without actually panicking.
fn panic_payload_message(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| (*s).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "panic with no message".to_string())
}

/// Mirror everything the shell knows about itself into the log the UI can open.
///
/// Installed as early as the data dir is knowable, which is the point: the
/// hook used to go up *after* `initialize_stack`, so the most likely silent
/// launch failure — a panic while creating the app-data layout or copying the
/// bundled compose files — was the one case it could not explain.
fn install_file_logging(logs_dir: &Path) {
    let _ = std::fs::create_dir_all(logs_dir);
    let _ = DESKTOP_LOG_DIR.set(logs_dir.to_path_buf());

    let panic_dir = logs_dir.to_path_buf();
    let previous = std::panic::take_hook();

    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "unknown location".to_string());
        let message = panic_payload_message(info.payload());

        stack_manager::append_desktop_log_in(&panic_dir, "panic", &format!("{message} ({location})"));
        previous(info);
    }));
}

/// How verbose [`ShellLogger`] is, from `RUST_LOG`.
///
/// An unparseable value must not silence the log: a typo'd `RUST_LOG=infoo`
/// leaving the app with no diagnostics at all is the worst possible reading of
/// an operator's intent, so anything `LevelFilter` cannot parse falls back to
/// the same Info default as an unset variable. Takes the value rather than
/// reading the env itself so a test can cover every branch without mutating
/// process env vars — which races the rest of `cargo test`, the same reason
/// stack_manager::choose_docker_host is split from its own probes.
fn configured_log_level(raw: Option<String>) -> log::LevelFilter {
    raw.and_then(|value| value.parse::<log::LevelFilter>().ok())
        .unwrap_or(log::LevelFilter::Info)
}

/// Drop the webview's cached frontend if the server images have moved since
/// the webview was last cleared. Returns whether a clear was issued.
///
/// The web app installs a service worker that precaches its bundle, and the
/// webview keeps it across launches — so after an upgrade the page the shell
/// navigates to would be served by LAST release's worker: old frontend, new
/// API, and a blank window with no asset request ever reaching the gateway.
/// The worker never updates itself because the stale bundle fails before its
/// registration code runs. See stack_manager::image_tag_change for the marker,
/// including why a missing one clears too.
///
/// A command rather than a step in `setup`, because WHEN this runs is the whole
/// fix. bootstrap.js calls it once check_stack_status_command says the gateway
/// is up on the bundled tag and immediately before window.location.replace():
/// any earlier — in `setup`, say — and a still-running previous stack could
/// hand the webview the old worker again between the clear and the redirect.
/// It takes cookies with it, so an upgrade costs one sign-in; that is the
/// price of a screen that renders.
///
/// The clear is dispatched, not awaited: wry hands WebKit an empty completion
/// handler. So Ok here means "asked", and the caller waits a beat before
/// navigating. The marker moves only on Ok — written any earlier, one failed
/// clear would leave the stale worker in place for good, since the next
/// launch would find the marker current and do nothing.
#[tauri::command]
fn forget_stale_frontend_command(
    app: tauri::AppHandle,
    state: tauri::State<'_, StackPathsState>,
    bundled: tauri::State<'_, BundledImageTag>,
) -> bool {
    let paths = &state.0;
    let image_tag = bundled.0.as_str();
    if image_tag.is_empty() {
        return false;
    }

    let change = stack_manager::image_tag_change(&paths.data_dir, image_tag);
    if !change.changed {
        return false;
    }

    let from = change.previous.as_deref().unwrap_or("(no record)");
    let Some(window) = app.get_webview_window("main") else {
        stack_manager::append_desktop_log(paths, "upgrade", &format!("{from} -> {image_tag}, but no main window to clear"));
        return false;
    };

    match window.clear_all_browsing_data() {
        Ok(()) => {
            stack_manager::append_desktop_log(
                paths,
                "upgrade",
                &format!("{from} -> {image_tag}: clearing the webview's cached frontend"),
            );
            if let Err(e) = stack_manager::mark_image_tag_seen(&paths.data_dir, image_tag) {
                stack_manager::append_desktop_log(paths, "upgrade", &format!("could not record image tag: {e}"));
            }
            true
        }
        Err(e) => {
            stack_manager::append_desktop_log(
                paths,
                "upgrade",
                &format!("{from} -> {image_tag}: FAILED to clear the webview's cached frontend: {e}"),
            );
            false
        }
    }
}

fn main() {
    // Installed before anything can log. The file half stays dormant until
    // `install_file_logging` learns the data dir a few lines into `setup`.
    let level = configured_log_level(std::env::var("RUST_LOG").ok());
    if log::set_boxed_logger(Box::new(ShellLogger { level })).is_ok() {
        log::set_max_level(level);
    }

    tauri::Builder::default()
        .manage(PendingDeepLink::default())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }

            // Windows/Linux deep-link delivery when the app is ALREADY running: the OS
            // launches a new instance with the URL as its one CLI arg, which
            // single-instance intercepts and hands us here instead of actually
            // starting a second process. Feed it to the deep-link plugin's own
            // parser/validator (it checks the arg against the configured schemes
            // and ignores anything that isn't a match) rather than re-implementing
            // that match ourselves — doing so also makes it emit the SAME
            // "deep-link://new-url" event our on_open_url listener below already
            // handles, so this path and every other one converge on one place.
            //
            // The plugin's own cold-start scan (this app's FIRST launch, not a
            // relaunch) already runs automatically inside tauri_plugin_deep_link's
            // own init() against std::env::args() — nothing to do for that case here.
            app.deep_link().handle_cli_arguments(args.iter());
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            let resource_dir = app.path().resource_dir()?;
            let data_dir = app.path().app_data_dir()?;

            // Before initialize_stack, not after: the logs dir is just
            // <data_dir>/logs, so it is knowable here, and a panic inside
            // initialize_stack is exactly the failure this is meant to explain.
            install_file_logging(&data_dir.join("logs"));

            let paths = stack_manager::initialize_stack(&resource_dir, &data_dir)?;
            let paths_for_log = paths.clone();
            stack_manager::append_desktop_log(
                &paths,
                "launch",
                &format!("v{} starting", env!("CARGO_PKG_VERSION")),
            );
            app.manage(StackPathsState(paths.clone()));
            let progress = stack_manager::new_progress();
            app.manage(StartupProgressState(progress.clone()));
            app.manage(local_model::LocalModelHandles::default());
            // initialize_stack has just read this same file to write .env, so a
            // failure here is one it already reported; the fallback only keeps
            // the shell from refusing to start over a readiness check.
            let bundled_tag = stack_manager::bundled_image_tag(&resource_dir).unwrap_or_default();
            app.manage(BundledImageTag(bundled_tag));

            tray::create_tray(app.handle())?;

            // The one listener every deep-link delivery path (macOS/iOS's
            // RunEvent::Opened, and both the plugin's automatic Windows/Linux
            // cold-start argv scan and our own warm-start relaunch handling above)
            // converges on — see dispatch_deep_link's doc comment.
            let deep_link_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                if let Some(url) = event.urls().first() {
                    dispatch_deep_link(&deep_link_handle, url.as_str());
                }
            });

            // Kick off the stack in the background so the window can appear
            // immediately instead of blocking startup on `docker compose up`
            // (which, on a first run, can take minutes to pull images). The
            // bootstrap page polls check_stack_status_command until it's
            // healthy, and separately calls start_stack_command itself — both
            // paths go through ensure_local_model_then_start_stack. Two guards
            // sit on that path and they answer different questions:
            // LocalModelHandles::resolve_once makes the FIRST `up` wait for a
            // finalised .env; stack_manager's START_IN_FLIGHT makes sure there
            // is only ONE `up` at all (see its doc comment for what two did).
            let app_handle = app.handle().clone();
            let startup_progress = progress.clone();
            tauri::async_runtime::spawn(async move {
                let join_result = tokio::task::spawn_blocking(move || {
                    ensure_local_model_then_start_stack(&app_handle, &paths, &startup_progress)
                })
                .await;

                match join_result {
                    Ok(Err(e)) => log::error!("initial start_stack failed: {e}"),
                    Err(join_error) => log::error!("initial start_stack panicked: {join_error}"),
                    Ok(Ok(())) => {}
                }
            });

            // Hide to tray on close instead of quitting — the stack keeps running.
            let paths_for_events = paths_for_log.clone();
            if let Some(window) = app.get_webview_window("main") {
                let hide_target = window.clone();
                let event_paths = paths_for_events.clone();
                window.on_window_event(move |event| {
                    match event {
                        tauri::WindowEvent::CloseRequested { api, .. } => {
                            stack_manager::append_desktop_log(&event_paths, "window", "close requested — hiding to tray");
                            let _ = hide_target.hide();
                            api.prevent_close();
                        }
                        tauri::WindowEvent::Destroyed => {
                            stack_manager::append_desktop_log(&event_paths, "window", "destroyed");
                        }
                        _ => {}
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_gateway_url_command,
            check_stack_status_command,
            start_stack_command,
            stop_stack_command,
            get_stack_status_command,
            check_docker_available_command,
            check_docker_installed_command,
            open_logs_dir_command,
            open_docker_downloads_command,
            read_desktop_logs_command,
            get_local_model_status_command,
            get_startup_progress_command,
            open_external_url_command,
            take_pending_deep_link_command,
            forget_stale_frontend_command,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Companion Memory desktop app");
}

/// Shared by main.rs's own startup task and start_stack_command — see the
/// call sites for why both need to go through the same
/// LocalModelHandles::resolve_once gate rather than each calling
/// stack_manager::start_stack directly.
fn ensure_local_model_then_start_stack(
    app_handle: &tauri::AppHandle,
    paths: &stack_manager::StackPaths,
    progress: &stack_manager::ProgressHandle,
) -> Result<(), String> {
    let handles = app_handle.state::<local_model::LocalModelHandles>();
    let apple_bridge_binary = match app_handle.path().resource_dir() {
        Ok(resource_dir) => resource_dir.join("resources/apple-bridge/ci-apple-bridge"),
        Err(e) => return Err(format!("Failed to resolve resource dir: {e}")),
    };

    if let Err(e) = handles.resolve_once(paths, &apple_bridge_binary) {
        log::error!("Local model resolution failed, continuing with defaults: {e}");
    }

    stack_manager::start_stack_reporting(paths, progress)
}

#[tauri::command]
fn get_gateway_url_command() -> String {
    format!("http://127.0.0.1:{}", stack_manager::GATEWAY_PORT)
}

/// Ready means healthy AND running this build's images. Health alone passes
/// on the first poll after an upgrade, because Quit leaves the previous
/// release's containers running — see stack_manager::gateway_runs_image_tag
/// for what redirecting into that stack did to the webview.
#[tauri::command]
async fn check_stack_status_command(bundled: tauri::State<'_, BundledImageTag>) -> Result<bool, String> {
    if !stack_manager::is_healthy().await {
        return Ok(false);
    }

    let image_tag = bundled.0.clone();
    if image_tag.is_empty() {
        return Ok(true);
    }

    tokio::task::spawn_blocking(move || stack_manager::gateway_runs_image_tag(&image_tag))
        .await
        .map_err(|e| format!("readiness check panicked: {e}"))
}

/// Kick off a start and return immediately.
///
/// This used to await the whole cold start — Ollama download, model pulls, every
/// image, and compose's own wait for `api` to become healthy — which is why the
/// splash could only show one frozen line for the length of it: the page was
/// blocked on this call before it ever reached its polling loop. The work now
/// runs in the background and reports through `get_startup_progress_command`.
///
/// Still routed through ensure_local_model_then_start_stack rather than
/// stack_manager::start_stack directly, so the model resolution happens before
/// the first `up` (LocalModelHandles::resolve_once). The bootstrap page calls
/// this moments after launch, while main.rs's own startup task is usually
/// mid-`up`; stack_manager's START_IN_FLIGHT is what turns that second call
/// into a no-op instead of a second, racing `docker compose up`.
#[tauri::command]
fn start_stack_command(
    app: tauri::AppHandle,
    state: tauri::State<'_, StackPathsState>,
    progress: tauri::State<'_, StartupProgressState>,
) -> Result<(), String> {
    let paths = state.0.clone();
    let progress = progress.0.clone();

    tauri::async_runtime::spawn(async move {
        let _ = tokio::task::spawn_blocking(move || {
            ensure_local_model_then_start_stack(&app, &paths, &progress)
        })
        .await;
    });

    Ok(())
}

/// What the splash renders: the current phase, the line to show, and the reason
/// if it failed.
#[tauri::command]
fn get_startup_progress_command(
    progress: tauri::State<'_, StartupProgressState>,
) -> stack_manager::StartupProgress {
    progress.0.lock().map(|p| p.clone()).unwrap_or_default()
}

#[tauri::command]
async fn stop_stack_command(state: tauri::State<'_, StackPathsState>) -> Result<(), String> {
    let paths = state.0.clone();
    tokio::task::spawn_blocking(move || stack_manager::stop_stack(&paths))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
async fn get_stack_status_command(
    state: tauri::State<'_, StackPathsState>,
) -> Result<stack_manager::StackStatus, String> {
    Ok(stack_manager::probe_status(&state.0).await)
}

#[tauri::command]
fn check_docker_available_command() -> bool {
    stack_manager::is_docker_available()
}

#[tauri::command]
fn check_docker_installed_command() -> bool {
    stack_manager::is_docker_installed()
}

#[tauri::command]
fn open_logs_dir_command(app: tauri::AppHandle, state: tauri::State<'_, StackPathsState>) -> Result<(), String> {
    app.opener()
        .open_path(state.0.logs_dir.to_string_lossy().to_string(), None::<String>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_docker_downloads_command(app: tauri::AppHandle) -> Result<(), String> {
    app.opener()
        .open_url("https://www.docker.com/products/docker-desktop/", None::<String>)
        .map_err(|e| e.to_string())
}

/// The allowlist behind [`open_external_url_command`] — this is the whole of
/// the check, so it is worth pinning on its own rather than only through a
/// command that needs a live `AppHandle` to call.
///
/// An exact `http://` / `https://` prefix, deliberately fail-closed: it rejects
/// scheme-relative (`//evil`), other schemes (`file:`, `smb:`, `javascript:`,
/// `data:`), and anything with leading whitespace, which is how a "just trim it
/// first" convenience would smuggle one of those through. Uppercase schemes are
/// rejected too even though the OS would honour them — the one caller
/// (OidcButton.tsx) builds its URL from a lowercase constant, so tightening
/// costs nothing real and keeps the rule a single comparison anyone can audit.
fn is_openable_external_url(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}

/// Open an arbitrary URL in the system's default browser. The one caller today is
/// "Sign in with CI Portal" (see OidcButton.tsx): OAuth must run in a browser the
/// user already trusts and may already be signed into, not this app's own webview.
/// Restricted to http(s) so a compromised webview can't use this as a generic
/// local-file/other-scheme open primitive.
#[tauri::command]
fn open_external_url_command(
    app: tauri::AppHandle,
    state: tauri::State<'_, StackPathsState>,
    url: String,
) -> Result<(), String> {
    // Logged on every path on purpose, including rejection. This is the sign-in
    // button: when it does nothing, the only question that matters is whether
    // the command was even reached and what happened — and the frontend can
    // only console.error into a devtools nobody has open. The URL itself is
    // never logged in full: it can carry a `signup_code` invite credential
    // (OidcButton.tsx), and desktop.log is a file the UI invites the user to
    // paste into a bug report.
    let label = redacted_url_log_label(&url).to_string();

    if !is_openable_external_url(&url) {
        stack_manager::append_desktop_log(&state.0, "open-url", &format!("REJECTED {label}: not an http(s) URL"));
        return Err("open_external_url_command only accepts http(s) URLs".to_string());
    }

    let result = app.opener().open_url(&url, None::<String>).map_err(|e| e.to_string());

    match &result {
        Ok(()) => stack_manager::append_desktop_log(&state.0, "open-url", &format!("opened {label}")),
        Err(e) => stack_manager::append_desktop_log(&state.0, "open-url", &format!("FAILED {label}: {e}")),
    }

    result
}

/// Drain (return and clear) any deep-link URL that reached this process before the
/// frontend had a listener up — see PendingDeepLink's doc comment for why this
/// exists alongside the live `companion-deep-link` DOM event.
#[tauri::command]
fn take_pending_deep_link_command(state: tauri::State<'_, PendingDeepLink>) -> Option<String> {
    state.0.lock().ok().and_then(|mut pending| pending.take())
}

#[tauri::command]
fn read_desktop_logs_command(state: tauri::State<'_, StackPathsState>) -> String {
    stack_manager::read_desktop_logs(&state.0, 200)
}

/// `None` while resolution is still in flight (or the initial background
/// task hasn't gotten there yet) — the bootstrap page/tray should treat that
/// as "figuring out the local model" rather than an error.
#[tauri::command]
fn get_local_model_status_command(
    state: tauri::State<'_, local_model::LocalModelHandles>,
) -> Option<local_model::LocalModelResolution> {
    state.status()
}

#[cfg(test)]
mod tests {
    use super::*;
    use log::Log;

    /// desktop.log is the file the UI's "View Logs" button opens and the user
    /// is invited to paste into a bug report, so an OAuth `code` — or, for the
    /// outgoing sign-in URL, a `signup_code` invite credential — reaching it is
    /// a credential leak with a long tail. Every branch of the redaction is
    /// covered because the fallback (`unwrap_or(url)`) is what runs for the
    /// links that carry no query at all.
    #[test]
    fn a_urls_query_string_never_reaches_the_log() {
        assert_eq!(
            redacted_url_log_label("companion://auth/callback?code=4/0AY0e-g7&state=xyzzy"),
            "companion://auth/callback"
        );
        assert_eq!(
            redacted_url_log_label("https://ci-server.localhost/api/authenticate/oidc?client=native&signup_code=abc123"),
            "https://ci-server.localhost/api/authenticate/oidc"
        );
        // No query: the whole URL is already safe, and must survive intact
        // rather than being truncated to nothing.
        assert_eq!(redacted_url_log_label("companion://auth/callback"), "companion://auth/callback");
        assert_eq!(redacted_url_log_label(""), "");
        // A bare `?` still redacts to the path — the split always yields a
        // first element, so this can never fall through to logging the rest.
        assert_eq!(redacted_url_log_label("companion://x?"), "companion://x");
    }

    /// The webview is the untrusted side of this boundary: a compromised page
    /// (or a malicious deep link that reached the frontend) can invoke this
    /// command with any string, and the OS opener will happily act on
    /// `file:///` or `smb://`. Only http(s) may get through.
    #[test]
    fn only_http_and_https_urls_may_be_handed_to_the_os_opener() {
        assert!(is_openable_external_url("https://hub.ci.computer/oauth/authorize?client_id=x"));
        assert!(is_openable_external_url("http://127.0.0.1:8642/"));

        assert!(!is_openable_external_url("file:///etc/passwd"));
        assert!(!is_openable_external_url("smb://192.168.1.9/share"));
        assert!(!is_openable_external_url("javascript:alert(1)"));
        assert!(!is_openable_external_url("data:text/html,<script>alert(1)</script>"));
        // Scheme-relative — the browser would resolve it, the opener would not,
        // and either way it is not what this command promises to accept.
        assert!(!is_openable_external_url("//evil.example.com"));
        assert!(!is_openable_external_url(""));
        // Leading whitespace is the classic way past a prefix check that
        // trims first; this one deliberately does not trim.
        assert!(!is_openable_external_url(" https://example.com"));
        assert!(!is_openable_external_url("\thttps://example.com"));
        // Fail-closed on case, as documented on the function.
        assert!(!is_openable_external_url("HTTPS://example.com"));
        // A prefix that merely starts the same way is not the scheme.
        assert!(!is_openable_external_url("https:/example.com"));
        assert!(!is_openable_external_url("httpsx://example.com"));
    }

    /// The panic hook exists because a packaged .app has no stderr, so this
    /// string is the *only* record of a crash during launch. `panic!` boxes a
    /// `&'static str` only for a literal with no formatting; everything else —
    /// including every `.expect(&format!(...))` and every `unwrap()` on an
    /// `Err` — boxes a `String`, so dropping that second branch would blank out
    /// the message for most real failures while still passing a naive test.
    #[test]
    fn both_panic_payload_shapes_survive_into_the_log_line() {
        assert_eq!(panic_payload_message(&"bundle.icon must be configured"), "bundle.icon must be configured");

        let formatted: String = format!("Failed to copy bundled resource {}", "docker-compose.yml");
        assert_eq!(
            panic_payload_message(&formatted),
            "Failed to copy bundled resource docker-compose.yml"
        );

        // panic_any with a non-string payload is rare but must not be rendered
        // as an empty line — "something panicked, no message" is still the
        // difference between a silent launch failure and a explicable one.
        assert_eq!(panic_payload_message(&42i32), "panic with no message");
    }

    /// The real payloads, taken from actual unwinds rather than hand-boxed
    /// values — this is what proves the downcast targets match what the runtime
    /// stores, which the assertions above assume.
    #[test]
    fn panic_payloads_taken_from_a_real_unwind_are_rendered() {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));

        let literal = std::panic::catch_unwind(|| panic!("a literal panic")).unwrap_err();
        let formatted = std::panic::catch_unwind(|| panic!("formatted {}", 7)).unwrap_err();

        std::panic::set_hook(previous);

        assert_eq!(panic_payload_message(literal.as_ref()), "a literal panic");
        assert_eq!(panic_payload_message(formatted.as_ref()), "formatted 7");
    }

    #[test]
    fn an_unreadable_rust_log_falls_back_to_info_rather_than_silence() {
        assert_eq!(configured_log_level(Some("debug".to_string())), log::LevelFilter::Debug);
        assert_eq!(configured_log_level(Some("WARN".to_string())), log::LevelFilter::Warn);
        assert_eq!(configured_log_level(Some("off".to_string())), log::LevelFilter::Off);

        assert_eq!(configured_log_level(None), log::LevelFilter::Info);
        assert_eq!(configured_log_level(Some("infoo".to_string())), log::LevelFilter::Info);
        assert_eq!(configured_log_level(Some(String::new())), log::LevelFilter::Info);
        // env_logger's per-module syntax is not LevelFilter syntax; it parses
        // as garbage here, and garbage must not mean "log nothing".
        assert_eq!(
            configured_log_level(Some("ci_server_desktop=trace".to_string())),
            log::LevelFilter::Info
        );
    }

    /// `Level` sorts most-severe-first (Error < Warn < Info), so the comparison
    /// in `enabled` reads backwards at a glance and is easy to invert — an
    /// inversion that would either log nothing or log everything, including at
    /// Off.
    #[test]
    fn the_shell_logger_admits_records_at_or_above_its_level() {
        let metadata = |level| log::Metadata::builder().level(level).target("test").build();
        let logger = ShellLogger { level: log::LevelFilter::Warn };

        assert!(logger.enabled(&metadata(log::Level::Error)));
        assert!(logger.enabled(&metadata(log::Level::Warn)));
        assert!(!logger.enabled(&metadata(log::Level::Info)));
        assert!(!logger.enabled(&metadata(log::Level::Debug)));

        let silent = ShellLogger { level: log::LevelFilter::Off };
        assert!(!silent.enabled(&metadata(log::Level::Error)));

        let verbose = ShellLogger { level: log::LevelFilter::Trace };
        assert!(verbose.enabled(&metadata(log::Level::Trace)));
    }
}

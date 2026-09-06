#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod local_model;
mod port_check;
mod stack_manager;
mod tray;

use std::sync::Mutex;

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
    // Never log the full URL — the OIDC callback's `code` query param is a short-lived
    // credential. Everything before the first `?` is enough to confirm delivery.
    log::info!(
        "deep link received: {}",
        url.split('?').next().unwrap_or(url)
    );

    if let Ok(mut pending) = app.state::<PendingDeepLink>().0.lock() {
        *pending = Some(url.to_string());
    }

    if let Some(window) = app.get_webview_window("main") {
        // serde_json::to_string on a &str produces a properly quoted-and-escaped JS
        // string literal — the safe way to splice an arbitrary URL (OAuth `code`/
        // `state` params included) into an eval'd script.
        if let Ok(js_literal) = serde_json::to_string(url) {
            let _ = window.eval(format!(
                "window.dispatchEvent(new CustomEvent('companion-deep-link', {{ detail: {js_literal} }}));"
            ));
        }
    }
}

fn main() {
    env_logger::init();

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

            let paths = stack_manager::initialize_stack(&resource_dir, &data_dir)?;
            app.manage(StackPathsState(paths.clone()));
            let progress = stack_manager::new_progress();
            app.manage(StartupProgressState(progress.clone()));
            app.manage(local_model::LocalModelHandles::default());

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
            // paths go through ensure_local_model_then_start_stack, whose
            // LocalModelHandles::resolve_once guard is what keeps them from
            // racing each other to the first `docker compose up` (see that
            // method's doc comment for why the race matters here).
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
            if let Some(window) = app.get_webview_window("main") {
                let hide_target = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        let _ = hide_target.hide();
                        api.prevent_close();
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

#[tauri::command]
async fn check_stack_status_command() -> bool {
    stack_manager::is_healthy().await
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
/// stack_manager::start_stack directly — the bootstrap page calls this moments
/// after launch and must not race main.rs's own startup task to the first
/// `docker compose up` (see LocalModelHandles::resolve_once's doc comment).
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

/// Open an arbitrary URL in the system's default browser. The one caller today is
/// "Sign in with CI Portal" (see OidcButton.tsx): OAuth must run in a browser the
/// user already trusts and may already be signed into, not this app's own webview.
/// Restricted to http(s) so a compromised webview can't use this as a generic
/// local-file/other-scheme open primitive.
#[tauri::command]
fn open_external_url_command(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("open_external_url_command only accepts http(s) URLs".to_string());
    }

    app.opener()
        .open_url(url, None::<String>)
        .map_err(|e| e.to_string())
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

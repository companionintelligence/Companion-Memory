#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod local_model;
mod port_check;
mod stack_manager;
mod tray;

use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

/// Shared app state: the resolved on-disk paths for the compose files,
/// `.env`, and logs. Cloned cheaply (all fields are PathBuf) into each
/// command/tray-action invocation.
#[derive(Clone)]
pub struct StackPathsState(pub stack_manager::StackPaths);

fn main() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let resource_dir = app.path().resource_dir()?;
            let data_dir = app.path().app_data_dir()?;

            let paths = stack_manager::initialize_stack(&resource_dir, &data_dir)?;
            app.manage(StackPathsState(paths.clone()));
            app.manage(local_model::LocalModelHandles::default());

            tray::create_tray(app.handle())?;

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
            tauri::async_runtime::spawn(async move {
                let join_result =
                    tokio::task::spawn_blocking(move || ensure_local_model_then_start_stack(&app_handle, &paths))
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
) -> Result<(), String> {
    let handles = app_handle.state::<local_model::LocalModelHandles>();
    let apple_bridge_binary = match app_handle.path().resource_dir() {
        Ok(resource_dir) => resource_dir.join("resources/apple-bridge/ci-apple-bridge"),
        Err(e) => return Err(format!("Failed to resolve resource dir: {e}")),
    };

    if let Err(e) = handles.resolve_once(paths, &apple_bridge_binary) {
        log::error!("Local model resolution failed, continuing with defaults: {e}");
    }

    stack_manager::start_stack(paths)
}

#[tauri::command]
fn get_gateway_url_command() -> String {
    format!("http://127.0.0.1:{}", stack_manager::GATEWAY_PORT)
}

#[tauri::command]
async fn check_stack_status_command() -> bool {
    stack_manager::is_healthy().await
}

/// Routed through ensure_local_model_then_start_stack rather than calling
/// stack_manager::start_stack directly — the bootstrap page calls this
/// command itself moments after launch, and it must not race main.rs's own
/// startup task to the first `docker compose up` (see
/// LocalModelHandles::resolve_once's doc comment).
#[tauri::command]
async fn start_stack_command(app: tauri::AppHandle, state: tauri::State<'_, StackPathsState>) -> Result<(), String> {
    let paths = state.0.clone();
    tokio::task::spawn_blocking(move || ensure_local_model_then_start_stack(&app, &paths))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
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

//! System tray: show/hide the window, manual start/stop of the stack, a
//! live status label, and a link to the desktop log file. No watchdog
//! auto-restart of a crashed stack in v1 — this loop only reports status and
//! offers manual controls.

use std::time::Duration;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::{local_model, stack_manager, StackPathsState};

const POLL_INTERVAL: Duration = Duration::from_secs(9);

pub fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Companion Memory", true, None::<&str>)?;
    let start = MenuItem::with_id(app, "start", "Start Stack", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Stop Stack", true, None::<&str>)?;
    let logs = MenuItem::with_id(app, "logs", "View Logs", true, None::<&str>)?;
    let status = MenuItem::with_id(app, "status", "Status: checking…", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &show,
            &PredefinedMenuItem::separator(app)?,
            &start,
            &stop,
            &PredefinedMenuItem::separator(app)?,
            &logs,
            &PredefinedMenuItem::separator(app)?,
            &status,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let icon = app
        .default_window_icon()
        .cloned()
        .expect("bundle.icon must be configured in tauri.conf.json");

    TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| handle_menu_event(app, event.id.as_ref()))
        .build(app)?;

    spawn_status_loop(app.clone(), status, start, stop);

    Ok(())
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        "show" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        "start" => run_in_background(app, |paths| stack_manager::start_stack(&paths)),
        "stop" => run_in_background(app, |paths| stack_manager::stop_stack(&paths)),
        "logs" => {
            let state = app.state::<StackPathsState>();
            let _ = app
                .opener()
                .open_path(state.0.logs_dir.to_string_lossy().to_string(), None::<String>);
        }
        "quit" => {
            // Docker containers deliberately outlive the app (see main.rs's
            // hide-to-tray close handler) — a real appliance server should
            // keep running. The local-model child processes exist only to
            // serve requests from this app's own stack, so they don't get
            // the same treatment: kill them before quitting, or an orphaned
            // Ollama sidecar / Apple bridge process lingers with nothing left
            // to talk to it.
            app.state::<local_model::LocalModelHandles>().shutdown();
            app.exit(0);
        }
        _ => {}
    }
}

/// Runs a blocking stack_manager operation off the async executor via
/// spawn_blocking — `docker compose up` can take minutes on a first-run
/// image pull, and must not stall Tauri's runtime while it does.
fn run_in_background(
    app: &AppHandle,
    op: impl FnOnce(stack_manager::StackPaths) -> Result<(), String> + Send + 'static,
) {
    let state = app.state::<StackPathsState>();
    let paths = state.0.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(join_error) = tokio::task::spawn_blocking(move || op(paths)).await {
            log::error!("tray action panicked: {join_error}");
        }
    });
}

fn spawn_status_loop(app: AppHandle, status_item: MenuItem<tauri::Wry>, start_item: MenuItem<tauri::Wry>, stop_item: MenuItem<tauri::Wry>) {
    tauri::async_runtime::spawn(async move {
        loop {
            let paths = app.state::<StackPathsState>().0.clone();
            let status = stack_manager::probe_status(&paths).await;
            let (label, start_enabled, stop_enabled) = describe_status(&status);

            let _ = status_item.set_text(format!("Status: {label}"));
            let _ = start_item.set_enabled(start_enabled);
            let _ = stop_item.set_enabled(stop_enabled);

            tokio::time::sleep(POLL_INTERVAL).await;
        }
    });
}

fn describe_status(status: &stack_manager::StackStatus) -> (String, bool, bool) {
    use stack_manager::StackStatus::*;
    match status {
        DockerNotInstalled => ("Docker not installed".to_string(), false, false),
        DockerNotRunning => ("Docker not running".to_string(), false, false),
        Stopped => ("Stopped".to_string(), true, false),
        Starting => ("Starting…".to_string(), false, true),
        Running => ("Running".to_string(), false, true),
    }
}

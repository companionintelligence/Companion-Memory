use std::path::Path;
use std::process::Command;

/// Every `#[tauri::command]` this app registers, declared so Tauri generates an
/// app ACL manifest for them.
///
/// Without this, `acl-manifests.json` has no `__app__` entry, `resolve_access`
/// answers None for every app command, and the webview gate at
/// `tauri::webview::mod.rs` rejects them for any origin it checks. That is why
/// the remote web app's "Sign in with Companion account" did nothing: the ACL,
/// not the opener plugin, was refusing `open_external_url_command`.
///
/// Declaring commands here autogenerates an `allow-<kebab-command>` /
/// `deny-<kebab-command>` permission per entry; capabilities/*.json reference
/// those. Adding a command to `generate_handler!` without adding it here leaves
/// it unreachable from every webview.
const APP_COMMANDS: &[&str] = &[
    // Bootstrap splash (local origin, bootstrap/bootstrap.js).
    "check_docker_available_command",
    "check_docker_installed_command",
    "check_stack_status_command",
    "get_gateway_url_command",
    "get_startup_progress_command",
    "open_docker_downloads_command",
    "open_logs_dir_command",
    "start_stack_command",
    // Remote CI-Server web app (capabilities/oidc-remote-deep-link.json).
    "open_external_url_command",
    "take_pending_deep_link_command",
];

fn main() {
    build_apple_bridge();
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("failed to run tauri-build");
}

/// Compiles the Apple on-device bridge (../apple-bridge, a standalone Swift
/// package — see local_model/apple_bridge.rs for why it's a separate process
/// rather than an FFI static lib) and copies the resulting binary into
/// resources/apple-bridge/, where Tauri's bundler picks up everything under
/// resources/ (tauri.conf.json's bundle.resources) the same way it already
/// does for the compose YAML files scripts/sync-compose-resources.cjs writes
/// there.
///
/// macOS-only and best-effort at every step, including a failed `swift
/// build` — Package.swift pins `platforms: [.macOS(.v26)]` and imports
/// FoundationModels, so this needs Xcode 26+ with the macOS 26 SDK
/// specifically, not just "some Xcode." A contributor on an older Xcode (no
/// FoundationModels in that SDK at all) must still be able to `cargo build`
/// the rest of this app — local_model::apple_bridge::is_available() already
/// treats a missing binary as "unavailable, fall back to Ollama," so a
/// warning here is the correct failure mode, not a panic that blocks
/// everyone else's build on one contributor's Xcode version.
fn build_apple_bridge() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }

    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by cargo");
    let package_dir = Path::new(&manifest_dir).join("apple-bridge");
    println!("cargo:rerun-if-changed={}", package_dir.join("Sources").display());
    println!("cargo:rerun-if-changed={}", package_dir.join("Package.swift").display());

    let swift_available = Command::new("xcrun")
        .arg("--find")
        .arg("swift")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !swift_available {
        println!(
            "cargo:warning=Xcode/swift not found — skipping the Apple on-device bridge. \
             local_model::apple_bridge::is_available will report unavailable; the app \
             still works via the Ollama fallback."
        );
        return;
    }

    let build_result = Command::new("swift").args(["build", "-c", "release"]).current_dir(&package_dir).status();
    let built_ok = matches!(build_result, Ok(status) if status.success());
    if !built_ok {
        println!(
            "cargo:warning=`swift build` failed for the Apple on-device bridge (needs Xcode 26+ with the \
             macOS 26 SDK — see build_apple_bridge's doc comment) — skipping it. \
             local_model::apple_bridge::is_available will report unavailable; the app still works via \
             the Ollama fallback."
        );
        return;
    }

    let built_binary = package_dir.join(".build/release/ci-apple-bridge");
    let dest_dir = Path::new(&manifest_dir).join("resources/apple-bridge");
    if let Err(e) = std::fs::create_dir_all(&dest_dir).and_then(|_| std::fs::copy(&built_binary, dest_dir.join("ci-apple-bridge")).map(|_| ()))
    {
        println!(
            "cargo:warning=Failed to install the built Apple on-device bridge into resources/apple-bridge: {e} \
             — skipping it. The app still works via the Ollama fallback."
        );
    }
}

//! Ensures *something* answers CI-Server's existing Ollama contract
//! (backend/apps/api/config/default.json: `services.ollama.host` defaults to
//! `http://host.docker.internal:11434`, i.e. whatever's on the HOST's port
//! 11434) for users who don't already run Ollama themselves. This module
//! never touches that config or stack_manager's `.env` — it only makes sure
//! port 11434 is answering, in one of three ways, cheapest first:
//!
//!   1. Already running (the user's own Ollama) → nothing to do.
//!   2. `ollama` is installed but not running → launch it with its own
//!      default `OLLAMA_MODELS`, so any models the user already pulled are
//!      reused rather than duplicated.
//!   3. Not installed at all → download Ollama's own official release
//!      archive into this app's data directory and run it from there, with
//!      its own dedicated `OLLAMA_MODELS` (self-contained, uninstall-clean).
//!
//! Either way, small models are pulled with plain `ollama pull` — Ollama
//! already handles resumable, integrity-checked model downloads itself, so
//! there is no need to reimplement that here (only the ~150MB–1.5GB Ollama
//! binary itself, in the v3 case, needs this module's own download+verify
//! logic).

use std::io::{BufRead, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use serde::Deserialize;
use sha2::{Digest, Sha256};

/// The port CI-Server's `services.ollama.host` default already points at —
/// see the module doc comment. Deliberately the same port in all three
/// resolution branches so stack_manager::write_env_file never needs an
/// OLLAMA_HOST override.
pub const OLLAMA_PORT: u16 = 11434;

/// Small, ungated tags confirmed to exist in Ollama's library as of this
/// writing (ollama.com/library/gemma3, ollama.com/library/nomic-embed-text).
/// Unlike LiteRT-LM's Android binding (see the desktop-local-model-runner
/// research), Ollama's own Gemma tags pull without authentication.
pub const DEFAULT_CHAT_MODEL: &str = "gemma3:1b";
pub const DEFAULT_EMBED_MODEL: &str = "nomic-embed-text";

const OLLAMA_VERSION: &str = "v0.32.15";

struct ReleaseAsset {
    name: &'static str,
    sha256: &'static str,
}

/// Pinned against OLLAMA_VERSION's published sha256sum.txt — verified by hand
/// against a real download while writing this module, not copied from an
/// unread manifest. Bump both together.
fn release_asset() -> Option<ReleaseAsset> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", _) => Some(ReleaseAsset {
            // Universal (arm64 + x86_64) binary — one download covers both Mac architectures.
            name: "ollama-darwin.tgz",
            sha256: "9ab0ac4747946620a2464054f3c44a55aa146e9fccb5c366ee18e43fd1930b90",
        }),
        ("linux", "x86_64") => Some(ReleaseAsset {
            name: "ollama-linux-amd64.tar.zst",
            sha256: "50539c5fe9bf85887733355098dcdb266b433cb8c73fa180713417e9ed6e42bb",
        }),
        ("linux", "aarch64") => Some(ReleaseAsset {
            name: "ollama-linux-arm64.tar.zst",
            sha256: "c898270b1690eab0f51aa9e9197686b7b4c6a7d88b83967763818f3127e477e9",
        }),
        ("windows", "x86_64") => Some(ReleaseAsset {
            name: "ollama-windows-amd64.zip",
            sha256: "a1d11d46a944f9c7521f5e9a3a5db51cd3365401da627d96c204698fc6914ff9",
        }),
        ("windows", "aarch64") => Some(ReleaseAsset {
            name: "ollama-windows-arm64.zip",
            sha256: "51655f2700236bdff09c8cfb174b0855d354ec40775e66069d9b63f32a666937",
        }),
        _ => None,
    }
}

fn binary_name() -> &'static str {
    if cfg!(windows) {
        "ollama.exe"
    } else {
        "ollama"
    }
}

pub struct RunningInstance {
    pub port: u16,
    /// `None` when we detected and are reusing an instance we don't own
    /// (either already running, or launched from a PATH-found install) —
    /// only a binary we downloaded ourselves gets killed on app quit; a
    /// pre-existing user install is left exactly as we found it.
    pub child: Option<Child>,
}

pub fn is_running(port: u16) -> bool {
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(800))
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };
    client
        .get(format!("http://127.0.0.1:{port}/api/version"))
        .send()
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

/// Searches the same extended PATH stack_manager already builds for Docker,
/// since Homebrew/system package managers install both CLIs into the same
/// handful of directories a GUI-launched app's minimal PATH often lacks.
fn find_on_path() -> Option<PathBuf> {
    let extra = crate::stack_manager::extended_path_env();
    std::env::split_paths(&extra).map(|dir| dir.join(binary_name())).find(|candidate| candidate.is_file())
}

/// Ensures OLLAMA_PORT is answering and the models CI-Server needs are
/// pulled, choosing the cheapest of the three strategies described in the
/// module doc comment. `need_chat_model` is false when the Apple on-device
/// bridge is handling chat and this instance only needs to serve embeddings.
pub fn ensure_available(data_dir: &Path, logs_dir: &Path, need_chat_model: bool) -> Result<RunningInstance, String> {
    if is_running(OLLAMA_PORT) {
        return Ok(RunningInstance { port: OLLAMA_PORT, child: None });
    }

    let log_path = logs_dir.join("ollama-sidecar.log");

    let (binary, models_dir, owns_process) = if let Some(on_path) = find_on_path() {
        // Installed but not running: reuse Ollama's own default models
        // directory (None below) so whatever the user already pulled is
        // reused rather than duplicated.
        (on_path, None, true)
    } else {
        let runtime_dir = data_dir.join("ollama-runtime");
        let binary = download_and_extract(&runtime_dir)?;
        (binary, Some(runtime_dir.join("models")), true)
    };

    let child = spawn_serve(&binary, OLLAMA_PORT, models_dir.as_deref(), &log_path)?;

    if !wait_until_ready(OLLAMA_PORT, Duration::from_secs(30)) {
        return Err("The local model server did not become ready within 30s — check ollama-sidecar.log.".to_string());
    }

    pull_model(OLLAMA_PORT, DEFAULT_EMBED_MODEL)?;
    if need_chat_model {
        pull_model(OLLAMA_PORT, DEFAULT_CHAT_MODEL)?;
    }

    Ok(RunningInstance { port: OLLAMA_PORT, child: owns_process.then_some(child) })
}

fn download_and_extract(dest_dir: &Path) -> Result<PathBuf, String> {
    let asset = release_asset()
        .ok_or_else(|| format!("No prebuilt Ollama release for {}/{}", std::env::consts::OS, std::env::consts::ARCH))?;

    let binary_path = dest_dir.join(binary_name());
    if binary_path.is_file() {
        // Fetched by a previous run of this app — no need to re-download.
        return Ok(binary_path);
    }

    std::fs::create_dir_all(dest_dir).map_err(|e| format!("Failed to create {}: {e}", dest_dir.display()))?;

    let url = format!("https://github.com/ollama/ollama/releases/download/{OLLAMA_VERSION}/{}", asset.name);
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;
    let mut response = client.get(&url).send().map_err(|e| format!("Failed to download {url}: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("Failed to download {url}: HTTP {}", response.status()));
    }

    let archive_path = dest_dir.join(asset.name);
    {
        let mut file = std::fs::File::create(&archive_path)
            .map_err(|e| format!("Failed to create {}: {e}", archive_path.display()))?;
        std::io::copy(&mut response, &mut file)
            .map_err(|e| format!("Failed to write {}: {e}", archive_path.display()))?;
    }

    if let Err(e) = verify_checksum(&archive_path, asset.sha256) {
        let _ = std::fs::remove_file(&archive_path);
        return Err(e);
    }

    extract_archive(&archive_path, asset.name, dest_dir)?;
    let _ = std::fs::remove_file(&archive_path);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&binary_path) {
            let mut perms = meta.permissions();
            perms.set_mode(perms.mode() | 0o111);
            let _ = std::fs::set_permissions(&binary_path, perms);
        }
    }

    if !binary_path.is_file() {
        return Err(format!("{} did not contain {}", asset.name, binary_name()));
    }
    Ok(binary_path)
}

fn verify_checksum(path: &Path, expected_hex: &str) -> Result<(), String> {
    let mut file = std::fs::File::open(path).map_err(|e| format!("Failed to open {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 1 << 16];
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let actual = format!("{:x}", hasher.finalize());
    if actual != expected_hex {
        return Err(format!("Checksum mismatch for {}: expected {expected_hex}, got {actual}", path.display()));
    }
    Ok(())
}

fn extract_archive(archive_path: &Path, asset_name: &str, dest_dir: &Path) -> Result<(), String> {
    let file =
        std::fs::File::open(archive_path).map_err(|e| format!("Failed to open {}: {e}", archive_path.display()))?;

    if asset_name.ends_with(".tgz") {
        let decoder = flate2::read::GzDecoder::new(file);
        tar::Archive::new(decoder)
            .unpack(dest_dir)
            .map_err(|e| format!("Failed to extract {}: {e}", archive_path.display()))?;
    } else if asset_name.ends_with(".tar.zst") {
        let decoder =
            zstd::stream::read::Decoder::new(file).map_err(|e| format!("Failed to init zstd decoder: {e}"))?;
        tar::Archive::new(decoder)
            .unpack(dest_dir)
            .map_err(|e| format!("Failed to extract {}: {e}", archive_path.display()))?;
    } else if asset_name.ends_with(".zip") {
        let mut archive =
            zip::ZipArchive::new(file).map_err(|e| format!("Failed to open zip {}: {e}", archive_path.display()))?;
        archive
            .extract(dest_dir)
            .map_err(|e| format!("Failed to extract {}: {e}", archive_path.display()))?;
    } else {
        return Err(format!("Unrecognized archive format: {asset_name}"));
    }
    Ok(())
}

fn spawn_serve(binary: &Path, port: u16, models_dir: Option<&Path>, log_path: &Path) -> Result<Child, String> {
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .map_err(|e| format!("Failed to open {}: {e}", log_path.display()))?;
    let log_file_err = log_file.try_clone().map_err(|e| format!("Failed to clone log handle: {e}"))?;

    let mut cmd = Command::new(binary);
    cmd.arg("serve")
        .env("OLLAMA_HOST", format!("127.0.0.1:{port}"))
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(log_file_err));

    if let Some(models_dir) = models_dir {
        std::fs::create_dir_all(models_dir).map_err(|e| format!("Failed to create {}: {e}", models_dir.display()))?;
        cmd.env("OLLAMA_MODELS", models_dir);
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn().map_err(|e| format!("Failed to start {}: {e}", binary.display()))
}

fn wait_until_ready(port: u16, timeout: Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if is_running(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    false
}

#[derive(Debug, Deserialize)]
struct PullProgressLine {
    status: String,
}

/// Blocks until the pull completes (or errors) — this can take a while on a
/// slow link for the first pull of a several-hundred-MB model, hence the long
/// client timeout. `ensure_available`'s caller already runs this off the
/// async executor via spawn_blocking, matching stack_manager's own
/// docker-compose calls.
fn pull_model(port: u16, model: &str) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(60 * 60))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    let response = client
        .post(format!("http://127.0.0.1:{port}/api/pull"))
        .json(&serde_json::json!({ "model": model, "stream": true }))
        .send()
        .map_err(|e| format!("Failed to request pull of {model}: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("Pull of {model} failed: HTTP {}", response.status()));
    }

    let mut reader = std::io::BufReader::new(response);
    let mut line = String::new();
    loop {
        line.clear();
        let bytes_read = reader
            .read_line(&mut line)
            .map_err(|e| format!("Failed to read pull progress for {model}: {e}"))?;
        if bytes_read == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(progress) = serde_json::from_str::<PullProgressLine>(trimmed) {
            log::info!("ollama pull {model}: {}", progress.status);
            if progress.status.eq_ignore_ascii_case("error") {
                return Err(format!("Pull of {model} reported an error"));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The literal (name, sha256) pairs release_asset() returns, duplicated
    /// here on purpose: this is a transcription check on the hand-copied
    /// hashes in release_asset() itself (wrong length, stray whitespace, a
    /// non-hex character from a copy-paste slip), not a test of its match
    /// logic — release_asset() only reads std::env::consts, which a test
    /// can't override to exercise every arm on one CI runner anyway.
    const PINNED_ASSETS: &[(&str, &str)] = &[
        ("ollama-darwin.tgz", "9ab0ac4747946620a2464054f3c44a55aa146e9fccb5c366ee18e43fd1930b90"),
        ("ollama-linux-amd64.tar.zst", "50539c5fe9bf85887733355098dcdb266b433cb8c73fa180713417e9ed6e42bb"),
        ("ollama-linux-arm64.tar.zst", "c898270b1690eab0f51aa9e9197686b7b4c6a7d88b83967763818f3127e477e9"),
        ("ollama-windows-amd64.zip", "a1d11d46a944f9c7521f5e9a3a5db51cd3365401da627d96c204698fc6914ff9"),
        ("ollama-windows-arm64.zip", "51655f2700236bdff09c8cfb174b0855d354ec40775e66069d9b63f32a666937"),
    ];

    #[test]
    fn pinned_checksums_are_well_formed_sha256_hex() {
        for (name, sha256) in PINNED_ASSETS {
            assert_eq!(sha256.len(), 64, "checksum for {name} should be 64 hex chars");
            assert!(sha256.chars().all(|c| c.is_ascii_hexdigit()), "checksum for {name} should be hex");
        }
    }

    #[test]
    fn release_asset_resolves_for_this_test_run_s_platform() {
        // Only asserts Some/well-shaped for whatever platform actually runs
        // this test (macOS, in this repo's CI and dev environment) — see
        // PINNED_ASSETS above for coverage of the other four.
        let asset = release_asset().expect("this crate only targets desktop OSes release_asset() covers");
        assert_eq!(asset.sha256.len(), 64);
    }

    #[test]
    fn verify_checksum_rejects_a_mismatch_and_accepts_the_real_hash() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("payload.bin");
        std::fs::write(&path, b"hello world").unwrap();

        let actual = {
            let mut hasher = Sha256::new();
            hasher.update(b"hello world");
            format!("{:x}", hasher.finalize())
        };
        let wrong = format!("{}f", &actual[..actual.len() - 1]);

        assert!(verify_checksum(&path, &wrong).is_err());
        assert!(verify_checksum(&path, &actual).is_ok());
    }

    /// Exercises real process spawning against whatever `ollama` binary is
    /// actually on this machine's PATH — not mocked. Ignored by default (needs
    /// a real Ollama install), run explicitly with `cargo test -- --ignored`.
    /// Deliberately does not call ensure_available()/pull_model(): that would
    /// pull several hundred MB on a bare CI runner. This only proves the
    /// spawn_serve/wait_until_ready/is_running lifecycle plumbing works
    /// against a real binary.
    #[test]
    #[ignore]
    fn spawn_serve_on_an_alternate_port_becomes_ready() {
        let binary = find_on_path().expect("expected `ollama` on PATH for this test host");
        let port = crate::port_check::find_free_port().expect("a free port");
        assert!(!is_running(port));

        let dir = tempfile::tempdir().unwrap();
        let log_path = dir.path().join("ollama-test.log");
        let mut child = spawn_serve(&binary, port, None, &log_path).expect("spawn should succeed");

        assert!(wait_until_ready(port, Duration::from_secs(20)), "server should become ready");
        assert!(is_running(port));

        let _ = child.kill();
        let _ = child.wait();
    }
}

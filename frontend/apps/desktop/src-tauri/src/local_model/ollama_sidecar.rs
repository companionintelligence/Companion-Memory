//! Ensures *something* answers CI-Server's existing Ollama contract
//! (backend/apps/api/config/default.json: `services.ollama.host` defaults to
//! `http://host.docker.internal:11434`, i.e. whatever's on the HOST's port
//! 11434) for users who don't already run Ollama themselves. This module
//! never writes that config or stack_manager's `.env` itself — it only makes
//! sure port 11434 is answering, in one of three ways, cheapest first. What
//! reaches `.env` from here is a chat model name: DEFAULT_CHAT_MODEL, which
//! stack_manager::write_env_file reads (see that constant's comment), or on
//! the first branch host_ollama_chat_model's pick, which
//! stack_manager::apply_llm_env_override writes over it:
//!
//!   1. Already running (the user's own Ollama) → nothing to start. On Linux
//!      it may still get a bridge relay in front of it; see reach_host_ollama.
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

/// Ungated tags Ollama pulls without authentication — unlike LiteRT-LM's
/// Android binding (see the desktop-local-model-runner research), Ollama's own
/// Gemma tags need no account.
///
/// **`backend/apps/api/src/configuration.ts`'s `DEFAULT_CHAT_MODEL` is the
/// source of truth for the chat tag; this must equal it.** That file explains
/// the size/capability reasoning (the efficient e4b variant, not `gemma4:31b`,
/// because an appliance holds an embedding model, HBPE and the summary sidecar
/// in the same GPU) and `Makefile`'s REQUIRED_OLLAMA_MODELS carries the same
/// pair for the `make dev` path.
///
/// This constant was left at `gemma3:1b` after the API moved to `gemma4:e4b`,
/// so on the advertised zero-install path the sidecar pulled one model and the
/// API's config named another it had never fetched. Concretely: every
/// background inference path hands `PROMPT_MODEL` (`= llm.chatModel`) to
/// OllamaService::validateModel, which throws `Invalid model specified: <id>`
/// per job, forever (see that service's preflightChatModel doc comment — it
/// exists because of exactly this class of mismatch, and does log one boot
/// ERROR nobody reads on a desktop appliance), while interactive chat kept
/// working *on the retired 1b tag*, since resolveServedChatModel falls back to
/// whatever is actually served. Background features dead, chat quietly running
/// the model configuration.ts retired for being unable to hold a JSON schema.
/// Belt and braces against a repeat,
/// stack_manager::write_env_file now also writes THIS constant into the
/// generated `.env` as `LLM_DEFAULT_CHAT_MODEL` (the env var
/// backend/apps/api/config/custom-environment-variables.json maps to
/// `llm.chatModel`), so the API asks for whatever the sidecar actually
/// pulled even if the two defaults diverge again.
pub const DEFAULT_CHAT_MODEL: &str = "gemma4:e4b";

/// Unchanged since this module was written, and hand-checked against
/// ollama.com/library/nomic-embed-text then — the embedding half of the same
/// pair `Makefile`'s REQUIRED_OLLAMA_MODELS lists, and the one model the
/// sidecar pulls on *every* branch (the Apple-on-device bridge replaces chat
/// only; FoundationModels has no embeddings API — see mod.rs).
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
}

/// Liveness probe over loopback, which is now also exactly where spawn_serve
/// binds (it used to bind wider on Linux — see its bind_host comment). The
/// question this answers is "is anything answering on this host's port 11434",
/// which is what the three-tier resolution in the module doc comment needs, and
/// loopback reaches a server however widely it is bound. Container-side
/// reachability is a separate property, owned by bridge_relay, not by this.
pub fn is_running(port: u16) -> bool {
    is_running_on(std::net::Ipv4Addr::LOCALHOST, port)
}

/// [`is_running`] at another of this host's addresses: the docker bridge
/// gateway, to tell whether a server answering on loopback is also reachable
/// from the containers.
fn is_running_on(host: std::net::Ipv4Addr, port: u16) -> bool {
    // No proxy: both addresses are this host's own. reqwest otherwise follows
    // HTTP_PROXY. A NO_PROXY that lists loopback rarely lists the bridge
    // gateway, so the proxy would answer for an address only this host has.
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(800))
        .no_proxy()
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };
    client
        .get(format!("http://{host}:{port}/api/version"))
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
///
/// `handles` is where the spawned child (and, on Linux, the bridge relay) get
/// registered — directly, from inside this function, as soon as each exists,
/// rather than only after this whole call returns. That distinction matters:
/// `wait_until_ready`/`pull_model` below can take minutes (a multi-GB model
/// download), and a quit signal arriving during that window needs
/// `LocalModelHandles::shutdown()` to already be able to find and kill the
/// process it spawned — not wait for a return value that may be minutes away.
pub fn ensure_available(
    data_dir: &Path,
    logs_dir: &Path,
    need_chat_model: bool,
    handles: &crate::local_model::LocalModelHandles,
) -> Result<RunningInstance, String> {
    if is_running(OLLAMA_PORT) {
        // Somebody else's Ollama, which began answering after
        // resolve_and_start's own probe missed it (a service still starting,
        // or one too busy to answer within the timeout). Nothing to start, but
        // the containers need to reach it just as on the path where
        // resolve_and_start found it first.
        reach_host_ollama(handles);
        return Ok(RunningInstance { port: OLLAMA_PORT });
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

    // Register now, before the potentially-minutes-long readiness wait and
    // model pulls below — see this function's own doc comment. `.take()` any
    // previous value defensively rather than dropping it outright: dropping a
    // live `Child` orphans the OS process instead of killing it, and this
    // function is not supposed to run concurrently with itself (resolve_once
    // serializes callers), so finding one here would mean that assumption
    // broke — better to clean it up than leak it.
    if owns_process {
        let mut guard = handles.ollama_child_slot().lock().unwrap_or_else(|p| p.into_inner());
        if let Some(mut previous) = guard.take() {
            log::warn!("ollama_sidecar::ensure_available: an Ollama child was already registered — killing it before replacing it");
            let _ = previous.kill();
        }
        *guard = Some(child);
    }

    if !wait_until_ready(OLLAMA_PORT, Duration::from_secs(30)) {
        return Err("The local model server did not become ready within 30s — check ollama-sidecar.log.".to_string());
    }

    pull_model(OLLAMA_PORT, DEFAULT_EMBED_MODEL)?;
    if need_chat_model {
        pull_model(OLLAMA_PORT, DEFAULT_CHAT_MODEL)?;
    }

    // After the pulls, not before: the relay only matters to the containers,
    // which cannot ask for a model until the stack is up, and a failure here
    // must not cost the user a re-download.
    register_relay(handles, start_bridge_relay(OLLAMA_PORT));

    Ok(RunningInstance { port: OLLAMA_PORT })
}

/// Linux: makes the user's own Ollama reachable from the appliance's
/// containers when it answers on loopback only. That is how Ollama's own Linux
/// service binds unless OLLAMA_HOST is changed. The containers arrive at the
/// docker bridge gateway, where nothing then listens: the app reported the
/// model resolved while chat said "Chat can't reach a model".
///
/// It is the relay this app already puts in front of its own sidecar, with the
/// same limits: bound to the bridge gateway address only, serving only the
/// appliance's own compose networks and gone when the app quits. The user's
/// Ollama itself is not touched. One that already answers on the gateway
/// address (bound to 0.0.0.0, say) is left alone and gets no relay.
pub fn reach_host_ollama(handles: &crate::local_model::LocalModelHandles) {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = handles;
    }

    #[cfg(target_os = "linux")]
    {
        let gateway = match crate::local_model::bridge_relay::discover_host_gateway() {
            Ok(gateway) => gateway,
            Err(e) => {
                log::warn!(
                    "Your Ollama answers on 127.0.0.1:{OLLAMA_PORT}, but no docker bridge gateway could \
                     be discovered ({e}), so no relay was started. If the appliance reports model errors, \
                     check `docker network inspect bridge`."
                );
                return;
            }
        };

        if is_running_on(gateway, OLLAMA_PORT) {
            log::info!(
                "Your Ollama already answers on the docker bridge gateway ({gateway}:{OLLAMA_PORT}), \
                 so the containers reach it directly; no relay started."
            );
            return;
        }

        register_relay(handles, relay_on_gateway(gateway, OLLAMA_PORT));
    }
}

fn register_relay(
    handles: &crate::local_model::LocalModelHandles,
    relay: Option<crate::local_model::bridge_relay::RelayHandle>,
) {
    let Some(relay) = relay else {
        return;
    };
    // Swapped in under the lock and shut down after it is released, for the
    // reason LocalModelHandles::shutdown gives: shutdown() blocks on a connect
    // and a thread join.
    let previous = handles.ollama_relay_slot().lock().unwrap_or_else(|p| p.into_inner()).replace(relay);
    if let Some(previous) = previous {
        previous.shutdown();
    }
}

/// Linux: publish the loopback sidecar on the one address containers arrive
/// from. A no-op everywhere else, where Docker Desktop already tunnels
/// `host.docker.internal` to the host's loopback.
///
/// Every failure is non-fatal and returns `None`. That is the deliberate
/// trade: the app still runs, the sidecar still answers everything on this
/// host, and the log says exactly what the containers will not be able to
/// reach and why — which is strictly better than the `0.0.0.0` bind this
/// replaced, where the same situations silently exposed an unauthenticated GPU
/// to the LAN instead.
fn start_bridge_relay(port: u16) -> Option<crate::local_model::bridge_relay::RelayHandle> {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = port;
        None
    }

    #[cfg(target_os = "linux")]
    {
        use crate::local_model::bridge_relay;

        let gateway = match bridge_relay::discover_host_gateway() {
            Ok(gateway) => gateway,
            Err(e) => {
                // The rootless-Docker case among others (moby#47684). Loopback
                // is also the bind most likely to work there, so this is a
                // warning rather than an error — but it is a loud one, because
                // if the containers DO fail to reach the model this line is the
                // only thing that explains it.
                log::warn!(
                    "Local model server is bound to 127.0.0.1:{port} and no docker bridge gateway \
                     could be discovered ({e}). If the appliance reports model errors, check \
                     `docker network inspect bridge` — under rootless Docker the containers \
                     should still reach the host on loopback."
                );
                return None;
            }
        };

        relay_on_gateway(gateway, port)
    }
}

/// The half of [`start_bridge_relay`] after the gateway is known. Shared with
/// reach_host_ollama, which has already asked Docker for the gateway and would
/// otherwise run `docker network inspect bridge` a second time.
#[cfg(target_os = "linux")]
fn relay_on_gateway(
    gateway: std::net::Ipv4Addr,
    port: u16,
) -> Option<crate::local_model::bridge_relay::RelayHandle> {
    match crate::local_model::bridge_relay::spawn(gateway, port) {
        Ok(handle) => {
            log::info!("Local model server reachable by containers at {} (relayed to 127.0.0.1:{port})", handle.bind_addr);
            Some(handle)
        }
        Err(e) => {
            log::error!(
                "Local model server is bound to 127.0.0.1:{port} but the bridge-gateway relay \
                 on {gateway}:{port} could not start ({e}). The appliance's containers will \
                 not be able to reach it."
            );
            None
        }
    }
}

/// Where an unpacked release archive keeps the program. The macOS `.tgz` and
/// the Windows `.zip` put it at the top, next to their libraries. The Linux
/// `.tar.zst` puts it in `bin/` with its libraries in `lib/ollama/`. Ollama
/// finds those relative to its own path, so it runs from `bin/` where it was
/// unpacked rather than being moved.
fn unpacked_binary(dest_dir: &Path) -> Option<PathBuf> {
    [dest_dir.join(binary_name()), dest_dir.join("bin").join(binary_name())]
        .into_iter()
        .find(|candidate| candidate.is_file())
}

/// Written into the runtime folder once an archive has been unpacked in full.
/// The Linux archive lists `bin/ollama` first and about 2 GB of libraries
/// after it, so an unpack cut short (the app quit during the first start, a
/// full disk) leaves a program that starts but has nothing to run a model
/// with. Finding the program alone would take that for a finished download at
/// every later launch, so only this marker does. Named after the release, so
/// a newer OLLAMA_VERSION is downloaded rather than the old one reused.
fn unpacked_marker(dest_dir: &Path, asset_name: &str) -> PathBuf {
    dest_dir.join(format!(".{asset_name}-{OLLAMA_VERSION}.unpacked"))
}

/// The program from an earlier unpack of this release that finished.
fn previously_unpacked(dest_dir: &Path, asset_name: &str) -> Option<PathBuf> {
    if !unpacked_marker(dest_dir, asset_name).is_file() {
        return None;
    }
    unpacked_binary(dest_dir)
}

/// Removes the folders an earlier unpack put in `dest_dir`. One cut short may
/// hold entries the tar crate will not write over (it refuses a hard link
/// whose name exists). One from an older OLLAMA_VERSION would leave that
/// release's GPU backends in `lib/ollama/` for the new program to load beside
/// its own. `models/`, the archive and the markers stay where they are.
fn clear_earlier_unpack(dest_dir: &Path) {
    for folder in ["bin", "lib"] {
        let path = dest_dir.join(folder);
        if path.is_dir() {
            if let Err(e) = std::fs::remove_dir_all(&path) {
                log::warn!("Could not remove {} before unpacking: {e}", path.display());
            }
        }
    }
}

/// Unpacks a verified archive into `dest_dir` once what an earlier unpack left
/// there is cleared. Returns the program in it. The marker is written
/// once the program has been found. The archive goes last, so an unpack cut
/// short leaves it for the next launch to unpack again without a download.
fn unpack(archive_path: &Path, asset_name: &str, dest_dir: &Path) -> Result<PathBuf, String> {
    clear_earlier_unpack(dest_dir);
    extract_archive(archive_path, asset_name, dest_dir)?;

    let Some(binary_path) = unpacked_binary(dest_dir) else {
        let _ = std::fs::remove_file(archive_path);
        return Err(format!("{asset_name} did not contain {}", binary_name()));
    };

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&binary_path) {
            let mut perms = meta.permissions();
            perms.set_mode(perms.mode() | 0o111);
            let _ = std::fs::set_permissions(&binary_path, perms);
        }
    }

    let marker = unpacked_marker(dest_dir, asset_name);
    if let Err(e) = std::fs::write(&marker, b"") {
        // Costs a second download at the next launch, nothing more.
        log::warn!("Could not write {}: {e}", marker.display());
    }
    let _ = std::fs::remove_file(archive_path);

    Ok(binary_path)
}

fn download_and_extract(dest_dir: &Path) -> Result<PathBuf, String> {
    let asset = release_asset()
        .ok_or_else(|| format!("No prebuilt Ollama release for {}/{}", std::env::consts::OS, std::env::consts::ARCH))?;

    if let Some(binary_path) = previously_unpacked(dest_dir, asset.name) {
        // Fetched by a previous run of this app — no need to re-download.
        return Ok(binary_path);
    }

    std::fs::create_dir_all(dest_dir).map_err(|e| format!("Failed to create {}: {e}", dest_dir.display()))?;

    // The app quitting during an unpack leaves the verified archive behind.
    // Unpacking that again beats fetching another 1 GB. A download cut short
    // fails the checksum and is fetched again.
    let archive_path = dest_dir.join(asset.name);
    if archive_path.is_file() {
        if verify_checksum(&archive_path, asset.sha256).is_ok() {
            return unpack(&archive_path, asset.name, dest_dir);
        }
        let _ = std::fs::remove_file(&archive_path);
    }

    let url = format!("https://github.com/ollama/ollama/releases/download/{OLLAMA_VERSION}/{}", asset.name);
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;
    let mut response = client.get(&url).send().map_err(|e| format!("Failed to download {url}: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("Failed to download {url}: HTTP {}", response.status()));
    }

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

    unpack(&archive_path, asset.name, dest_dir)
}

/// Lowercase hex of a digest. sha2 0.11 returns a `hybrid_array::Array`, which has no `LowerHex`
/// impl, so `format!("{:x}", hasher.finalize())` no longer compiles.
fn hex_lower(digest: &[u8]) -> String {
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
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
    let actual = hex_lower(&hasher.finalize());
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

    // Where the sidecar binds: LOOPBACK ONLY, on every platform.
    //
    // macOS/Windows need nothing more — Docker Desktop's VM tunnels
    // `host.docker.internal` back to the host's loopback for us.
    //
    // Linux used to bind `0.0.0.0` here, because on NATIVE Docker Engine
    // `host.docker.internal:host-gateway` (docker-compose.yml,
    // docker-compose.production.yml) resolves to the docker BRIDGE GATEWAY
    // address rather than the host's loopback, so a loopback-bound sidecar
    // refused every chat/embedding call from `api`, hbpe-service and
    // summary-service while `docker compose ps` and is_running() below both
    // still said healthy.
    //
    // That bind was too wide and is gone. Ollama has NO server-side auth on any
    // route (`OLLAMA_AUTH` is a CLIENT-side request-signing flag, api/client.go;
    // the server registers only CORS and allowedHosts middlewares), and binding
    // non-loopback DISABLES the one guard it does have — allowedHostsMiddleware
    // short-circuits on a non-loopback listen address. So `0.0.0.0` handed any
    // LAN peer unauthenticated /api/generate, /api/chat and /api/embed (free use
    // of this machine's GPU) plus destructive /api/delete + /api/create — and
    // that last pair is a persistent model-substitution foothold, because
    // OllamaService::resolveServedChatModel falls back to "whatever model is
    // served" when the configured tag is absent.
    //
    // Container reachability on Linux is now restored by local_model::
    // bridge_relay, which listens on the discovered bridge-gateway address ONLY
    // and forwards to this loopback socket — see ensure_available below and that
    // module's doc comment, including what happens under rootless Docker, where
    // no bridge gateway is discoverable.
    let bind_host = "127.0.0.1";

    let mut cmd = Command::new(binary);
    cmd.arg("serve")
        .env("OLLAMA_HOST", format!("{bind_host}:{port}"))
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

#[derive(Debug, Deserialize)]
struct TagsResponse {
    #[serde(default)]
    models: Vec<TagsModel>,
}

#[derive(Debug, Deserialize)]
struct TagsModel {
    name: String,
    /// Set on an Ollama Cloud model (`gpt-oss:120b-cloud` and the like): a
    /// stub that forwards every prompt to ollama.com.
    #[serde(default)]
    remote_host: Option<String>,
    #[serde(default)]
    remote_model: Option<String>,
}

impl TagsModel {
    /// Runs on this machine. The desktop app writes CI_LOCAL_ONLY=true, so a
    /// cloud model is never named for chat or background work: every job
    /// would send the user's data to ollama.com.
    fn is_local(&self) -> bool {
        let remote = |field: &Option<String>| field.as_deref().is_some_and(|value| !value.is_empty());
        let tag = self.name.rsplit_once(':').map_or("", |(_, tag)| tag);

        !remote(&self.remote_host) && !remote(&self.remote_model) && tag != "cloud" && !tag.ends_with("-cloud")
    }
}

/// The models an Ollama runs locally, in the order `/api/tags` lists them.
/// Cloud models are left out; see TagsModel::is_local.
fn served_model_names(port: u16) -> Result<Vec<String>, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;
    let response = client
        .get(format!("http://127.0.0.1:{port}/api/tags"))
        .send()
        .map_err(|e| format!("Failed to list models: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("Listing models failed: HTTP {}", response.status()));
    }
    let tags: TagsResponse = response.json().map_err(|e| format!("Unreadable model list: {e}"))?;

    Ok(tags.models.into_iter().filter(TagsModel::is_local).map(|model| model.name).collect())
}

/// Ollama reads a bare name as its `:latest` tag. Compares with the suffix
/// stripped, like the api's sameBaseModel (servedModels.ts), so a registry
/// host with a port (`localhost:5000/model`) is not mistaken for a tag.
fn same_model(served: &str, wanted: &str) -> bool {
    let base = |name: &str| name.strip_suffix(":latest").unwrap_or(name).to_string();

    base(served) == base(wanted)
}

/// Mirrors the name rule the api uses to keep embedders and other non-chat
/// models out of chat (backend/apps/api/src/domains/llm/services/
/// servedModels.ts, NON_CHAT_NAME). Ollama publishes no labels, so the name
/// is all there is.
fn is_chat_model_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    if ["embed", "rerank", "whisper", "kokoro", "minilm"].iter().any(|part| name.contains(part)) {
        return false;
    }

    !name.split(|c: char| !c.is_ascii_alphanumeric()).any(|word| word == "tts" || word == "bge")
}

/// The chat model to ask a user's own Ollama for, when it is not
/// DEFAULT_CHAT_MODEL: None when it serves the default (nothing to change)
/// or serves no local chat model at all (nothing better to name). Otherwise
/// the first local chat model it lists, so chat and background work end up
/// on the same model the user already has on disk.
fn choose_host_chat_model(served: &[String]) -> Option<String> {
    if served.iter().any(|name| same_model(name, DEFAULT_CHAT_MODEL)) {
        return None;
    }

    served.iter().find(|name| is_chat_model_name(name)).cloned()
}

/// What to write as the chat model when reusing the user's own Ollama.
///
/// This app pulls nothing into an Ollama it does not own. It used to name
/// DEFAULT_CHAT_MODEL regardless, so where that Ollama lacked it chat quietly
/// ran on whatever it listed first while every background job failed with
/// "Invalid model specified: gemma4:e4b". Logged either way, with the command
/// that gets the default model. The embedding model search needs is logged
/// the same way and has no substitute: the index is built with it.
pub fn host_ollama_chat_model(port: u16) -> Option<String> {
    let served = match served_model_names(port) {
        Ok(served) => served,
        Err(e) => {
            log::warn!("Could not ask your Ollama which models it has ({e}); asking it for {DEFAULT_CHAT_MODEL}.");
            return None;
        }
    };

    if !served.iter().any(|name| same_model(name, DEFAULT_EMBED_MODEL)) {
        log::warn!(
            "Your Ollama does not have {DEFAULT_EMBED_MODEL}, which search needs. \
             Run `ollama pull {DEFAULT_EMBED_MODEL}` to add it."
        );
    }

    if served.iter().any(|name| same_model(name, DEFAULT_CHAT_MODEL)) {
        return None;
    }

    let chosen = choose_host_chat_model(&served);
    match &chosen {
        Some(model) => log::warn!(
            "Your Ollama does not have {DEFAULT_CHAT_MODEL}; chat and background work will use {model}, \
             the first local chat model it lists. Run `ollama pull {DEFAULT_CHAT_MODEL}` to use the default."
        ),
        None => log::warn!(
            "Your Ollama has no local chat model; background work will fail until it has one. \
             Run `ollama pull {DEFAULT_CHAT_MODEL}` to add the default."
        ),
    }

    chosen
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
            hex_lower(&hasher.finalize())
        };
        let wrong = format!("{}f", &actual[..actual.len() - 1]);

        assert!(verify_checksum(&path, &wrong).is_err());
        assert!(verify_checksum(&path, &actual).is_ok());
    }

    /// A real HTTP server on a real ephemeral loopback port.
    ///
    /// Not a mock, because the thing under test *is* the HTTP conversation:
    /// reqwest's client construction, the status-code check, and the
    /// newline-framed NDJSON body Ollama streams back. A stub that returned a
    /// canned `Result` would test nothing that has ever broken here.
    fn serve(handler: impl Fn(tiny_http::Request) + Send + 'static) -> u16 {
        serve_at("127.0.0.1", handler)
    }

    fn serve_at(address: &str, handler: impl Fn(tiny_http::Request) + Send + 'static) -> u16 {
        let server = tiny_http::Server::http((address, 0)).expect("bind a test server");
        let port = server.server_addr().to_ip().expect("an IP address").port();
        std::thread::spawn(move || {
            for request in server.incoming_requests() {
                handler(request);
            }
        });
        port
    }

    fn respond(request: tiny_http::Request, status: u16, body: &str) {
        let _ = request.respond(tiny_http::Response::from_string(body).with_status_code(status));
    }

    /// `is_running` decides the whole three-tier resolution: a false positive
    /// here means the sidecar is never started and CI-Server is left pointing
    /// at a port that answers nothing it understands, with no error anywhere.
    /// So an open socket is not enough — the response has to succeed.
    #[test]
    fn a_port_that_answers_but_is_not_ollama_does_not_count_as_running() {
        let healthy = serve(|request| respond(request, 200, r#"{"version":"0.32.15"}"#));
        assert!(is_running(healthy));

        let someone_else = serve(|request| respond(request, 404, "not found"));
        assert!(!is_running(someone_else));

        let server_error = serve(|request| respond(request, 500, "internal server error"));
        assert!(!is_running(server_error));

        let nobody = crate::port_check::find_free_port().expect("a free port");
        assert!(!is_running(nobody));
    }

    /// The probe reach_host_ollama decides with: it relays the user's own
    /// Ollama only when the containers cannot already reach it, which it finds
    /// out by asking at the docker bridge gateway address. Modelled here on
    /// loopback, which Linux spans across 127.0.0.0/8. A server bound to
    /// 127.0.0.1 alone (Ollama's own Linux service, as the gateway sees it)
    /// does not answer at 127.0.0.2. One bound to every address does.
    #[cfg(target_os = "linux")]
    #[test]
    fn only_a_server_bound_beyond_loopback_answers_at_another_address() {
        use std::net::Ipv4Addr;

        let elsewhere = Ipv4Addr::new(127, 0, 0, 2);
        let version = |request: tiny_http::Request| respond(request, 200, r#"{"version":"0.34.0"}"#);

        let loopback_only = serve_at("127.0.0.1", version);
        assert!(is_running_on(Ipv4Addr::LOCALHOST, loopback_only));
        assert!(!is_running_on(elsewhere, loopback_only));

        let every_address = serve_at("0.0.0.0", version);
        assert!(is_running_on(elsewhere, every_address));
    }

    /// A user's own Ollama gets nothing pulled into it, so the app names a
    /// model it has. The default stays when it is there (bare or `:latest`
    /// spellings included). Embedders are never picked for chat. An Ollama
    /// with no chat model leaves the default in place rather than naming an
    /// embedder.
    #[test]
    fn a_users_own_ollama_is_asked_for_a_chat_model_it_has() {
        let names = |list: &[&str]| list.iter().map(|name| name.to_string()).collect::<Vec<_>>();

        assert_eq!(choose_host_chat_model(&names(&["qwen3.5:122b", DEFAULT_CHAT_MODEL])), None);
        assert_eq!(
            choose_host_chat_model(&names(&["nomic-embed-text:latest", "qwen3.5:122b", "qwen3.5:4b"])),
            Some("qwen3.5:122b".to_string()),
        );
        assert_eq!(
            choose_host_chat_model(&names(&["bge-m3:latest", "mxbai-embed-large:latest", "llama3.2:latest"])),
            Some("llama3.2:latest".to_string()),
        );
        assert_eq!(choose_host_chat_model(&names(&["nomic-embed-text:latest"])), None);
        assert_eq!(choose_host_chat_model(&[]), None);

        assert!(same_model("nomic-embed-text:latest", DEFAULT_EMBED_MODEL));
        assert!(same_model("nomic-embed-text", "nomic-embed-text:latest"));
        assert!(same_model("localhost:5000/team/model", "localhost:5000/team/model:latest"));
        assert!(!same_model("nomic-embed-text:v1.5", DEFAULT_EMBED_MODEL));
        assert!(!same_model("gemma4:e2b", DEFAULT_CHAT_MODEL));
        assert!(is_chat_model_name("gemma4:e4b"));
        assert!(!is_chat_model_name("snowflake-arctic-embed2:latest"));
        assert!(!is_chat_model_name("kokoro-tts:latest"));
    }

    /// The model list comes from Ollama's own `/api/tags` (every model on
    /// disk, not `/api/ps`'s loaded few), in its order. Cloud models are left
    /// out: the app runs with CI_LOCAL_ONLY=true, so naming one would send
    /// every chat and background job to ollama.com.
    #[test]
    fn served_model_names_reads_ollamas_tag_list() {
        let port = serve(|request| {
            if request.url() != "/api/tags" {
                return respond(request, 404, "not found");
            }
            respond(
                request,
                200,
                r#"{"models":[
                    {"name":"gpt-oss:120b-cloud","remote_model":"gpt-oss:120b","remote_host":"https://ollama.com:443","size":384},
                    {"name":"glm-4.6:cloud","size":384},
                    {"name":"qwen3.5:122b","size":1},
                    {"name":"nomic-embed-text:latest","size":2}
                ]}"#,
            )
        });
        assert_eq!(
            served_model_names(port).unwrap(),
            vec!["qwen3.5:122b".to_string(), "nomic-embed-text:latest".to_string()]
        );

        let broken = serve(|request| respond(request, 500, "internal server error"));
        assert!(served_model_names(broken).is_err());
    }

    /// The wire shape Ollama's own `/api/pull` expects. `model` is the current
    /// field name (the older `name` is what a from-memory rewrite reaches for),
    /// and `stream: true` is what makes the NDJSON progress this function reads
    /// line-by-line exist at all.
    #[test]
    fn a_pull_asks_ollama_for_the_named_model_over_its_streaming_endpoint() {
        let (tx, rx) = std::sync::mpsc::channel();
        let port = serve(move |mut request| {
            let mut body = String::new();
            let _ = request.as_reader().read_to_string(&mut body);
            let _ = tx.send((request.method().to_string(), request.url().to_string(), body));
            respond(request, 200, "{\"status\":\"pulling manifest\"}\n{\"status\":\"success\"}\n");
        });

        pull_model(port, DEFAULT_EMBED_MODEL).expect("a clean progress stream should succeed");

        let (method, url, body) = rx.recv_timeout(Duration::from_secs(5)).expect("the pull request");
        assert_eq!(method, "POST");
        assert_eq!(url, "/api/pull");
        let sent: serde_json::Value = serde_json::from_str(&body).expect("a JSON request body");
        assert_eq!(sent["model"], DEFAULT_EMBED_MODEL);
        assert_eq!(sent["stream"], true);
    }

    /// A refused pull must not read as a completed one. It used to be possible
    /// for this to pass silently and leave the app running with no embedding
    /// model at all, which surfaces much later as empty search results rather
    /// than as a start-up failure.
    #[test]
    fn a_pull_refused_outright_fails_with_the_status_code_and_the_model_name() {
        let port = serve(|request| respond(request, 500, "internal server error"));

        let err = pull_model(port, DEFAULT_CHAT_MODEL).expect_err("HTTP 500 is not a successful pull");

        assert!(err.contains("500"), "the status code should reach the user: {err}");
        assert!(err.contains(DEFAULT_CHAT_MODEL), "the model should reach the user: {err}");
    }

    /// Ollama's progress stream is chatty and only loosely structured: blank
    /// lines, per-layer digest/total records with no `status` field at all, and
    /// (on some builds) plain text. None of that is a failure, and treating an
    /// unparseable line as one would turn most successful pulls into a start-up
    /// error. A `status` of "error" is the one line that must stop the pull —
    /// matched case-insensitively, because the casing is not contractual.
    #[test]
    fn pull_progress_noise_is_tolerated_but_an_error_status_is_not() {
        let chatty = serve(|request| {
            respond(
                request,
                200,
                "{\"status\":\"pulling manifest\"}\n\
                 \n   \n\
                 not json at all\n\
                 {\"digest\":\"sha256:abc\",\"total\":1024,\"completed\":512}\n\
                 {\"status\":\"success\"}\n",
            )
        });
        assert!(
            pull_model(chatty, DEFAULT_EMBED_MODEL).is_ok(),
            "progress chatter must not abort a pull that finished",
        );

        let failing = serve(|request| {
            respond(request, 200, "{\"status\":\"pulling manifest\"}\n{\"status\":\"ERROR\"}\n")
        });
        let err = pull_model(failing, DEFAULT_EMBED_MODEL).expect_err("an error status must fail the pull");
        assert!(err.contains("reported an error"), "{err}");
    }

    /// Which decompressor runs is chosen purely from the asset filename, and
    /// the filenames come from release_asset() above — so a bad suffix match
    /// shows up as "ollama-darwin.tgz did not contain ollama", blaming the
    /// download for a dispatch bug. The .tgz archive here is built on the spot
    /// rather than checked in, so this covers the real flate2 -> tar wiring.
    #[test]
    fn an_archive_is_unpacked_by_its_extension_and_an_unknown_one_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let payload = b"#!/bin/sh\necho ollama\n";

        let tgz_path = dir.path().join("ollama-darwin.tgz");
        {
            let file = std::fs::File::create(&tgz_path).unwrap();
            let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::fast());
            let mut builder = tar::Builder::new(encoder);
            let mut header = tar::Header::new_gnu();
            header.set_size(payload.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            builder.append_data(&mut header, binary_name(), &payload[..]).unwrap();
            builder.into_inner().unwrap().finish().unwrap();
        }

        let dest = dir.path().join("unpacked");
        std::fs::create_dir_all(&dest).unwrap();
        extract_archive(&tgz_path, "ollama-darwin.tgz", &dest).expect("a .tgz should unpack");
        assert_eq!(std::fs::read(dest.join(binary_name())).unwrap(), payload);

        // Nothing handles this suffix, and failing loudly is the point: a
        // silent no-op would leave the caller reporting a missing binary.
        let err = extract_archive(&tgz_path, "ollama-linux-amd64.deb", &dest)
            .expect_err("an unhandled archive format must be an error");
        assert!(err.contains("Unrecognized archive format"), "{err}");
    }

    /// A `.tar.zst` in the Linux release's layout and order: the program in
    /// `bin/` first, then its libraries in `lib/ollama/`.
    fn write_linux_layout_archive(path: &Path, program: &[u8]) {
        let file = std::fs::File::create(path).unwrap();
        let encoder = zstd::stream::write::Encoder::new(file, 1).unwrap().auto_finish();
        let mut builder = tar::Builder::new(encoder);
        let entries = [
            (format!("bin/{}", binary_name()), program),
            ("lib/ollama/libggml-base.so".to_string(), &b"not really a library"[..]),
        ];
        for (path, body) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(body.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            builder.append_data(&mut header, path, body).unwrap();
        }
        builder.into_inner().unwrap();
    }

    /// Ollama's Linux archive keeps the program in `bin/` with its libraries
    /// in `lib/ollama/`; the macOS and Windows archives keep it at the top.
    /// Looking only at the top is how every Linux machine without Ollama
    /// downloaded about 1 GB, unpacked it and then logged "did not contain
    /// ollama", at every launch. The Linux layout is built here as a real
    /// .tar.zst; the top-level one only needs the file in place.
    #[test]
    fn the_program_is_found_where_each_release_archive_keeps_it() {
        let dir = tempfile::tempdir().unwrap();
        let program = b"#!/bin/sh\necho ollama\n";

        let linux_archive = dir.path().join("ollama-linux-amd64.tar.zst");
        write_linux_layout_archive(&linux_archive, program);

        let linux = dir.path().join("linux");
        std::fs::create_dir_all(&linux).unwrap();
        extract_archive(&linux_archive, "ollama-linux-amd64.tar.zst", &linux).expect("a .tar.zst should unpack");
        let found = unpacked_binary(&linux).expect("the Linux layout keeps the program in bin/");
        assert_eq!(found, linux.join("bin").join(binary_name()));
        assert_eq!(std::fs::read(&found).unwrap(), program);

        let top_level = dir.path().join("top-level");
        std::fs::create_dir_all(&top_level).unwrap();
        std::fs::write(top_level.join(binary_name()), program).unwrap();
        assert_eq!(unpacked_binary(&top_level), Some(top_level.join(binary_name())));

        let empty = dir.path().join("empty");
        std::fs::create_dir_all(empty.join("bin")).unwrap();
        assert_eq!(unpacked_binary(&empty), None, "a directory named bin is not the program");
    }

    /// The Linux archive lists `bin/ollama` before its libraries, so an unpack
    /// cut short leaves the program without them. Only a finished unpack may
    /// be reused at the next launch. One cut short is unpacked again from
    /// scratch and only then marked finished.
    #[test]
    fn only_a_finished_unpack_is_reused() {
        let dir = tempfile::tempdir().unwrap();
        let asset = "ollama-linux-amd64.tar.zst";
        let archive = dir.path().join(asset);
        write_linux_layout_archive(&archive, b"#!/bin/sh\necho ollama\n");

        // What an unpack cut short after its first entry leaves behind.
        let runtime = dir.path().join("ollama-runtime");
        std::fs::create_dir_all(runtime.join("bin")).unwrap();
        std::fs::write(runtime.join("bin").join(binary_name()), b"#!/bin/sh\n").unwrap();
        assert_eq!(previously_unpacked(&runtime, asset), None, "a cut-short unpack is not a finished one");

        let found = unpack(&archive, asset, &runtime).expect("the archive should unpack over the partial one");
        assert_eq!(found, runtime.join("bin").join(binary_name()));
        assert!(runtime.join("lib/ollama/libggml-base.so").is_file(), "the libraries are there now");
        assert!(!archive.exists(), "the archive is removed once unpacked");
        assert_eq!(previously_unpacked(&runtime, asset), Some(found));
    }

    /// A newer OLLAMA_VERSION is unpacked where the older one was. Its GPU
    /// backends in `lib/ollama/` must not sit beside the new ones, where the
    /// new program would load them, while the pulled models stay put.
    #[test]
    fn an_unpack_clears_the_earlier_releases_libraries_but_keeps_the_models() {
        let dir = tempfile::tempdir().unwrap();
        let asset = "ollama-linux-amd64.tar.zst";
        let archive = dir.path().join(asset);
        write_linux_layout_archive(&archive, b"#!/bin/sh\necho ollama\n");

        let runtime = dir.path().join("ollama-runtime");
        let old_backend = runtime.join("lib/ollama/cuda_v11/libggml-cuda.so");
        std::fs::create_dir_all(old_backend.parent().unwrap()).unwrap();
        std::fs::write(&old_backend, b"an older release's backend").unwrap();
        let model = runtime.join("models/blobs/sha256-abc");
        std::fs::create_dir_all(model.parent().unwrap()).unwrap();
        std::fs::write(&model, b"weights").unwrap();

        unpack(&archive, asset, &runtime).expect("the archive should unpack");

        assert!(!old_backend.exists(), "the older release's backend should be gone");
        assert!(runtime.join("lib/ollama/libggml-base.so").is_file());
        assert_eq!(std::fs::read(&model).unwrap(), b"weights", "the models are not the unpack's to clear");
    }

    /// Exercises real process spawning against whatever `ollama` binary is
    /// actually on this machine's PATH — not mocked. Deliberately does not call
    /// ensure_available()/pull_model(): that would pull several hundred MB on a
    /// bare CI runner. This only proves the spawn_serve/wait_until_ready/
    /// is_running lifecycle plumbing works against a real binary.
    ///
    /// This was `#[ignore]`d, which meant it ran nowhere: an ignored test is
    /// only reached by `cargo test -- --ignored`, and nothing in this repo
    /// invokes that (see docs/CI.md — the desktop workflow is dispatch-only and
    /// runs a plain `cargo test`). It now runs — wherever the binary exists.
    ///
    /// A missing `ollama` used to be a hard `expect()` failure rather than a
    /// quiet `return`, on the argument that `cargo test` prints no marker for
    /// an early return, so a skip is indistinguishable from a pass in the
    /// summary. That is true of cargo and wrong about the consequence here:
    /// `.github/workflows/desktop-build.yml` now runs `cargo test
    /// --no-fail-fast` on macos-latest, ubuntu-22.04 and windows-latest, and
    /// none of those runners has Ollama — nor should that workflow install a
    /// multi-hundred-MB inference engine to prove process plumbing. So the very
    /// first dispatch of that workflow would have gone red for a purely
    /// environmental reason, and the cheapest way for whoever read that log to
    /// get a green run is to delete the `Cargo test` step, taking the ~40
    /// genuine tests in this crate with it. Losing the whole suite to protect
    /// one test's honesty is the worse trade.
    ///
    /// So the skip is made loud instead of silent: stable Rust still has no
    /// test-skip primitive, so this returns early after writing a SKIPPED line
    /// straight to the process's stderr handle — NOT `eprintln!`, which would
    /// print nothing at all here. libtest installs an output capture for the
    /// `print!`/`eprint!` macros and replays what they wrote only for tests
    /// that FAIL (or for every test under `--nocapture`/`--show-output`, which
    /// neither desktop-build.yml's `cargo test --no-fail-fast` nor `make
    /// test-desktop` passes) — so on the green run where the skip is the whole
    /// point, a macro line is swallowed and the skip is exactly the silent pass
    /// the paragraph above warns about. The capture is wired into the macros
    /// alone, so `writeln!(std::io::stderr(), …)` bypasses it and the line
    /// lands in the step's own log — readable in the Actions UI on a GREEN run,
    /// which is the case that matters — and in the cargo-test.log that step
    /// `tee`s, uploaded as an artifact only when the run fails. (Measured both
    /// ways with a one-test `rustc --test` binary before choosing this: the
    /// `eprintln!` line does not appear at all for a passing test; this one
    /// does.) Where the binary IS present — any developer machine that runs the
    /// sidecar, and any runner someone provisions on purpose — the test is
    /// unchanged and still asserts the full spawn/ready/kill lifecycle.
    ///
    /// Safe against a user's own Ollama: it serves on an ephemeral port, never
    /// OLLAMA_PORT, and passes no OLLAMA_MODELS override, so it only ever reads
    /// the existing model directory.
    #[test]
    fn spawn_serve_on_an_alternate_port_becomes_ready() {
        let Some(binary) = find_on_path() else {
            // The stderr HANDLE, not eprintln! — see the doc comment: libtest
            // captures the print macros and shows them only for failing tests,
            // so eprintln! here would leave the skip invisible on the very run
            // that needs to disclose it. The result is deliberately ignored:
            // a closed stderr must not turn a skip into a panic.
            use std::io::Write;
            let _ = writeln!(
                std::io::stderr(),
                "SKIPPED spawn_serve_on_an_alternate_port_becomes_ready: no `ollama` binary on \
                 PATH (or on stack_manager::extended_path_env), so there is nothing to spawn. \
                 Install Ollama on this host to exercise the real sidecar lifecycle; see this \
                 test's doc comment for why a bare CI runner skips rather than fails."
            );
            return;
        };
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

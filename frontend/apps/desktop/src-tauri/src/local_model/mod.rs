//! Makes sure CI-Server's chat + embeddings backend works without requiring
//! the user to separately install and run a full Ollama with big models
//! pulled — the "instead of needing a large LLM from Ollama" ask this whole
//! module exists to answer. Two independent axes, resolved once at startup:
//!
//!   - Embeddings (and chat, unless overridden below) always need *something*
//!     answering CI-Server's existing `services.ollama.host` default
//!     (host.docker.internal:11434) — see ollama_sidecar's module doc comment
//!     for the three-tier resolution (already running / installed-not-running
//!     / download our own copy).
//!   - Chat can instead be handled by Apple's on-device model on macOS, when
//!     available (Apple Silicon, macOS 26+, Apple Intelligence enabled) and
//!     the user doesn't already have their own Ollama running — see
//!     apple_bridge. This only replaces the *chat* model: FoundationModels
//!     has no embeddings API, so embeddings still come from a (much smaller —
//!     no chat weights needed at all) bundled Ollama in that configuration.
//!
//! Deliberately never touches CORS or the native cookie-less CSRF contract —
//! both of those exist for the mobile *thin-client* apps talking to a remote
//! appliance over a real cross-origin boundary. This orchestrator's webview
//! only ever navigates to its own local `gateway` (stack_manager::GATEWAY_PORT),
//! which is same-origin, so none of that applies here.

pub mod ollama_sidecar;

/// Compiled everywhere, used only on Linux — see its module doc comment.
pub mod bridge_relay;

#[cfg(target_os = "macos")]
pub mod apple_bridge;

use std::path::Path;
use std::process::Child;
use std::sync::Mutex;

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatBackend {
    HostOllama,
    AppleOnDevice,
    BundledOllama,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelResolution {
    pub chat_backend: ChatBackend,
    pub detail: String,
}

/// The only thing stack_manager::write_env_file needs from this whole
/// resolution: an LLM_API_BASE/LLM_API_KEY override when (and only when) the
/// Apple bridge is handling chat. Every other outcome relies on CI-Server's
/// existing OLLAMA_HOST default already pointing at 11434 — see the module
/// doc comment.
#[derive(Debug, Clone, Default)]
pub struct LlmEnvOverride {
    pub llm_api_base: Option<String>,
    pub llm_api_key: Option<String>,
}

/// Whether resolve_once has run yet — a second caller returns immediately
/// once this is Done instead of re-resolving (which would mean
/// re-probing/possibly re-downloading, and — see resolve_once's doc comment —
/// re-appending the same `.env` override lines).
enum ResolutionState {
    NotStarted,
    Done,
}

/// Holds whatever child processes this module itself spawned, so main.rs can
/// tear them down on quit. Never holds a handle for an instance we detected
/// but don't own (the user's own pre-existing Ollama).
///
/// Both `ollama_child` and `ollama_relay` are populated by
/// `ollama_sidecar::ensure_available` itself, directly, as soon as each
/// resource exists — not by its caller after the whole (potentially
/// multi-minute, model-download-and-pull) call returns. A quit signal
/// arriving mid-resolution must still be able to find and kill whatever has
/// been spawned so far; populating these fields only on a successful return
/// would leave that window unguarded.
pub struct LocalModelHandles {
    ollama_child: Mutex<Option<Child>>,
    /// Linux only in practice: the bridge-gateway relay in front of the
    /// loopback-bound Ollama sidecar. Held for the same reason as
    /// `ollama_child` — it owns a listening socket that must be released on
    /// quit, or a relaunch cannot bind the gateway address again.
    ollama_relay: Mutex<Option<bridge_relay::RelayHandle>>,
    #[cfg(target_os = "macos")]
    apple_bridge: Mutex<Option<apple_bridge::AppleBridgeHandle>>,
    /// Set once resolution finishes — read by get_local_model_status_command
    /// for the bootstrap page / tray. `None` while resolution is still
    /// running (or hasn't started yet).
    status: Mutex<Option<LocalModelResolution>>,
    /// Guards resolve_once — see its doc comment for why this needs to be a
    /// single serialized gate rather than each caller independently deciding
    /// whether resolution already happened.
    resolution: Mutex<ResolutionState>,
}

impl Default for LocalModelHandles {
    fn default() -> Self {
        Self {
            ollama_child: Mutex::new(None),
            ollama_relay: Mutex::new(None),
            #[cfg(target_os = "macos")]
            apple_bridge: Mutex::new(None),
            status: Mutex::new(None),
            resolution: Mutex::new(ResolutionState::NotStarted),
        }
    }
}

impl LocalModelHandles {
    /// For `ollama_sidecar::ensure_available` to register the child it spawns
    /// directly, as soon as it exists — see this struct's own doc comment for
    /// why that can't wait until `ensure_available` returns.
    pub(crate) fn ollama_child_slot(&self) -> &Mutex<Option<Child>> {
        &self.ollama_child
    }

    /// Same reason as `ollama_child_slot`, for the Linux bridge relay.
    pub(crate) fn ollama_relay_slot(&self) -> &Mutex<Option<bridge_relay::RelayHandle>> {
        &self.ollama_relay
    }

    pub fn shutdown(&self) {
        // Relay first: it holds connections INTO the sidecar, so closing it
        // before killing the process avoids a window where a container's
        // in-flight request is relayed to a pid that is already gone.
        //
        // `.take()` is split onto its own statement, deliberately: an
        // `if let Some(x) = mutex.lock()...take() { ... }` keeps the
        // MutexGuard alive for the whole block in this edition, so
        // `relay.shutdown()` — which blocks on a socket connect and a thread
        // join — would otherwise run while still holding this lock, blocking
        // any other thread (e.g. a status probe) that needs it for as long as
        // shutdown takes. Ending the statement before calling shutdown() lets
        // the guard drop first.
        let relay = self.ollama_relay.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(relay) = relay {
            relay.shutdown();
        }
        let child = self.ollama_child.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(mut child) = child {
            let _ = child.kill();
        }
        #[cfg(target_os = "macos")]
        {
            let handle = self.apple_bridge.lock().unwrap_or_else(|p| p.into_inner()).take();
            if let Some(handle) = handle {
                handle.shutdown();
            }
        }
    }

    pub fn status(&self) -> Option<LocalModelResolution> {
        self.status.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Runs the resolution + startup flow described in the module doc
    /// comment exactly once, no matter how many callers invoke it — both
    /// main.rs's own startup task *and* the bootstrap page's own
    /// start_stack_command call reach this (see main.rs), and the second one
    /// in must block here rather than race the first straight to
    /// `docker compose up`: Compose only re-reads `.env` when a container is
    /// (re)created, so if the loser's `docker compose up` ran first with a
    /// not-yet-finalized `.env`, the LLM_API_BASE override would silently
    /// never take effect for the rest of that container's life.
    ///
    /// Applies the resulting env override itself, on the fresh-resolution
    /// path only — never on a cache hit, since stack_manager::
    /// apply_llm_env_override is a plain append and every later call
    /// (a manual "Start Stack" from the tray, say) would otherwise duplicate
    /// the same LLM_API_BASE/LLM_API_KEY lines into `.env` on every restart.
    ///
    /// Blocking (network calls, subprocess spawns, potentially a
    /// several-hundred-MB download) — call via spawn_blocking, matching every
    /// other stack_manager entry point.
    pub fn resolve_once(&self, paths: &crate::stack_manager::StackPaths, apple_bridge_binary: &Path) -> Result<(), String> {
        let mut resolution = self.resolution.lock().unwrap_or_else(|p| p.into_inner());
        if matches!(&*resolution, ResolutionState::Done) {
            return Ok(());
        }

        let (status, env) = resolve_and_start(&paths.data_dir, &paths.logs_dir, apple_bridge_binary, self)?;
        log::info!("Local model resolved: {:?} — {}", status.chat_backend, status.detail);
        *self.status.lock().unwrap_or_else(|p| p.into_inner()) = Some(status);

        if let Err(e) = crate::stack_manager::apply_llm_env_override(paths, &env) {
            log::error!("Failed to apply local-model env override: {e}");
        }

        *resolution = ResolutionState::Done;
        Ok(())
    }
}

fn resolve_and_start(
    data_dir: &Path,
    logs_dir: &Path,
    apple_bridge_binary: &Path,
    handles: &LocalModelHandles,
) -> Result<(LocalModelResolution, LlmEnvOverride), String> {
    let host_ollama_running = ollama_sidecar::is_running(ollama_sidecar::OLLAMA_PORT);

    let chat_backend = choose_chat_backend(host_ollama_running, || apple_chat_available(apple_bridge_binary));

    // `mut` only on macOS: the Apple-bridge arm just below is the sole writer,
    // and it is compiled out on every other host.
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut env = LlmEnvOverride::default();
    if chat_backend == ChatBackend::AppleOnDevice {
        #[cfg(target_os = "macos")]
        {
            let log_path = logs_dir.join("apple-bridge.log");
            let handle = apple_bridge::spawn(apple_bridge_binary, &log_path)?;
            env.llm_api_base = Some(format!("http://host.docker.internal:{}/v1", handle.port));
            env.llm_api_key = Some("local".to_string());
            *handles.apple_bridge.lock().unwrap_or_else(|p| p.into_inner()) = Some(handle);
        }
    }

    if !host_ollama_running {
        let need_chat_model = chat_backend == ChatBackend::BundledOllama;
        // `handles` is passed through so `ensure_available` can register the
        // child (and, later, the relay) into it directly, as soon as each
        // exists — see LocalModelHandles's own doc comment for why.
        let instance = ollama_sidecar::ensure_available(data_dir, logs_dir, need_chat_model, handles)?;
        log::info!("Local Ollama instance answering on port {}", instance.port);
    } else {
        // Reusing an already-answering instance we did not start — nothing to
        // register in `handles` (we own neither the process nor, on Linux, a
        // relay for it: see ensure_available's own "somebody else's Ollama"
        // comment). Logged, not silent, because this is exactly the case
        // where container reachability now depends entirely on how THAT
        // instance happens to be bound, and there is nothing else here that
        // will say so.
        #[cfg(target_os = "linux")]
        log::info!(
            "An Ollama instance is already answering on port {} — reusing it as-is, no bridge relay \
             started. If the appliance's containers report model errors, this is the instance to check: \
             it needs to be reachable from the docker bridge gateway, which this app made no decision \
             about since it isn't the one that started it.",
            ollama_sidecar::OLLAMA_PORT
        );
    }

    let detail = match chat_backend {
        ChatBackend::HostOllama => "Chat + embeddings: your own local Ollama.".to_string(),
        ChatBackend::AppleOnDevice => {
            format!("Chat: Apple on-device model. Embeddings: bundled {}.", ollama_sidecar::DEFAULT_EMBED_MODEL)
        }
        ChatBackend::BundledOllama => format!(
            "Chat + embeddings: bundled small models ({}, {}).",
            ollama_sidecar::DEFAULT_CHAT_MODEL,
            ollama_sidecar::DEFAULT_EMBED_MODEL
        ),
    };

    Ok((LocalModelResolution { chat_backend, detail }, env))
}

/// Which backend answers chat, split from the probes that feed it so the
/// precedence is testable on any host — the same shape (and the same reason)
/// as stack_manager::choose_docker_host.
///
/// The order is the point. A user who already runs their own Ollama has chosen
/// their models and keeps them; nothing here may quietly move their chat onto
/// Apple's on-device model instead. Apple only wins the fallback, and the
/// bundled small models are the last resort.
///
/// `apple_chat_available` is a closure rather than a `bool` so it stays lazy:
/// on macOS the real probe spawns `ci-apple-bridge --check` as a subprocess,
/// and the first arm's whole job is to make that unnecessary.
fn choose_chat_backend(host_ollama_running: bool, apple_chat_available: impl FnOnce() -> bool) -> ChatBackend {
    if host_ollama_running {
        ChatBackend::HostOllama
    } else if apple_chat_available() {
        ChatBackend::AppleOnDevice
    } else {
        ChatBackend::BundledOllama
    }
}

#[cfg(target_os = "macos")]
fn apple_chat_available(bridge_binary: &Path) -> bool {
    apple_bridge::is_available(bridge_binary)
}

#[cfg(not(target_os = "macos"))]
fn apple_chat_available(_bridge_binary: &Path) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The user's own Ollama outranks everything. Getting this order wrong is
    /// not a crash — the app would come up looking fine while chat silently
    /// ran on a different model than the one the user installed and pulled
    /// weights for, which is the kind of thing nobody reports as a bug.
    #[test]
    fn a_users_own_ollama_outranks_the_apple_on_device_model() {
        assert_eq!(choose_chat_backend(true, || true), ChatBackend::HostOllama);
        assert_eq!(choose_chat_backend(true, || false), ChatBackend::HostOllama);
        assert_eq!(choose_chat_backend(false, || true), ChatBackend::AppleOnDevice);
        assert_eq!(choose_chat_backend(false, || false), ChatBackend::BundledOllama);
    }

    /// The first arm exists precisely so the Apple probe — which spawns
    /// `ci-apple-bridge --check` and waits on it — never runs when the answer
    /// is already known. Turning the closure into an eagerly evaluated `bool`
    /// argument would keep every assertion above passing while adding a
    /// subprocess to every launch on the most common macOS path.
    #[test]
    fn the_apple_probe_is_not_run_once_a_host_ollama_has_answered() {
        let probes = std::cell::Cell::new(0);

        let backend = choose_chat_backend(true, || {
            probes.set(probes.get() + 1);
            true
        });

        assert_eq!(backend, ChatBackend::HostOllama);
        assert_eq!(probes.get(), 0, "the Apple bridge should not have been probed at all");
    }
}

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

/// "Download recommended model" in Settings > Model, for a user's own Ollama.
pub mod recommended;

/// Compiled everywhere, used only on Linux — see its module doc comment.
pub mod bridge_relay;

/// Linux: whether the containers reach the model, checked from inside them.
/// Compiled everywhere, like bridge_relay.
pub mod container_reach;

#[cfg(target_os = "macos")]
pub mod apple_bridge;

use std::path::Path;
use std::process::Child;
use std::sync::{Mutex, TryLockError};

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

/// What stack_manager::write_env_file's `.env` needs changed after this
/// resolution: an LLM_API_BASE/LLM_API_KEY override when (and only when) the
/// Apple bridge is handling chat, or a chat model when the user's own Ollama
/// does not have DEFAULT_CHAT_MODEL. Every other outcome relies on
/// CI-Server's existing OLLAMA_HOST default already pointing at 11434 (see
/// the module doc comment).
#[derive(Debug, Clone, Default)]
pub struct LlmEnvOverride {
    pub llm_api_base: Option<String>,
    pub llm_api_key: Option<String>,
    /// Replaces DEFAULT_CHAT_MODEL as the model chat and background work ask
    /// for. See ollama_sidecar::host_ollama_chat_model.
    pub chat_model: Option<String>,
}

/// Whether resolve_once has run yet — a second caller returns immediately
/// once this is Done instead of re-resolving (which would mean
/// re-probing/possibly re-downloading, and — see resolve_once's doc comment —
/// re-appending the same `.env` override lines).
///
/// A failure is kept too, for the callers that were waiting on it. Two callers
/// reach resolve_once moments apart at every start (main.rs's startup task and
/// the splash's start_stack_command), so forgetting a failure meant the second
/// one, queued behind the first, started the whole resolution over straight
/// away: on Linux without Ollama, a second download of about 1 GB that failed
/// the same way. A caller that arrives after a failure has settled (the
/// splash's Retry, once the network is back) tries again.
enum ResolutionState {
    NotStarted,
    Done,
    Failed(String),
}

impl ResolutionState {
    /// Runs `resolve` unless an earlier call already settled the outcome. A
    /// success is kept for good. A failure is handed to a caller that was
    /// `queued` behind the attempt that failed. A later caller retries it.
    /// `resolve` is told when it is that retry, so it can clear up after the
    /// failed attempt first.
    fn settle(&mut self, queued: bool, resolve: impl FnOnce(bool) -> Result<(), String>) -> Result<(), String> {
        let retrying = match self {
            ResolutionState::Done => return Ok(()),
            ResolutionState::Failed(reason) if queued => return Err(reason.clone()),
            ResolutionState::Failed(_) => true,
            ResolutionState::NotStarted => false,
        };

        let outcome = resolve(retrying);
        *self = match &outcome {
            Ok(()) => ResolutionState::Done,
            Err(reason) => ResolutionState::Failed(reason.clone()),
        };
        outcome
    }
}

/// Holds whatever child processes this module itself spawned, so main.rs can
/// tear them down on quit. Never holds the process of an instance we detected
/// but don't own (the user's own pre-existing Ollama), only, on Linux, the
/// relay this app may put in front of it.
///
/// Both `ollama_child` and `ollama_relay` are populated from inside
/// `ollama_sidecar` (`ensure_available`, plus `reach_host_ollama` for a relay
/// in front of the user's own Ollama), directly, as soon as each
/// resource exists — not by its caller after the whole (potentially
/// multi-minute, model-download-and-pull) call returns. A quit signal
/// arriving mid-resolution must still be able to find and kill whatever has
/// been spawned so far; populating these fields only on a successful return
/// would leave that window unguarded.
pub struct LocalModelHandles {
    ollama_child: Mutex<Option<Child>>,
    /// Linux only in practice: the bridge-gateway relay in front of a
    /// loopback-bound Ollama, either the sidecar or the user's own (see
    /// ollama_sidecar::reach_host_ollama). Held for the same reason as
    /// `ollama_child` — it owns a listening socket that must be released on
    /// quit, or a relaunch cannot bind the gateway address again.
    ollama_relay: Mutex<Option<bridge_relay::RelayHandle>>,
    /// Linux only in practice: the check that the containers reach the model,
    /// owed once the stack is up. Recorded by ollama_sidecar wherever the
    /// containers come to depend on an Ollama on this host, run by
    /// check_container_reach. See container_reach for why the host cannot
    /// answer this itself.
    container_check: Mutex<Option<container_reach::Target>>,
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
            container_check: Mutex::new(None),
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

    /// Records that the containers reach the model at `target`, to be checked
    /// from inside the appliance once the stack is up. Replaces an earlier one.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub(crate) fn expect_container_check(&self, target: container_reach::Target) {
        let mut pending = self
            .container_check
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        *pending = Some(target);
    }

    /// Runs the check recorded by expect_container_check, once the stack has
    /// started. Blocking: `docker exec` and up to five seconds of curl.
    ///
    /// Both callers of ensure_local_model_then_start_stack reach this, and the
    /// second may get here while the first is still bringing the stack up. A
    /// probe that finds the api container not running keeps the check for the
    /// caller that started it; any other outcome is logged once. A caller that
    /// arrives while another's probe runs waits for it, then probes only if
    /// that one found no api container.
    pub fn check_container_reach(&self) {
        self.check_container_reach_with(container_reach::check_and_log);
    }

    /// check_container_reach with the probe passed in. `probe` logs what it
    /// found and returns false when the api container was not running.
    fn check_container_reach_with(&self, probe: impl FnOnce(&container_reach::Target) -> bool) {
        let mut pending = self
            .container_check
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let Some(target) = *pending else {
            return;
        };
        if probe(&target) {
            *pending = None;
        }
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
            // Reaped, not only signalled. A retry in resolve_once probes and
            // binds 11434 straight after this. The killed process holds that
            // port until it has exited.
            let _ = child.wait();
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
    /// comment until it has succeeded once, however many callers invoke it.
    /// A caller queued behind a failed attempt gets that attempt's error; a
    /// later caller tries again (see ResolutionState). Both
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
    /// apply_llm_env_override appends LLM_API_BASE/LLM_API_KEY and every later
    /// call (a manual "Start Stack" from the tray, say) would otherwise
    /// duplicate those lines into `.env` on every restart. (Its chat-model
    /// rewrite replaces lines instead, so that half is safe to repeat.)
    ///
    /// Blocking (network calls, subprocess spawns, potentially a
    /// several-hundred-MB download) — call via spawn_blocking, matching every
    /// other stack_manager entry point.
    pub fn resolve_once(&self, paths: &crate::stack_manager::StackPaths, apple_bridge_binary: &Path) -> Result<(), String> {
        // Whether another caller was resolving when this one arrived: if so,
        // this one takes that attempt's outcome, a failure included.
        let (mut resolution, queued) = match self.resolution.try_lock() {
            Ok(guard) => (guard, false),
            Err(TryLockError::Poisoned(poisoned)) => (poisoned.into_inner(), false),
            Err(TryLockError::WouldBlock) => (self.resolution.lock().unwrap_or_else(|p| p.into_inner()), true),
        };
        resolution.settle(queued, |retrying| {
            // A retry after a failure first stops whatever that attempt left
            // running (an Ollama it started but could not pull with, say), or it
            // would find that Ollama answering on 11434 and take it for the user's.
            if retrying {
                self.shutdown();
            }
            let (status, env) = resolve_and_start(&paths.data_dir, &paths.logs_dir, apple_bridge_binary, self)?;
            log::info!("Local model resolved: {:?} — {}", status.chat_backend, status.detail);
            *self.status.lock().unwrap_or_else(|p| p.into_inner()) = Some(status);

            if let Err(e) = crate::stack_manager::apply_llm_env_override(paths, &env) {
                log::error!("Failed to apply local-model env override: {e}");
            }

            Ok(())
        })
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
        // Reusing an already-answering instance we did not start. We never own
        // its process. On Linux we may own a relay in front of it, when it
        // answers on loopback only and the containers could not otherwise
        // reach it; reach_host_ollama decides and registers that relay in
        // `handles` itself, so quitting the app removes it.
        #[cfg(target_os = "linux")]
        log::info!(
            "An Ollama instance is already answering on port {}. Reusing it; whether the appliance's \
             containers reach it is checked from inside them once they are running.",
            ollama_sidecar::OLLAMA_PORT
        );
        ollama_sidecar::reach_host_ollama(handles);

        // Nothing is pulled into an Ollama this app does not own. If it lacks
        // the default model, name one it has instead: asking for a model it
        // does not serve failed every background job.
        env.chat_model = ollama_sidecar::host_ollama_chat_model(ollama_sidecar::OLLAMA_PORT);
    }

    let detail = match chat_backend {
        ChatBackend::HostOllama => match &env.chat_model {
            Some(model) => format!("Chat + embeddings: your own local Ollama, chat on {model}."),
            None => "Chat + embeddings: your own local Ollama.".to_string(),
        },
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

    /// The splash's start call arrives moments after main.rs's own and waits
    /// on the same gate. When the first resolution failed, the second used to
    /// run it all again: on Linux without Ollama, that was a second 1 GB
    /// download failing the same way, at every launch.
    #[test]
    fn a_failed_resolution_is_not_started_over_by_a_caller_queued_behind_it() {
        let attempts = std::cell::Cell::new(0);
        let mut state = ResolutionState::NotStarted;

        let first = state.settle(false, |_| {
            attempts.set(attempts.get() + 1);
            Err("ollama-linux-amd64.tar.zst did not contain ollama".to_string())
        });
        let second = state.settle(true, |_| {
            attempts.set(attempts.get() + 1);
            Ok(())
        });

        assert_eq!(first, Err("ollama-linux-amd64.tar.zst did not contain ollama".to_string()));
        assert_eq!(second, first, "the queued caller should hear the first caller's failure");
        assert_eq!(attempts.get(), 1);
    }

    /// The splash offers Retry when a start fails. A first launch with no
    /// network fails both the Ollama download and the image pulls, so a Retry
    /// once the network is back has to fetch the model server too, not only
    /// start Memory without one. The retry is told it is one, which is what
    /// makes resolve_once stop the failed attempt's Ollama first.
    #[test]
    fn a_later_caller_retries_a_failed_resolution() {
        let attempts = std::cell::RefCell::new(Vec::new());
        let mut state = ResolutionState::NotStarted;

        let first = state.settle(false, |retrying| {
            attempts.borrow_mut().push(retrying);
            Err("Failed to download ollama-linux-amd64.tar.zst".to_string())
        });
        let retry = state.settle(false, |retrying| {
            attempts.borrow_mut().push(retrying);
            Ok(())
        });

        assert!(first.is_err());
        assert_eq!(retry, Ok(()));
        assert_eq!(*attempts.borrow(), vec![false, true], "only the second attempt is a retry");
        assert_eq!(state.settle(false, |_| panic!("a success is kept")), Ok(()));
    }

    fn gateway_target() -> container_reach::Target {
        container_reach::Target {
            port: ollama_sidecar::OLLAMA_PORT,
            gateway: Some(std::net::Ipv4Addr::new(172, 17, 0, 1)),
            relayed: true,
        }
    }

    /// The splash's start returns at once while the first start is still
    /// pulling images, so its probe can find no api container yet. That probe
    /// must leave the check for the start that brings the container up, and a
    /// check that ran must not run again at every later start.
    #[test]
    fn the_container_check_waits_for_the_api_container_and_then_runs_once() {
        let handles = LocalModelHandles::default();
        let probes = std::cell::RefCell::new(Vec::new());

        handles.check_container_reach_with(|_| panic!("nothing was recorded"));

        handles.expect_container_check(gateway_target());
        handles.check_container_reach_with(|target| {
            probes.borrow_mut().push(*target);
            false
        });
        handles.check_container_reach_with(|target| {
            probes.borrow_mut().push(*target);
            true
        });
        handles.check_container_reach_with(|_| panic!("a check that ran is not repeated"));

        assert_eq!(*probes.borrow(), vec![gateway_target(), gateway_target()]);
    }

    /// The start that brought the stack up can finish while the splash's
    /// probe is still running. It waits for that probe and probes again only
    /// when that one found no api container; returning at once left the check
    /// undone for the whole launch.
    #[test]
    fn a_check_that_arrives_during_another_waits_and_probes_only_if_still_owed() {
        for first_found_the_container in [true, false] {
            let handles = LocalModelHandles::default();
            handles.expect_container_check(gateway_target());
            let second_probes = std::sync::atomic::AtomicUsize::new(0);
            let (probing, probing_seen) = std::sync::mpsc::channel();
            let (release, released) = std::sync::mpsc::channel::<()>();

            std::thread::scope(|scope| {
                let first = &handles;
                scope.spawn(move || {
                    first.check_container_reach_with(|_| {
                        probing.send(()).unwrap();
                        released.recv().unwrap();
                        first_found_the_container
                    })
                });
                probing_seen.recv().unwrap();
                let second = scope.spawn(|| {
                    handles.check_container_reach_with(|_| {
                        second_probes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        true
                    })
                });
                // Long enough for the second caller to reach the lock while
                // the first probe still holds it.
                std::thread::sleep(std::time::Duration::from_millis(100));
                release.send(()).unwrap();
                second.join().unwrap();
            });

            let expected = if first_found_the_container { 0 } else { 1 };
            assert_eq!(
                second_probes.into_inner(),
                expected,
                "first found the container: {first_found_the_container}"
            );
        }
    }

    #[test]
    fn a_successful_resolution_is_not_run_twice() {
        let attempts = std::cell::Cell::new(0);
        let mut state = ResolutionState::NotStarted;

        for queued in [false, true, false] {
            let outcome = state.settle(queued, |_| {
                attempts.set(attempts.get() + 1);
                Ok(())
            });
            assert_eq!(outcome, Ok(()));
        }

        assert_eq!(attempts.get(), 1);
    }
}

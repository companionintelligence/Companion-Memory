//! "Download recommended model" in Settings > Model, for a person whose own
//! Ollama serves Memory.
//!
//! This app pulls nothing into an Ollama it does not own unasked (see
//! ollama_sidecar::host_ollama_chat_model). When that Ollama lacks one of the
//! models the app pulls into its own (ollama_sidecar::RECOMMENDED_MODELS),
//! Memory runs on the first chat model it lists, which can be one far too slow
//! for background work. The web app asks here whether that is the case. Its
//! button has this app pull the missing models with the same `/api/pull` it
//! uses for its own Ollama, then point Memory at the recommended chat model and
//! recreate the containers that read it, which is what the next launch would
//! do anyway.
//!
//! The web app reaches this through main.rs's get_recommended_model_command
//! and download_recommended_model_command, which
//! capabilities/remote-recommended-model.json grants to its origin. Neither
//! takes an argument, so the page cannot choose what is pulled.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;

use super::ollama_sidecar::{self, DEFAULT_CHAT_MODEL, OLLAMA_PORT};
use super::ChatBackend;
use crate::stack_manager::{self, StackPaths};

/// How long Memory may take to answer again after its containers are recreated
/// for the new chat model.
const RESTART_TIMEOUT: Duration = Duration::from_secs(180);

/// Where a download started from Settings > Model has got. Kept after it ends,
/// so the page can say how it went.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Download {
    #[default]
    Idle,
    Downloading {
        model: String,
        completed_bytes: u64,
        total_bytes: u64,
    },
    /// The models are in; Memory is being restarted on the recommended one.
    Switching { model: String },
    Done {
        downloaded: Vec<String>,
        chat_model: String,
    },
    /// `message` is written for the person, not the log.
    Failed { message: String },
}

impl Download {
    fn is_running(&self) -> bool {
        matches!(self, Download::Downloading { .. } | Download::Switching { .. })
    }
}

/// What Settings > Model shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendedModelStatus {
    /// The person's own Ollama serves Memory. Everywhere else this app runs its
    /// own Ollama, which it gave the recommended models itself, or uses Apple's
    /// model.
    pub own_ollama: bool,
    pub recommended: String,
    /// The chat model Memory asks for now (`.env`'s LLM_DEFAULT_CHAT_MODEL):
    /// what chat and background work run on for anyone who has not picked one.
    pub chat_model: Option<String>,
    /// The recommended models the person's Ollama does not have. None when it
    /// was not asked (not the person's own Ollama, or a download is running)
    /// or did not answer: the page must not read that as "nothing missing".
    pub missing: Option<Vec<String>>,
    pub download: Download,
}

/// The download state, shared with the thread that runs it.
#[derive(Default)]
pub struct Downloader {
    download: Arc<Mutex<Download>>,
    /// Set when a switch failed after `.env` was rewritten. `.env` then names
    /// the recommended model while the containers still run the old one, so
    /// `.env` alone no longer says whether a retry has to restart them.
    switch_owed: Arc<AtomicBool>,
}

impl Downloader {
    fn current(&self) -> Download {
        self.download.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
}

/// Sets the shared state. A free function so the download thread can hold the
/// `Arc` alone.
fn set(download: &Mutex<Download>, next: Download) {
    *download.lock().unwrap_or_else(|p| p.into_inner()) = next;
}

pub fn status(paths: &StackPaths, backend: Option<ChatBackend>, downloader: &Downloader) -> RecommendedModelStatus {
    let own_ollama = backend == Some(ChatBackend::HostOllama);
    let download = downloader.current();
    // Not asked while a download runs. What is missing cannot change until it
    // ends, yet the page polls this every second.
    let missing = if own_ollama && !download.is_running() {
        ollama_sidecar::host_ollama_missing_models(OLLAMA_PORT)
            .map_err(|e| log::warn!("Could not ask your Ollama which recommended models it has: {e}"))
            .ok()
    } else {
        None
    };

    RecommendedModelStatus {
        own_ollama,
        recommended: DEFAULT_CHAT_MODEL.to_string(),
        chat_model: stack_manager::env_chat_model(paths),
        missing,
        download,
    }
}

/// Starts the download Settings > Model's button asks for (unless one is
/// already running) and returns at once. The models are those of
/// RECOMMENDED_MODELS the person's Ollama lacks. With none missing it still
/// switches Memory to the recommended chat model when `.env` names another
/// (pulled by hand since the app started, say).
pub fn start(paths: &StackPaths, backend: Option<ChatBackend>, downloader: &Downloader) -> Result<(), String> {
    if backend != Some(ChatBackend::HostOllama) {
        return Err("Memory Desktop runs its own Ollama here. It already has the recommended models.".to_string());
    }

    // A press while a download runs joins it. Checked before Ollama is asked:
    // an Ollama busy writing gigabytes can miss the list's 5 s timeout, and
    // that would turn the press into "did not answer". Checked again below,
    // under the lock, for a press that races this one.
    if downloader.current().is_running() {
        return Ok(());
    }

    let missing = ollama_sidecar::host_ollama_missing_models(OLLAMA_PORT).map_err(|e| {
        log::warn!("Download recommended model: could not list your Ollama's models: {e}");
        "Your Ollama did not answer. Check that it is running, then try again.".to_string()
    })?;

    {
        let mut download = downloader.download.lock().unwrap_or_else(|p| p.into_inner());
        if download.is_running() {
            return Ok(());
        }
        *download = match missing.first() {
            Some(model) => Download::Downloading {
                model: model.clone(),
                completed_bytes: 0,
                total_bytes: 0,
            },
            None => Download::Switching {
                model: DEFAULT_CHAT_MODEL.to_string(),
            },
        };
    }

    let paths = paths.clone();
    let download = Arc::clone(&downloader.download);
    let switch_owed = Arc::clone(&downloader.switch_owed);
    std::thread::spawn(move || run(&paths, &missing, &download, &switch_owed));

    Ok(())
}

fn run(paths: &StackPaths, missing: &[String], download: &Mutex<Download>, switch_owed: &AtomicBool) {
    for model in missing {
        // Named before Ollama reports the first layer, which can take a while:
        // until then the page would still show the previous model at 100%.
        set(
            download,
            Download::Downloading {
                model: model.clone(),
                completed_bytes: 0,
                total_bytes: 0,
            },
        );
        log::info!("Download recommended model: pulling {model} into your Ollama");
        let pulled = ollama_sidecar::pull_model_reporting(OLLAMA_PORT, model, |progress| {
            set(
                download,
                Download::Downloading {
                    model: model.clone(),
                    completed_bytes: progress.completed_bytes,
                    total_bytes: progress.total_bytes,
                },
            );
        });
        if let Err(e) = pulled {
            log::error!("Download recommended model: {e}");
            set(
                download,
                Download::Failed {
                    message: ollama_sidecar::describe_pull_failure(model, &e),
                },
            );
            return;
        }
        log::info!("Download recommended model: {model} is in your Ollama");
    }

    let done = Download::Done {
        downloaded: missing.to_vec(),
        chat_model: DEFAULT_CHAT_MODEL.to_string(),
    };

    // Memory already asks for it: an Ollama that had no chat model at launch,
    // or only the embedding model was missing.
    let asks_for_it = stack_manager::env_chat_model(paths).as_deref() == Some(DEFAULT_CHAT_MODEL);
    if asks_for_it && !switch_owed.load(Ordering::SeqCst) {
        set(download, done);
        return;
    }

    set(
        download,
        Download::Switching {
            model: DEFAULT_CHAT_MODEL.to_string(),
        },
    );
    log::info!("Download recommended model: restarting Memory on {DEFAULT_CHAT_MODEL}");

    match switch_chat_model(paths) {
        Ok(()) => {
            log::info!("Download recommended model: Memory runs on {DEFAULT_CHAT_MODEL}");
            switch_owed.store(false, Ordering::SeqCst);
            set(download, done);
        }
        Err(e) => {
            log::error!("Download recommended model: switching to {DEFAULT_CHAT_MODEL} failed: {e}");
            switch_owed.store(true, Ordering::SeqCst);
            set(
                download,
                Download::Failed {
                    message: format!(
                        "{DEFAULT_CHAT_MODEL} is downloaded, but Memory did not restart with it. \
                         Quit Memory Desktop and open it again to switch to it."
                    ),
                },
            );
        }
    }
}

/// What the next launch would do with the recommended model on disk: `.env`
/// names it and the containers that read it are recreated. Waits until Memory
/// answers again, so the page can reload onto the new model.
fn switch_chat_model(paths: &StackPaths) -> Result<(), String> {
    stack_manager::set_env_chat_model(paths, DEFAULT_CHAT_MODEL)?;

    let restarted = stack_manager::apply_env_change(paths)?;
    if restarted && !stack_manager::wait_until_healthy(RESTART_TIMEOUT) {
        return Err(format!("Memory did not answer within {}s of the restart", RESTART_TIMEOUT.as_secs()));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The page reads these field names (Settings > Model in the web app,
    /// `DesktopRecommendedModel` in @ci/common's nativeBridge.ts). A renamed
    /// field there would hide the button without an error anywhere.
    #[test]
    fn the_status_reaches_the_page_in_the_shape_it_reads() {
        let status = RecommendedModelStatus {
            own_ollama: true,
            recommended: DEFAULT_CHAT_MODEL.to_string(),
            chat_model: Some("qwen3.5:122b".to_string()),
            missing: Some(vec![DEFAULT_CHAT_MODEL.to_string()]),
            download: Download::Downloading {
                model: DEFAULT_CHAT_MODEL.to_string(),
                completed_bytes: 1,
                total_bytes: 2,
            },
        };

        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::json!({
                "ownOllama": true,
                "recommended": DEFAULT_CHAT_MODEL,
                "chatModel": "qwen3.5:122b",
                "missing": [DEFAULT_CHAT_MODEL],
                "download": { "state": "downloading", "model": DEFAULT_CHAT_MODEL, "completedBytes": 1, "totalBytes": 2 },
            })
        );
        let unanswered = RecommendedModelStatus { missing: None, ..status };
        assert_eq!(serde_json::to_value(&unanswered).unwrap()["missing"], serde_json::Value::Null);
        assert_eq!(serde_json::to_value(Download::Idle).unwrap(), serde_json::json!({ "state": "idle" }));
        assert_eq!(
            serde_json::to_value(Download::Done {
                downloaded: vec![DEFAULT_CHAT_MODEL.to_string()],
                chat_model: DEFAULT_CHAT_MODEL.to_string(),
            })
            .unwrap(),
            serde_json::json!({ "state": "done", "downloaded": [DEFAULT_CHAT_MODEL], "chatModel": DEFAULT_CHAT_MODEL })
        );
        assert_eq!(
            serde_json::to_value(Download::Failed { message: "x".to_string() }).unwrap(),
            serde_json::json!({ "state": "failed", "message": "x" })
        );
    }

    /// Only a person's own Ollama gets the offer. The button refuses
    /// anything else before it asks Ollama anything.
    #[test]
    fn only_a_persons_own_ollama_is_offered_a_download() {
        let dir = tempfile::tempdir().unwrap();
        let paths = StackPaths {
            data_dir: dir.path().to_path_buf(),
            compose_dir: dir.path().to_path_buf(),
            logs_dir: dir.path().to_path_buf(),
            import_work_dir: dir.path().to_path_buf(),
        };
        let downloader = Downloader::default();

        for backend in [None, Some(ChatBackend::BundledOllama), Some(ChatBackend::AppleOnDevice)] {
            let status = status(&paths, backend, &downloader);
            assert!(!status.own_ollama);
            assert_eq!(status.missing, None);
            assert!(start(&paths, backend, &downloader).is_err());
            assert_eq!(downloader.current(), Download::Idle);
        }
    }

    /// A second press while a download runs joins it rather than starting a
    /// second pull of the same 10 GB.
    #[test]
    fn a_running_download_is_not_started_twice() {
        assert!(Download::Downloading {
            model: DEFAULT_CHAT_MODEL.to_string(),
            completed_bytes: 0,
            total_bytes: 0
        }
        .is_running());
        assert!(Download::Switching {
            model: DEFAULT_CHAT_MODEL.to_string()
        }
        .is_running());
        assert!(!Download::Idle.is_running());
        assert!(!Download::Failed { message: String::new() }.is_running());
        assert!(!Download::Done {
            downloaded: Vec::new(),
            chat_model: DEFAULT_CHAT_MODEL.to_string()
        }
        .is_running());
    }
}

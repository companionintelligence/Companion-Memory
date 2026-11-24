//! Tells Memory whether this app is running.
//!
//! Quit leaves the containers running, the same as closing the window. When
//! this app is what serves them their model (its own Ollama, the relay in front
//! of one or the Apple bridge), the model stops with the app, and Memory went on
//! answering in a browser and to agents while chat, search and summaries all
//! failed with nothing to say why. So the app keeps a small file up to date,
//! which docker-compose.desktop.yml mounts read-only into the `api` service.
//! When the file says the app is gone and the model does not answer either, the
//! web app and MCP say that Memory Desktop is closed and that opening it brings
//! chat back.
//!
//! A heartbeat rather than a flag cleared on the way out. Quit marks the file
//! closed at once, but a crash, a kill, logging out and macOS's Cmd+Q never go
//! through the tray's Quit. Those leave a timestamp that stops moving, and the
//! api reads one older than its staleness window (30s, three beats) as closed.
//! The same goes for a reboot that brings the containers back without the app.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The folder beside the compose files. The overlay mounts `./desktop-app`,
/// which compose resolves against the project directory (the compose dir), at
/// /run/ci-desktop-app.
pub const DIR_NAME: &str = "desktop-app";

/// What the api reads, as DESKTOP_APP_PRESENCE_FILE=/run/ci-desktop-app/presence.json.
pub const FILE_NAME: &str = "presence.json";

/// How often a running app rewrites the file. The api's staleness window is
/// three of these, so one slow write never reads as closed.
pub const HEARTBEAT: Duration = Duration::from_secs(10);

pub fn dir(compose_dir: &Path) -> PathBuf {
    compose_dir.join(DIR_NAME)
}

#[derive(Default)]
struct State {
    /// Set by Quit. No beat may write "running" after it.
    closed: bool,
    /// The last write failed, so the next failure is not logged again every
    /// ten seconds.
    failing: bool,
}

pub struct Presence {
    dir: PathBuf,
    state: Mutex<State>,
}

impl Presence {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            state: Mutex::new(State::default()),
        }
    }

    /// Records that the app is running. Returns false once Quit has marked the
    /// app closed, which ends the heartbeat loop.
    pub fn beat(&self) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.closed {
            return false;
        }
        self.write(&mut state, true);
        true
    }

    /// Records that the app is quitting. The lock is held across the write, so a
    /// beat already under way lands before this one and none can land after it.
    pub fn mark_closed(&self) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.closed = true;
        self.write(&mut state, false);
    }

    fn write(&self, state: &mut State, running: bool) {
        match write_presence(&self.dir, running, unix_seconds()) {
            Ok(()) => {
                if state.failing {
                    log::info!("presence: writing {} works again", self.dir.join(FILE_NAME).display());
                }
                state.failing = false;
            }
            Err(e) => {
                if !state.failing {
                    log::warn!(
                        "presence: could not write {}: {e}. A browser on Memory may not be told when this app is closed.",
                        self.dir.join(FILE_NAME).display()
                    );
                }
                state.failing = true;
            }
        }
    }
}

fn unix_seconds() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Written beside the real file and renamed over it, so the api never reads half
/// a file. The overlay mounts the folder rather than the file for the same
/// reason: a bind-mounted single file keeps pointing at the inode the rename
/// replaced.
fn write_presence(dir: &Path, running: bool, updated_at: u64) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let body = serde_json::json!({ "running": running, "updatedAt": updated_at });
    let tmp = dir.join(format!("{FILE_NAME}.tmp"));
    fs::write(&tmp, format!("{body}\n"))?;
    fs::rename(&tmp, dir.join(FILE_NAME))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(dir: &Path) -> serde_json::Value {
        let raw = fs::read_to_string(dir.join(FILE_NAME)).expect("presence file");
        serde_json::from_str(&raw).expect("presence file is JSON")
    }

    /// The api's whole view of the app is this file: `running` and how fresh
    /// `updatedAt` is. A beat has to leave both, with a timestamp the api can
    /// compare against its own clock.
    #[test]
    fn a_beat_records_a_running_app_with_the_current_time() {
        let tmp = tempfile::tempdir().unwrap();
        let presence = Presence::new(dir(tmp.path()));

        let before = unix_seconds();
        assert!(presence.beat(), "a running app keeps beating");
        let after = unix_seconds();

        let body = read(&dir(tmp.path()));
        assert_eq!(body["running"], true);
        let at = body["updatedAt"].as_u64().expect("updatedAt in seconds");
        assert!(before <= at && at <= after, "{at} not within {before}..={after}");
        assert!(!dir(tmp.path()).join(format!("{FILE_NAME}.tmp")).exists(), "no temp file left behind");
    }

    /// Quit and the heartbeat thread race. If a beat could land after Quit's
    /// write, the file would say "running" for a whole staleness window after
    /// the app had gone, and Memory would not say it was closed.
    #[test]
    fn once_closed_no_beat_writes_running_again() {
        let tmp = tempfile::tempdir().unwrap();
        let presence = Presence::new(dir(tmp.path()));

        assert!(presence.beat());
        presence.mark_closed();
        assert_eq!(read(&dir(tmp.path()))["running"], false);

        assert!(!presence.beat(), "the heartbeat loop ends once the app is closed");
        assert_eq!(read(&dir(tmp.path()))["running"], false, "still closed after a late beat");
    }

    /// The folder is made at startup, before the first `compose up` (Docker would
    /// otherwise create the bind source owned by root). If it goes missing while
    /// the app runs, the next beat puts it back rather than failing for good.
    #[test]
    fn a_missing_folder_is_made_again() {
        let tmp = tempfile::tempdir().unwrap();
        let presence = Presence::new(dir(tmp.path()));

        assert!(presence.beat());
        fs::remove_dir_all(dir(tmp.path())).unwrap();
        assert!(presence.beat());
        assert_eq!(read(&dir(tmp.path()))["running"], true);
    }
}

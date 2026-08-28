// Bootstrap splash state machine:
//   docker-missing -> starting -> waiting-for-health -> ready (redirect)
//                                                     -> error / timeout
//
// This page only ever talks to the app through Tauri IPC commands — it never
// makes an HTTP call itself (check_stack_status_command runs the health
// probe in Rust). See src-tauri/src/main.rs for the full command list and
// src-tauri/capabilities/default.json for why this page intentionally has no
// broader permissions: once healthy, window.location.replace() navigates
// away from this page entirely into the real CI-Server web app.

const POLL_INTERVAL_MS = 1000;
// First-run image pulls (especially hbpe-service) can take several minutes;
// 900 attempts at 1s is 15 minutes before giving up.
const MAX_ATTEMPTS = 900;

const statusEl = document.getElementById('status');
const spinnerEl = document.getElementById('spinner');
const actionsEl = document.getElementById('actions');

function invoke(command, args) {
  return window.__TAURI_INTERNALS__.invoke(command, args);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setStatus(message, { error = false } = {}) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', error);
}

function setSpinning(spinning) {
  spinnerEl.classList.toggle('hidden', !spinning);
}

function showActions(buttons) {
  actionsEl.innerHTML = '';
  for (const button of buttons) {
    const el = document.createElement('button');
    el.textContent = button.label;
    el.className = button.primary ? 'primary' : '';
    el.addEventListener('click', button.onClick);
    actionsEl.appendChild(el);
  }

  actionsEl.classList.toggle('hidden', buttons.length === 0);
}

async function boot() {
  showActions([]);
  setSpinning(true);
  setStatus('Checking Docker…');

  const dockerInstalled = await invoke('check_docker_installed_command');
  if (!dockerInstalled) {
    setSpinning(false);
    setStatus('Docker was not found on this machine.', { error: true });
    showActions([
      { label: 'Install Docker', primary: true, onClick: () => invoke('open_docker_downloads_command') },
      { label: 'Retry', onClick: boot },
    ]);

    return;
  }

  const dockerRunning = await invoke('check_docker_available_command');
  if (!dockerRunning) {
    setSpinning(false);
    setStatus('Docker is installed but not running. Start Docker and try again.', { error: true });
    showActions([{ label: 'Retry', primary: true, onClick: boot }]);

    return;
  }

  setStatus('Starting Companion Memory…');
  try {
    await invoke('start_stack_command');
  } catch (err) {
    // Surfaced definitively by the health-poll timeout below if this keeps
    // failing; a single failed attempt here (e.g. a transient compose error)
    // shouldn't dead-end the page.
    console.error('start_stack_command failed:', err);
  }

  await waitForHealthy();
}

async function waitForHealthy() {
  const gatewayUrl = await invoke('get_gateway_url_command');
  // Set once local_model::resolve_and_start finishes on the Rust side —
  // still null for a while on a first launch that needs to download a
  // bundled model. Purely informational; never blocks the health poll below.
  let localModelDetail = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const healthy = await invoke('check_stack_status_command');
    if (healthy) {
      setStatus('Ready — loading…');
      window.location.replace(`${gatewayUrl}/`);

      return;
    }

    if (!localModelDetail) {
      const localModel = await invoke('get_local_model_status_command');
      if (localModel) {
        localModelDetail = localModel.detail;
      }
    }

    if (attempt > 0 && attempt % 30 === 0) {
      const suffix = localModelDetail ? ` (${localModelDetail})` : ' — preparing the local model…';
      setStatus(
        `Still starting Companion Memory — first launch can take several minutes while images download…${suffix}`,
      );
    }

    await sleep(POLL_INTERVAL_MS);
  }

  setSpinning(false);
  setStatus('Companion Memory is taking longer than expected to start.', { error: true });
  showActions([
    { label: 'Retry', primary: true, onClick: boot },
    { label: 'View Logs', onClick: () => invoke('open_logs_dir_command') },
  ]);
}

boot();

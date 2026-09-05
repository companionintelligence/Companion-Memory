// Bootstrap splash state machine:
//   first-run notice -> docker checks -> starting (live progress) -> ready (redirect)
//                                                                 -> failed / timeout
//
// This page only ever talks to the app through Tauri IPC commands — it never
// makes an HTTP call itself (check_stack_status_command runs the health probe in
// Rust). See src-tauri/src/main.rs for the full command list and
// src-tauri/capabilities/default.json for why this page intentionally has no
// broader permissions: once healthy, window.location.replace() navigates away
// from this page entirely into the real CI-Server web app.
//
// `start_stack_command` returns immediately and the work reports through
// `get_startup_progress_command`. It used to be awaited, which meant the page
// was blocked for the entire cold start — every progress message and the whole
// timeout budget belonged to a phase that was already over by the time they
// could be shown.

const POLL_INTERVAL_MS = 1000;
// The start reports its own progress now, so this only bounds a start that has
// gone quiet: 30 minutes without either becoming healthy or reporting a failure.
const MAX_ATTEMPTS = 1800;

const statusEl = document.getElementById('status');
const headlineEl = document.getElementById('headline');
const spinnerEl = document.getElementById('spinner');
const actionsEl = document.getElementById('actions');
const noticeEl = document.getElementById('notice');

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

function setHeadline(message) {
  headlineEl.textContent = message;
}

function setSpinning(spinning) {
  spinnerEl.classList.toggle('hidden', !spinning);
}

function showNotice(html) {
  noticeEl.innerHTML = html;
  noticeEl.classList.toggle('hidden', !html);
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

/**
 * What the first run is about to do, said before it does it.
 *
 * It downloads several gigabytes of container images and mounts a folder from
 * the user's home directory into one of them. Neither was stated anywhere, and
 * both are the kind of thing someone is entitled to know before it starts
 * rather than after.
 */
async function confirmFirstRun() {
  let firstRun = false;
  try {
    firstRun = await invoke('is_first_run_command');
  } catch {
    // Unknown — treat as a normal launch rather than blocking on a notice.
  }

  if (!firstRun) {
    return;
  }

  setHeadline('Setting up Companion Memory.');
  setStatus('One-time setup on this machine.');
  showNotice(
    '<ul>' +
      '<li>Downloads about <strong>8–10&nbsp;GB</strong> of container images. Later launches start in seconds.</li>' +
      '<li>Runs entirely on this machine — nothing is sent anywhere.</li>' +
      '<li>Mounts your <strong>Downloads</strong> folder read-only, so you can import archives you have already saved.</li>' +
      '</ul>',
  );

  await new Promise((resolve) => {
    showActions([{ label: 'Set up Companion Memory', primary: true, onClick: resolve }]);
  });

  showNotice('');
  showActions([]);
  try {
    await invoke('mark_first_run_complete_command');
  } catch {
    // A missed marker only costs the notice showing once more.
  }
}

async function boot() {
  showActions([]);
  showNotice('');
  setSpinning(true);
  setHeadline('Waking up your memory.');
  setStatus('Checking Docker…');

  const dockerInstalled = await invoke('check_docker_installed_command');
  if (!dockerInstalled) {
    return fail('Docker was not found on this machine.', [
      { label: 'Install Docker', primary: true, onClick: () => invoke('open_docker_downloads_command') },
      { label: 'Retry', onClick: boot },
    ]);
  }

  const dockerRunning = await invoke('check_docker_available_command');
  if (!dockerRunning) {
    return fail('Docker is installed but not running. Start Docker, then try again.', [
      { label: 'Retry', primary: true, onClick: boot },
    ]);
  }

  await confirmFirstRun();

  setHeadline('Waking up your memory.');
  setStatus('Starting Companion Memory…');

  try {
    // Returns as soon as the work is scheduled; progress arrives through the poll.
    await invoke('start_stack_command');
  } catch (err) {
    return fail(String(err), [
      { label: 'Retry', primary: true, onClick: boot },
      { label: 'View Logs', onClick: () => invoke('open_logs_dir_command') },
    ]);
  }

  await waitForReady();
}

function fail(message, buttons) {
  setSpinning(false);
  setHeadline('Something went wrong.');
  setStatus(message, { error: true });
  showActions(buttons);
}

async function waitForReady() {
  const gatewayUrl = await invoke('get_gateway_url_command');

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (await invoke('check_stack_status_command')) {
      setStatus('Ready — loading…');
      window.location.replace(`${gatewayUrl}/`);

      return;
    }

    // The reason a start failed is known the moment compose exits; showing it
    // then is the whole point of the progress channel. Waiting out a timeout
    // first would turn an answerable failure back into a generic one.
    const progress = await invoke('get_startup_progress_command').catch(() => null);

    if (progress?.error) {
      return fail(progress.error, [
        { label: 'Retry', primary: true, onClick: boot },
        { label: 'View Logs', onClick: () => invoke('open_logs_dir_command') },
      ]);
    }

    if (progress?.detail) {
      setStatus(progress.detail);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  fail('Companion Memory is taking longer than expected to start.', [
    { label: 'Retry', primary: true, onClick: boot },
    { label: 'View Logs', onClick: () => invoke('open_logs_dir_command') },
  ]);
}

// A rejected IPC call used to freeze the page on whatever line was last set,
// with no buttons and no explanation.
boot().catch((err) => {
  fail(`Companion Memory could not start: ${err}`, [
    { label: 'Retry', primary: true, onClick: boot },
    { label: 'View Logs', onClick: () => invoke('open_logs_dir_command') },
  ]);
});

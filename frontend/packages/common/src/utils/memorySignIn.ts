/**
 * Whether Memory has stopped accepting the device key the phone or desktop app signs in with.
 *
 * A key can stop working while the app still holds it: revoked under Settings > API keys, ended by
 * "Sign out everywhere" or a password change, or lost when Memory was restored from an older backup.
 * The app used to carry on as if nothing had happened. Each request failed on its own terms, and
 * through a Hub the failure was not even an error: the Hub's edge turned the request away to its own
 * sign-in page, the app read that page as JSON, and the person saw "invalid JSON". Queued captures
 * kept retrying, spending their attempts on a key that could never send them.
 *
 * `fetchJson.ts` sets this once Memory itself confirms the key is refused (`GET /keys/check`), not on
 * any single failed request. While it is set the outbox does not drain, so nothing queued is lost or
 * marked as failing, and the app asks the person to sign in again. Signing in again (a new key)
 * clears it; signing out does too.
 *
 * Holds no secret: only whether the refusal happened.
 */

let ended = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** True once Memory has confirmed it no longer accepts this device's key. */
export function memorySignInEnded(): boolean {
  return ended;
}

/** Record that Memory refused this device's key. */
export function markMemorySignInEnded(): void {
  if (!ended) {
    ended = true;
    notify();
  }
}

/** A new key was stored, or the person signed out: the refusal no longer describes anything. */
export function clearMemorySignInEnded(): void {
  if (ended) {
    ended = false;
    notify();
  }
}

/** Called whenever {@link memorySignInEnded} changes. */
export function subscribeMemorySignIn(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

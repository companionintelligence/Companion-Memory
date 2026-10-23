/**
 * The signed-in profile a phone last saw, kept so a cold start while the appliance is
 * unreachable still opens the app.
 *
 * `ProtectedRoute` and `RedirectKnownUser` treat "no user" as "signed out" and send the
 * phone to cloud-connect. A phone's credential is an API key in the keystore, which never
 * expires on its own, so with the appliance down the `me` query failing is an OUTAGE,
 * not a sign-out — and the phone holds a synced copy of the user's memory precisely for
 * that case (docs/architecture/mobile-local-search-plan.md). Found by U7, the offline
 * end-to-end test: a cold start with the API stopped landed on "Received status code
 * 500" at cloud-connect, and nothing offline was reachable behind it.
 *
 * Kept per origin, so a phone re-paired to another box never answers with the previous
 * box's profile, and forgotten with the device key on sign-out.
 */
import type { ApolloError } from '@apollo/client';

const STORAGE_KEY = 'ci.rememberedUser';

interface Remembered<User> {
  origin: string;
  user: User;
}

/** Keep `user` as what `origin` last said the signed-in profile was. */
export function rememberUser<User>(origin: string, user: User): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ origin, user } satisfies Remembered<User>));
  } catch {
    // Storage full or blocked: the next cold start without the appliance will sign out, as before.
  }
}

/** The profile `origin` last said, or null when none was kept for it. */
export function recallUser<User>(origin: string): User | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<Remembered<User>>;

    return parsed.origin === origin && parsed.user != null ? parsed.user : null;
  } catch {
    return null;
  }
}

export function forgetUser(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing kept, or storage blocked: nothing to forget.
  }
}

/**
 * Whether a failed `me` query says the appliance could not answer, as opposed to it
 * answering that this credential is no good. A transport failure (dead origin, the Vite
 * proxy's 500 while the dev API is down, a gateway timeout) is an outage; a 401/403 is the
 * server rejecting the key, and so is any GraphQL-level error, which only an answering
 * server produces.
 */
export function isApplianceOutage(
  error: Pick<ApolloError, 'networkError' | 'graphQLErrors'> | undefined,
): boolean {
  if (!error?.networkError) {
    return false;
  }

  const status = (error.networkError as { statusCode?: unknown }).statusCode;

  return status !== 401 && status !== 403;
}

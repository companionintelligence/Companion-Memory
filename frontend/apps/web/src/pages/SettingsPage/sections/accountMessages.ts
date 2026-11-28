import { FetchJsonError } from '@ci/common';

/**
 * The message to show for a failed account change: "sign in again" when the server wants a fresh
 * sign-in (`REAUTH_REQUIRED`), the server's own message otherwise, else `fallback`.
 */
export function messageFrom(error: unknown, fallback: string, signInAgain: string): string {
  if (error instanceof FetchJsonError && error.status === 401 && error.message === 'REAUTH_REQUIRED') {
    // An account with no password of its own proves itself by a recent sign-in
    // instead; the window has passed.
    return signInAgain;
  }

  return error instanceof FetchJsonError ? error.message : fallback;
}

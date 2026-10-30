import { toast as sonnerToast } from 'sonner';

/** sonner's own `toast`, unmuted — for tests that need to see what reaches it. */
export { sonnerToast };

/**
 * The moment until which `toast.error` says nothing. Set by {@link muteErrorToasts}
 * when something else has already told the person what went wrong — the app's
 * "Not connected to your Memory server" dialog, which opens the instant a write is
 * refused. The feature that attempted the write still runs its catch block and
 * still calls `toast.error('Could not move that. Try again shortly.')`, and that
 * toast, beside the dialog, is a second, vaguer explanation of the same thing.
 * Those catch blocks are in dozens of places and most never see the error itself,
 * so the dialog mutes here, once, instead of every one of them checking.
 */
let errorToastsMutedUntil = 0;

/**
 * Drop every `toast.error` for the next `ms` milliseconds. Idempotent and
 * monotonic: a second call never shortens a mute already in force.
 */
export function muteErrorToasts(ms: number): void {
  errorToastsMutedUntil = Math.max(errorToastsMutedUntil, Date.now() + ms);
}

/** Whether `toast.error` is currently muted. */
export function errorToastsMuted(): boolean {
  return Date.now() < errorToastsMutedUntil;
}

/** Lift any mute at once. For tests, which share this module's state across files. */
export function resetErrorToastMute(): void {
  errorToastsMutedUntil = 0;
}

/** The id a muted `toast.error` returns; nothing is shown, and dismissing it is a no-op. */
export const MUTED_TOAST_ID = -1;

const error: typeof sonnerToast.error = (message, data) =>
  errorToastsMuted() ? MUTED_TOAST_ID : sonnerToast.error(message, data);

/**
 * sonner's `toast`, with `error` muted while {@link errorToastsMuted}. Every other
 * kind (success, info, warning, loading, promise, custom, dismiss…) is sonner's own.
 */
export const toast: typeof sonnerToast = Object.assign(
  ((message, data) => sonnerToast(message, data)) as typeof sonnerToast,
  sonnerToast,
  { error },
);

export function useToast() {
  return { toast };
}

export { Toaster } from '../ui/sonner';

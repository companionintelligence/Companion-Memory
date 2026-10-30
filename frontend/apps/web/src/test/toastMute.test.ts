/**
 * `@ci/shadcn`'s toast wrapper: `toast.error` can be muted for a moment, for when a
 * dialog has already explained the failure. Everything else reaches sonner untouched.
 *
 * Spies on the real sonner module rather than mocking it: this project shares module
 * instances across files, and two files mocking the same module fight over whose spies
 * are live.
 */
import {
  MUTED_TOAST_ID,
  errorToastsMuted,
  muteErrorToasts,
  resetErrorToastMute,
  sonnerToast as sonner,
  toast,
} from '@ci/shadcn/src/components/coalescers/sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  resetErrorToastMute();
  vi.spyOn(sonner, 'error').mockReturnValue('err');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetErrorToastMute();
});

describe('toast.error muting', () => {
  it('passes everything through when nothing is muted', () => {
    expect(toast.error('boom')).toBe('err');
    expect(sonner.error).toHaveBeenCalledWith('boom', undefined);
    // The other kinds are sonner's own functions, not wrappers.
    expect(toast.success).toBe(sonner.success);
    expect(toast.dismiss).toBe(sonner.dismiss);
  });

  it('drops error toasts until the mute expires, and only error toasts', () => {
    vi.useFakeTimers({ now: Date.now() });
    muteErrorToasts(2_000);

    expect(errorToastsMuted()).toBe(true);
    expect(toast.error('Could not move that. Try again shortly.')).toBe(MUTED_TOAST_ID);
    expect(sonner.error).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2_001);
    expect(errorToastsMuted()).toBe(false);
    expect(toast.error('later')).toBe('err');
  });

  it('a shorter mute never cuts a longer one short', () => {
    vi.useFakeTimers({ now: Date.now() });
    muteErrorToasts(2_000);
    muteErrorToasts(100);

    vi.advanceTimersByTime(500);
    expect(errorToastsMuted()).toBe(true);
  });
});

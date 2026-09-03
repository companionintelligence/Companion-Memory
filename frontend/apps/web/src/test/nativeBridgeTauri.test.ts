import { isTauriPlatform } from '@ci/common/src/utils/apiBase';
import { addAppUrlOpenListener, openExternalUrl } from '@ci/common/src/utils/nativeBridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Tauri (desktop) is detected via `window.__TAURI_INTERNALS__`, the same runtime-only
// bridge `main.rs`'s bundled bootstrap page already calls directly — see
// isTauriPlatform's doc comment for why this isn't folded into isNativePlatform().
declare global {
  interface Window {
    __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
  }
}

afterEach(() => {
  delete window.__TAURI_INTERNALS__;
});

describe('isTauriPlatform', () => {
  it('is false with no __TAURI_INTERNALS__ bridge (plain web/jsdom)', () => {
    expect(isTauriPlatform()).toBe(false);
  });

  it('is true once __TAURI_INTERNALS__ is present', () => {
    window.__TAURI_INTERNALS__ = { invoke: vi.fn() };
    expect(isTauriPlatform()).toBe(true);
  });
});

describe('openExternalUrl — Tauri branch', () => {
  it('invokes open_external_url_command with the url', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    window.__TAURI_INTERNALS__ = { invoke };

    await openExternalUrl('https://portal.ci.computer/oidc/authorize?x=1');

    // The function returns immediately after this branch (see nativeBridge.ts) — a
    // single call proves the web-fallback `window.location.assign` path below it was
    // never reached, without needing to spy on `window.location` itself (jsdom does
    // not allow redefining `location.assign`).
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('open_external_url_command', {
      url: 'https://portal.ci.computer/oidc/authorize?x=1',
    });
  });
});

describe('addAppUrlOpenListener — Tauri branch', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('delivers a deep link already pending at mount, drained via take_pending_deep_link_command', async () => {
    const invoke = vi.fn().mockResolvedValue('companion://oidc/callback?code=pending-one');
    window.__TAURI_INTERNALS__ = { invoke };

    const handler = vi.fn();
    const unsubscribe = await addAppUrlOpenListener(handler);

    expect(invoke).toHaveBeenCalledWith('take_pending_deep_link_command', undefined);
    expect(handler).toHaveBeenCalledWith('companion://oidc/callback?code=pending-one');

    unsubscribe();
  });

  it('does not call the handler when nothing was pending', async () => {
    const invoke = vi.fn().mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = { invoke };

    const handler = vi.fn();
    const unsubscribe = await addAppUrlOpenListener(handler);

    expect(handler).not.toHaveBeenCalled();

    unsubscribe();
  });

  it('logs (rather than silently swallowing) a real take_pending_deep_link_command rejection, and still mounts', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const invoke = vi.fn().mockRejectedValue(new Error('ACL denied'));
    window.__TAURI_INTERNALS__ = { invoke };

    const handler = vi.fn();
    const unsubscribe = await addAppUrlOpenListener(handler);

    expect(handler).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith('take_pending_deep_link_command failed', expect.any(Error));

    // The rejection must not stop the listener from being wired up — a live deep link
    // dispatched after mount still reaches the handler.
    window.dispatchEvent(
      new CustomEvent('companion-deep-link', { detail: 'companion://oidc/callback?code=after-rejection' }),
    );
    expect(handler).toHaveBeenCalledWith('companion://oidc/callback?code=after-rejection');

    unsubscribe();
    consoleError.mockRestore();
  });

  it('delivers a live companion-deep-link DOM event dispatched after mount (main.rs\'s window.eval path)', async () => {
    const invoke = vi.fn().mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = { invoke };

    const handler = vi.fn();
    const unsubscribe = await addAppUrlOpenListener(handler);

    window.dispatchEvent(
      new CustomEvent('companion-deep-link', { detail: 'companion://oidc/callback?code=live-one' }),
    );

    expect(handler).toHaveBeenCalledWith('companion://oidc/callback?code=live-one');

    unsubscribe();
  });

  it('stops delivering events after the returned unsubscribe is called', async () => {
    const invoke = vi.fn().mockResolvedValue(null);
    window.__TAURI_INTERNALS__ = { invoke };

    const handler = vi.fn();
    const unsubscribe = await addAppUrlOpenListener(handler);
    unsubscribe();

    window.dispatchEvent(
      new CustomEvent('companion-deep-link', { detail: 'companion://oidc/callback?code=after-unsub' }),
    );

    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores a companion-deep-link event with a non-string detail', async () => {
    window.__TAURI_INTERNALS__ = { invoke: vi.fn().mockResolvedValue(null) };

    const handler = vi.fn();
    const unsubscribe = await addAppUrlOpenListener(handler);

    window.dispatchEvent(new CustomEvent('companion-deep-link', { detail: { not: 'a string' } }));

    expect(handler).not.toHaveBeenCalled();

    unsubscribe();
  });

  it('is a no-op outside both Capacitor and Tauri (plain web)', async () => {
    const handler = vi.fn();
    const unsubscribe = await addAppUrlOpenListener(handler);

    window.dispatchEvent(new CustomEvent('companion-deep-link', { detail: 'companion://oidc/callback?code=x' }));

    expect(handler).not.toHaveBeenCalled();
    expect(() => unsubscribe()).not.toThrow();
  });
});

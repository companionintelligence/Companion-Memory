import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useNativeShell } from './useNativeShell';

const navigate = vi.fn();

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();

  return { ...actual, useNavigate: () => navigate };
});

type AppStateHandler = (isActive: boolean) => void;
type BackButtonHandler = (canGoBack: boolean) => void;

const h = vi.hoisted(() => ({
  isNativePlatform: vi.fn(() => false),
  hideSplashScreen: vi.fn(async () => {}),
  syncNativeIntentConfig: vi.fn(async () => {}),
  setStatusBarStyle: vi.fn(async () => {}),
  setSystemBarsBackground: vi.fn(async () => {}),
  isIosPlatform: vi.fn(() => false),
  exitApp: vi.fn(async () => {}),
  addAppStateListener: vi.fn(),
  addBackButtonListener: vi.fn(),
}));

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  isNativePlatform: h.isNativePlatform,
  hideSplashScreen: h.hideSplashScreen,
  syncNativeIntentConfig: h.syncNativeIntentConfig,
  setStatusBarStyle: h.setStatusBarStyle,
  setSystemBarsBackground: h.setSystemBarsBackground,
  isIosPlatform: h.isIosPlatform,
  exitApp: h.exitApp,
  addAppStateListener: h.addAppStateListener,
  addBackButtonListener: h.addBackButtonListener,
}));

/** Captures the handler `useNativeShell` registers and hands back a controllable unsubscribe. */
function deferredListener<H>() {
  let handler: H | undefined;
  const unsubscribe = vi.fn();
  let resolveRegistration: (() => void) | undefined;
  const registered = new Promise<void>((resolve) => {
    resolveRegistration = resolve;
  });

  const register = vi.fn(async (h2: H) => {
    handler = h2;
    resolveRegistration?.();

    return unsubscribe;
  });

  return {
    register,
    unsubscribe,
    handler: () => handler,
    registered,
  };
}

beforeEach(() => {
  h.isNativePlatform.mockReset();
  h.isNativePlatform.mockReturnValue(true);
  h.hideSplashScreen.mockReset().mockResolvedValue(undefined);
  h.syncNativeIntentConfig.mockReset().mockResolvedValue(undefined);
  h.setStatusBarStyle.mockReset().mockResolvedValue(undefined);
  h.setSystemBarsBackground.mockReset().mockResolvedValue(undefined);
  h.isIosPlatform.mockReset().mockReturnValue(false);
  h.exitApp.mockReset().mockResolvedValue(undefined);
  h.addAppStateListener.mockReset();
  h.addBackButtonListener.mockReset();
  navigate.mockReset();
  document.documentElement.className = '';
  document.body.style.backgroundColor = '';
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.className = '';
  document.body.style.backgroundColor = '';
});

describe('useNativeShell — inert on web', () => {
  it('does nothing at all when not running inside the native shell', () => {
    h.isNativePlatform.mockReturnValue(false);

    renderHook(() => useNativeShell());

    expect(h.hideSplashScreen).not.toHaveBeenCalled();
    expect(h.syncNativeIntentConfig).not.toHaveBeenCalled();
    expect(h.setStatusBarStyle).not.toHaveBeenCalled();
    expect(h.setSystemBarsBackground).not.toHaveBeenCalled();
    expect(h.addAppStateListener).not.toHaveBeenCalled();
    expect(h.addBackButtonListener).not.toHaveBeenCalled();
  });
});

describe('useNativeShell — native mount', () => {
  it('dismisses the splash screen and syncs the App Intent config on mount', () => {
    h.addAppStateListener.mockResolvedValue(vi.fn());
    h.addBackButtonListener.mockResolvedValue(vi.fn());

    renderHook(() => useNativeShell());

    expect(h.hideSplashScreen).toHaveBeenCalledTimes(1);
    expect(h.syncNativeIntentConfig).toHaveBeenCalledTimes(1);
    expect(document.documentElement.classList.contains('ci-native')).toBe(true);
  });

  it('re-syncs the App Intent config every time the app returns to the foreground', async () => {
    const appState = deferredListener<AppStateHandler>();
    h.addAppStateListener.mockImplementation(appState.register);
    h.addBackButtonListener.mockResolvedValue(vi.fn());

    renderHook(() => useNativeShell());
    await act(async () => appState.registered);

    expect(h.syncNativeIntentConfig).toHaveBeenCalledTimes(1);

    act(() => appState.handler()?.(true));
    expect(h.syncNativeIntentConfig).toHaveBeenCalledTimes(2);

    // Going to the background is not a foreground transition — no extra sync.
    act(() => appState.handler()?.(false));
    expect(h.syncNativeIntentConfig).toHaveBeenCalledTimes(2);
  });
});

describe('useNativeShell — which shell', () => {
  it('tags the document as the Android shell, where the WebView is inset natively', () => {
    h.addAppStateListener.mockResolvedValue(vi.fn());
    h.addBackButtonListener.mockResolvedValue(vi.fn());

    const { unmount } = renderHook(() => useNativeShell());

    expect(document.documentElement.classList.contains('ci-android')).toBe(true);
    expect(document.documentElement.classList.contains('ci-ios')).toBe(false);

    unmount();
    expect(document.documentElement.classList.contains('ci-native')).toBe(false);
    expect(document.documentElement.classList.contains('ci-android')).toBe(false);
  });

  it('tags the document as the iOS shell, whose CSS keeps its own safe-area floors', () => {
    h.isIosPlatform.mockReturnValue(true);
    h.addAppStateListener.mockResolvedValue(vi.fn());
    h.addBackButtonListener.mockResolvedValue(vi.fn());

    renderHook(() => useNativeShell());

    expect(document.documentElement.classList.contains('ci-ios')).toBe(true);
    expect(document.documentElement.classList.contains('ci-android')).toBe(false);
  });
});

describe('useNativeShell — status bar sync', () => {
  it('paints the window behind the system bars with the same resolved colour as the status bar', async () => {
    h.addAppStateListener.mockResolvedValue(vi.fn());
    h.addBackButtonListener.mockResolvedValue(vi.fn());
    document.body.style.backgroundColor = 'rgb(11, 31, 40)';
    document.documentElement.classList.add('dark');

    renderHook(() => useNativeShell());

    await waitFor(() => expect(h.setStatusBarStyle).toHaveBeenCalledWith('DARK', '#0b1f28'));
    expect(h.setSystemBarsBackground).toHaveBeenCalledWith('#0b1f28');
  });

  it('applies dark glyphs over a light bar for the light theme, using the resolved body background', async () => {
    h.addAppStateListener.mockResolvedValue(vi.fn());
    h.addBackButtonListener.mockResolvedValue(vi.fn());
    document.body.style.backgroundColor = 'rgb(255, 255, 255)';

    renderHook(() => useNativeShell());

    await waitFor(() => expect(h.setStatusBarStyle).toHaveBeenCalledWith('LIGHT', '#ffffff'));
  });

  it('applies light glyphs over a dark bar for the dark theme, converting the real rgb() background', async () => {
    h.addAppStateListener.mockResolvedValue(vi.fn());
    h.addBackButtonListener.mockResolvedValue(vi.fn());
    document.documentElement.classList.add('dark');
    document.body.style.backgroundColor = 'rgb(11, 31, 40)';

    renderHook(() => useNativeShell());

    await waitFor(() => expect(h.setStatusBarStyle).toHaveBeenCalledWith('DARK', '#0b1f28'));
  });

  it('falls back to the brand color when the background does not resolve to an rgb() (e.g. an unresolved oklch())', async () => {
    h.addAppStateListener.mockResolvedValue(vi.fn());
    h.addBackButtonListener.mockResolvedValue(vi.fn());
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      backgroundColor: 'oklch(1 0 0)',
    } as unknown as CSSStyleDeclaration);

    renderHook(() => useNativeShell());

    await waitFor(() => expect(h.setStatusBarStyle).toHaveBeenCalledWith('LIGHT', '#ffffff'));
  });

  it('falls back to the brand color rather than crashing when getComputedStyle itself throws', async () => {
    h.addAppStateListener.mockResolvedValue(vi.fn());
    h.addBackButtonListener.mockResolvedValue(vi.fn());
    document.documentElement.classList.add('dark');
    vi.spyOn(window, 'getComputedStyle').mockImplementation(() => {
      throw new Error('body not ready');
    });

    renderHook(() => useNativeShell());

    await waitFor(() => expect(h.setStatusBarStyle).toHaveBeenCalledWith('DARK', '#0b1f28'));
  });

  it('re-applies the status bar style when the theme class changes after mount', async () => {
    h.addAppStateListener.mockResolvedValue(vi.fn());
    h.addBackButtonListener.mockResolvedValue(vi.fn());
    // An explicit background, not jsdom's default computed style for an unstyled body
    // (transparent black, which itself resolves — accurately — to `#000000`).
    document.body.style.backgroundColor = 'rgb(255, 255, 255)';

    renderHook(() => useNativeShell());

    await waitFor(() => expect(h.setStatusBarStyle).toHaveBeenCalledWith('LIGHT', '#ffffff'));
    const callsBefore = h.setStatusBarStyle.mock.calls.length;

    act(() => {
      document.documentElement.classList.add('dark');
    });

    await waitFor(() => expect(h.setStatusBarStyle.mock.calls.length).toBeGreaterThan(callsBefore));
    expect(h.setStatusBarStyle).toHaveBeenLastCalledWith('DARK', expect.any(String));
  });
});

describe('useNativeShell — Android back button', () => {
  it('navigates back when history allows it', async () => {
    h.addAppStateListener.mockResolvedValue(vi.fn());
    const backButton = deferredListener<BackButtonHandler>();
    h.addBackButtonListener.mockImplementation(backButton.register);

    renderHook(() => useNativeShell());
    await act(async () => backButton.registered);

    act(() => backButton.handler()?.(true));

    expect(navigate).toHaveBeenCalledWith(-1);
    expect(h.exitApp).not.toHaveBeenCalled();
  });

  it('quits the app at the navigation root instead of doing nothing (the default Capacitor behavior)', async () => {
    h.addAppStateListener.mockResolvedValue(vi.fn());
    const backButton = deferredListener<BackButtonHandler>();
    h.addBackButtonListener.mockImplementation(backButton.register);

    renderHook(() => useNativeShell());
    await act(async () => backButton.registered);

    act(() => backButton.handler()?.(false));

    expect(h.exitApp).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('useNativeShell — cleanup', () => {
  it('unsubscribes both listeners on unmount', async () => {
    const appState = deferredListener<AppStateHandler>();
    const backButton = deferredListener<BackButtonHandler>();
    h.addAppStateListener.mockImplementation(appState.register);
    h.addBackButtonListener.mockImplementation(backButton.register);

    const { unmount } = renderHook(() => useNativeShell());
    await act(async () => Promise.all([appState.registered, backButton.registered]));

    unmount();

    expect(appState.unsubscribe).toHaveBeenCalledTimes(1);
    expect(backButton.unsubscribe).toHaveBeenCalledTimes(1);
    expect(document.documentElement.classList.contains('ci-native')).toBe(false);
  });

  it('unsubscribes the back-button listener immediately once it resolves after an early unmount', async () => {
    h.addAppStateListener.mockResolvedValue(vi.fn());

    let resolveRegister: ((unsubscribe: () => void) => void) | undefined;
    const unsubscribe = vi.fn();
    h.addBackButtonListener.mockImplementation(
      () =>
        new Promise<() => void>((resolve) => {
          resolveRegister = resolve;
        }),
    );

    const { unmount } = renderHook(() => useNativeShell());

    // Torn down before the async `addBackButtonListener` call ever resolves.
    unmount();
    expect(unsubscribe).not.toHaveBeenCalled();

    // The registration finally lands — the `disposed` guard must remove it right away
    // rather than leaking a listener past unmount.
    await act(async () => resolveRegister?.(unsubscribe));

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('stops re-applying the status bar style after unmount', async () => {
    h.addAppStateListener.mockResolvedValue(vi.fn());
    h.addBackButtonListener.mockResolvedValue(vi.fn());

    const { unmount } = renderHook(() => useNativeShell());
    await waitFor(() => expect(h.setStatusBarStyle).toHaveBeenCalled());

    const callsAtUnmount = h.setStatusBarStyle.mock.calls.length;
    unmount();

    document.documentElement.classList.add('dark');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.setStatusBarStyle.mock.calls.length).toBe(callsAtUnmount);
  });
});

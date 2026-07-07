import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ThemeToggle } from './ThemeToggle';
import { ThemeProvider, useTheme } from './useTheme';

// The canonical storage key the app writes the theme mode under. PR #1644 moved
// this from the legacy `ci-ui-theme` to `vite-ui-theme` as part of the design-system
// normalization; these tests pin that contract so a future rename fails loudly.
const STORAGE_KEY = 'vite-ui-theme';

function wrapper(mode: 'light' | 'dark' | 'system' = 'light') {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <ThemeProvider defaultTheme={mode} storageKey={STORAGE_KEY}>
        {children}
      </ThemeProvider>
    );
  };
}

describe('ThemeProvider / useTheme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('light', 'dark');
  });

  afterEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('light', 'dark');
  });

  it('applies the .light class to the document root for the light theme', () => {
    renderHook(() => useTheme(), { wrapper: wrapper('light') });

    const root = document.documentElement;
    expect(root.classList.contains('light')).toBe(true);
    expect(root.classList.contains('dark')).toBe(false);
  });

  it('setTheme("dark") swaps the root class from .light to .dark', () => {
    const { result } = renderHook(() => useTheme(), { wrapper: wrapper('light') });

    act(() => result.current.setTheme('dark'));

    const root = document.documentElement;
    expect(root.classList.contains('dark')).toBe(true);
    expect(root.classList.contains('light')).toBe(false);
  });

  it('persists the selected mode under the canonical storageKey "vite-ui-theme"', () => {
    const { result } = renderHook(() => useTheme(), { wrapper: wrapper('light') });

    act(() => result.current.setTheme('dark'));
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');

    act(() => result.current.setTheme('light'));
    expect(localStorage.getItem(STORAGE_KEY)).toBe('light');
  });

  it('rehydrates the mode from localStorage on mount', () => {
    localStorage.setItem(STORAGE_KEY, 'dark');

    const { result } = renderHook(() => useTheme(), { wrapper: wrapper('light') });

    // defaultTheme is "light" but the persisted value wins.
    expect(result.current.themeState.mode).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('falls back to an inert "system" default context outside a ThemeProvider', () => {
    // useTheme reads a createContext default (never undefined), so a bare hook
    // read yields a usable, inert state rather than throwing.
    const { result } = renderHook(() => useTheme());
    expect(result.current.themeState.mode).toBe('system');
  });
});

describe('ThemeToggle', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('light', 'dark');
  });

  it('cycles light -> dark -> system -> light and persists each step', async () => {
    render(<ThemeToggle />, { wrapper: wrapper('light') });

    const button = screen.getByRole('button');

    // light -> dark
    await act(async () => button.click());
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    // dark -> system
    await act(async () => button.click());
    expect(localStorage.getItem(STORAGE_KEY)).toBe('system');

    // system -> light
    await act(async () => button.click());
    expect(localStorage.getItem(STORAGE_KEY)).toBe('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });

  it('exposes an accessible label that reflects the next mode', () => {
    render(<ThemeToggle />, { wrapper: wrapper('light') });

    // From light, the next action is "Switch to dark mode".
    expect(screen.getByRole('button', { name: 'Switch to dark mode' })).toBeInTheDocument();
  });
});

import { act, renderHook } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BackgroundProvider, GLOW_STORAGE_KEY, readTexturePalette, useBackground } from './useBackground';
import { ThemeProvider, useTheme } from './useTheme';

function wrapper({ children }: { children: React.ReactNode }) {
  return <BackgroundProvider>{children}</BackgroundProvider>;
}

describe('BackgroundProvider pointer glow', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('defaults the pointer glow on', () => {
    const { result } = renderHook(() => useBackground(), { wrapper });

    expect(result.current.glowEnabled).toBe(true);
  });

  it('persists the glow toggle under ci-ui-glow', () => {
    const { result } = renderHook(() => useBackground(), { wrapper });

    act(() => result.current.setGlowEnabled(false));
    expect(localStorage.getItem(GLOW_STORAGE_KEY)).toBe('false');
    expect(result.current.glowEnabled).toBe(false);

    act(() => result.current.setGlowEnabled(true));
    expect(localStorage.getItem(GLOW_STORAGE_KEY)).toBe('true');
    expect(result.current.glowEnabled).toBe(true);
  });

  it('rehydrates the glow toggle from localStorage on mount', () => {
    localStorage.setItem(GLOW_STORAGE_KEY, 'false');

    const { result } = renderHook(() => useBackground(), { wrapper });

    expect(result.current.glowEnabled).toBe(false);
  });
});

/**
 * The Surface Texture previews and the page texture are drawn in the theme's
 * colours, read back off the root element. ThemeProvider writes those colours;
 * if a reader runs first it keeps the palette of the theme just left, which is
 * how the previews came to show dark swatches on a light page.
 */
describe('texture colours follow a theme change', () => {
  const root = document.documentElement;

  function themed({ children }: { children: React.ReactNode }) {
    return (
      <ThemeProvider defaultTheme="light" storageKey="vite-ui-theme">
        <BackgroundProvider>{children}</BackgroundProvider>
      </ThemeProvider>
    );
  }

  beforeEach(() => {
    localStorage.clear();
    // A generated colour theme writes its colours onto the root's inline
    // style; the Original theme leaves them to the stylesheet, which jsdom
    // does not have.
    localStorage.setItem('ci-ui-color-theme', JSON.stringify({ name: 'Crimson Red', baseHue: 0 }));
    localStorage.setItem('ci-ui-texture', 'cross-hatch');
  });

  afterEach(() => {
    localStorage.clear();
    root.classList.remove('light', 'dark');
    root.removeAttribute('style');
  });

  it('reads the new theme in an effect, not the one just left', () => {
    const { result } = renderHook(
      () => {
        const theme = useTheme();
        const [background, setBackground] = useState<string | null>(null);
        // What TexturePicker does: read the palette in an effect keyed on the theme.
        useEffect(() => {
          setBackground(readTexturePalette()?.background ?? null);
        }, [theme.themeState.mode]);

        return { theme, background };
      },
      { wrapper: themed },
    );

    const light = result.current.background;
    act(() => result.current.theme.setTheme('dark'));

    expect(result.current.background).not.toBe(light);
    expect(result.current.background).toBe(root.style.getPropertyValue('--background').trim());
  });

  it('redraws the page texture in the new theme’s colours', () => {
    const { result } = renderHook(() => useTheme(), { wrapper: themed });
    const lightTexture = root.style.getPropertyValue('--texture-image');

    act(() => result.current.setTheme('dark'));

    expect(lightTexture).not.toBe('');
    expect(root.style.getPropertyValue('--texture-image')).not.toBe(lightTexture);
  });
});

import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TexturePicker } from './TexturePicker';
import { BackgroundProvider, GLOW_STORAGE_KEY, useBackground } from './useBackground';
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

  it('draws the texture tiles in the new theme, not the one just left', () => {
    // jsdom has no canvas; without this the Conway preview logs a
    // "Not implemented" error for every tile build.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);

    let theme: ReturnType<typeof useTheme> | undefined;
    function ThemeHandle() {
      theme = useTheme();

      return null;
    }

    render(
      <>
        <ThemeHandle />
        <TexturePicker />
      </>,
      { wrapper: themed },
    );

    const swatch = screen.getByText('None').previousElementSibling as HTMLElement;
    const background = () => root.style.getPropertyValue('--background').trim();
    expect(swatch.style.backgroundColor).toBe(background());

    const light = swatch.style.backgroundColor;
    act(() => theme?.setTheme('dark'));

    expect(swatch.style.backgroundColor).not.toBe(light);
    expect(swatch.style.backgroundColor).toBe(background());
  });

  it('redraws the page texture in the new theme’s colours', () => {
    const { result } = renderHook(() => useTheme(), { wrapper: themed });
    const lightTexture = root.style.getPropertyValue('--texture-image');
    expect(lightTexture).not.toBe('');

    act(() => result.current.setTheme('dark'));

    expect(root.style.getPropertyValue('--texture-image')).not.toBe(lightTexture);
  });
});

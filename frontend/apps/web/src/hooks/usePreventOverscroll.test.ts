import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { usePreventOverscroll } from './usePreventOverscroll';

afterEach(() => {
  document.documentElement.style.removeProperty('--keyboard-inset');
  document.documentElement.style.removeProperty('--vv-height');
  vi.unstubAllGlobals();
});

describe('usePreventOverscroll', () => {
  it('publishes the keyboard overlap from the visual viewport', () => {
    const listeners = new Map<string, () => void>();

    vi.stubGlobal('visualViewport', {
      height: 500,
      offsetTop: 0,
      addEventListener: (name: string, handler: () => void) => {
        listeners.set(name, handler);
      },
      removeEventListener: (name: string) => {
        listeners.delete(name);
      },
    });
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800);

    renderHook(() => usePreventOverscroll());

    expect(document.documentElement.style.getPropertyValue('--keyboard-inset')).toBe('300px');
    expect(document.documentElement.style.getPropertyValue('--vv-height')).toBe('500px');

    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(500);
    Object.assign(window.visualViewport as VisualViewport, { height: 500 });
    listeners.get('resize')?.();

    expect(document.documentElement.style.getPropertyValue('--keyboard-inset')).toBe('0px');
  });
});

// Pinch-zoom shrinks the visual viewport without anything covering it. The phone column is
// `h-[var(--vv-height)]`, so reading that as a keyboard crushed the whole app to a fraction of
// the screen the moment the viewport meta stopped blocking zoom.
describe('usePreventOverscroll while the page is pinch-zoomed', () => {
  const published = (name: string) => document.documentElement.style.getPropertyValue(name);

  function stubVisualViewport(viewport: { height: number; scale: number; offsetTop?: number }) {
    const listeners = new Map<string, () => void>();

    vi.stubGlobal('visualViewport', {
      offsetTop: 0,
      ...viewport,
      addEventListener: (name: string, handler: () => void) => {
        listeners.set(name, handler);
      },
      removeEventListener: (name: string) => {
        listeners.delete(name);
      },
    });

    return listeners;
  }

  it('keeps the height in layout pixels and reports no keyboard', () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800);
    // A 2x pinch: the screen shows half the layout, panned 150px down.
    stubVisualViewport({ height: 400, scale: 2, offsetTop: 150 });

    renderHook(() => usePreventOverscroll());

    expect(published('--vv-height')).toBe('800px');
    expect(published('--keyboard-inset')).toBe('0px');
  });

  it('still reads a keyboard that opens while zoomed in', () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800);
    // 2x, and the keyboard takes 300 layout pixels: 500 are left, which is 250 on screen.
    stubVisualViewport({ height: 250, scale: 2 });

    renderHook(() => usePreventOverscroll());

    expect(published('--vv-height')).toBe('500px');
    expect(published('--keyboard-inset')).toBe('300px');
  });

  it('copes with an engine whose innerHeight follows the zoom', () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(400);
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(800);
    stubVisualViewport({ height: 400, scale: 2 });

    renderHook(() => usePreventOverscroll());

    expect(published('--vv-height')).toBe('800px');
    expect(published('--keyboard-inset')).toBe('0px');
  });

  it('follows the zoom as it changes, and rounds the scaled height', () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(844);
    const listeners = stubVisualViewport({ height: 844, scale: 1 });

    renderHook(() => usePreventOverscroll());

    // What Chromium reported for a 3x pinch on an 844px layout: 281.33px on screen.
    Object.assign(window.visualViewport as VisualViewport, { height: 281.3333435058594, scale: 3 });
    listeners.get('resize')?.();

    expect(published('--vv-height')).toBe('844px');
    expect(published('--keyboard-inset')).toBe('0px');

    Object.assign(window.visualViewport as VisualViewport, { height: 844, scale: 1 });
    listeners.get('resize')?.();

    expect(published('--vv-height')).toBe('844px');
  });

  it('leaves the scroll alone while zoomed, but still cancels the keyboard scroll at 1x', () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800);
    const scrollTo = vi.spyOn(window, 'scrollTo');
    const listeners = stubVisualViewport({ height: 400, scale: 2, offsetTop: 200 });

    renderHook(() => usePreventOverscroll());
    listeners.get('scroll')?.();

    expect(scrollTo).not.toHaveBeenCalled();

    // Zoomed back out, and the keyboard has walked the visual viewport down 40px.
    Object.assign(window.visualViewport as VisualViewport, { height: 760, scale: 1, offsetTop: 40 });
    listeners.get('scroll')?.();

    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });
});

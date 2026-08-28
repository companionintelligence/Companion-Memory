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

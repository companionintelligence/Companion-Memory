import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  canScrollY,
  findFrontmostScroller,
  readSafeAreaTop,
  scrollFrontmostListToTop,
  useStatusBarScrollToTop,
} from './useStatusBarScrollToTop';

function mountScroller(options: { scrolled?: boolean; marked?: 'page' | 'list'; id?: string } = {}) {
  const el = document.createElement('div');
  if (options.id) {
    el.id = options.id;
  }

  el.style.overflowY = 'auto';
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: 400 });
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 2000 });
  el.scrollTop = options.scrolled ? 800 : 0;
  if (options.marked === 'page') {
    el.setAttribute('data-page-scroll', '');
  }

  if (options.marked === 'list') {
    el.setAttribute('data-list-scroll', '');
  }

  el.scrollTo = vi.fn(function (this: HTMLElement, arg?: ScrollToOptions | number) {
    if (typeof arg === 'object' && arg.top != null) {
      this.scrollTop = arg.top;
    }
  }) as unknown as typeof el.scrollTo;

  document.body.appendChild(el);

  return el;
}

function tapSafeArea(clientY = 12) {
  document.dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, clientX: 120, clientY, pointerType: 'touch' }),
  );
  document.dispatchEvent(
    new PointerEvent('pointerup', { bubbles: true, clientX: 120, clientY, pointerType: 'touch' }),
  );
}

beforeEach(() => {
  document.documentElement.style.setProperty('--safe-area-top', '59px');
});

afterEach(() => {
  document.documentElement.style.removeProperty('--safe-area-top');
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('readSafeAreaTop', () => {
  it('resolves the CSS variable to pixels', () => {
    expect(readSafeAreaTop()).toBe(59);
  });
});

describe('canScrollY', () => {
  it('is true only when overflow-y can move and content is taller than the box', () => {
    const el = mountScroller();

    expect(canScrollY(el)).toBe(true);

    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 400 });
    expect(canScrollY(el)).toBe(false);

    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 2000 });
    el.style.overflowY = 'hidden';
    expect(canScrollY(el)).toBe(false);
  });
});

describe('findFrontmostScroller', () => {
  it('prefers the innermost list that has actually scrolled', () => {
    const page = mountScroller({ marked: 'page' });
    const list = document.createElement('div');
    list.style.overflowY = 'auto';
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1800 });
    list.scrollTop = 320;
    page.appendChild(list);

    expect(findFrontmostScroller()).toBe(list);
  });

  it('falls back to a marked page scroller when nothing has moved', () => {
    const page = mountScroller({ marked: 'page' });

    expect(findFrontmostScroller()).toBe(page);
  });

  it('uses a filled overlay portal ahead of the page behind it', () => {
    const page = mountScroller({ marked: 'page', scrolled: true });
    const overlay = document.createElement('div');
    overlay.id = 'overlay-modal';
    document.body.appendChild(overlay);
    const sheet = mountScroller({ scrolled: true });
    overlay.appendChild(sheet);

    expect(findFrontmostScroller()).toBe(sheet);
    expect(findFrontmostScroller()).not.toBe(page);
  });
});

describe('scrollFrontmostListToTop', () => {
  it('smooth-scrolls the frontmost list to top', () => {
    const list = mountScroller({ marked: 'list', scrolled: true });

    expect(scrollFrontmostListToTop()).toBe(true);
    expect(list.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
  });
});

describe('useStatusBarScrollToTop', () => {
  it('scrolls on a tap in the top safe area', () => {
    const list = mountScroller({ marked: 'page', scrolled: true });
    renderHook(() => useStatusBarScrollToTop(true));

    tapSafeArea();

    expect(list.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
  });

  it('ignores taps below the safe area', () => {
    const list = mountScroller({ marked: 'page', scrolled: true });
    renderHook(() => useStatusBarScrollToTop(true));

    tapSafeArea(120);

    expect(list.scrollTo).not.toHaveBeenCalled();
  });

  it('does not steal taps on controls in the safe area', () => {
    const list = mountScroller({ marked: 'page', scrolled: true });
    const button = document.createElement('button');
    button.textContent = 'Close';
    document.body.appendChild(button);
    renderHook(() => useStatusBarScrollToTop(true));

    button.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, clientX: 20, clientY: 12, pointerType: 'touch' }),
    );
    button.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, clientX: 20, clientY: 12, pointerType: 'touch' }),
    );

    expect(list.scrollTo).not.toHaveBeenCalled();
  });

  it('does not listen when disabled', () => {
    const list = mountScroller({ marked: 'page', scrolled: true });
    renderHook(() => useStatusBarScrollToTop(false));

    tapSafeArea();

    expect(list.scrollTo).not.toHaveBeenCalled();
  });
});

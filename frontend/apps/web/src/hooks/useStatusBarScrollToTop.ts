import { useEffect } from 'react';

const SCROLLABLE_OVERFLOW = new Set(['auto', 'scroll', 'overlay']);
const INTERACTIVE_SELECTOR =
  'a, button, input, textarea, select, label, [role="button"], [role="tab"], [role="link"], [contenteditable="true"]';
const TAP_SLOP_PX = 10;

/**
 * iOS taps the status bar / top safe area to jump a list back to the top.
 * Native `UIScrollView.scrollsToTop` only moves the webview's own scroller;
 * our pages lock document scroll (`usePreventOverscroll`) and move inner
 * `overflow` lists instead, so WKWebView never sees the gesture.
 *
 * A tap in the top safe area that isn't on a control finds the frontmost
 * vertical scroller — `[data-page-scroll]` / `[data-list-scroll]` when that's
 * the one that moved, otherwise any overflow-y list that's scrolled — and
 * sends it to top. Nested lists (Memory, Plan, Chat, sheets) pick this up
 * without each page wiring a handler.
 */
export function useStatusBarScrollToTop(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) {
      return;
    }

    let down: { x: number; y: number } | null = null;

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) {
        down = null;

        return;
      }

      if (event.clientY > readSafeAreaTop()) {
        down = null;

        return;
      }

      down = { x: event.clientX, y: event.clientY };
    };

    const onPointerUp = (event: PointerEvent) => {
      const origin = down;
      down = null;

      if (!origin) {
        return;
      }

      const safeTop = readSafeAreaTop();
      if (safeTop <= 0 || event.clientY > safeTop) {
        return;
      }

      if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > TAP_SLOP_PX) {
        return;
      }

      if (event.target instanceof Element && event.target.closest(INTERACTIVE_SELECTOR)) {
        return;
      }

      scrollFrontmostListToTop();
    };

    document.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
    document.addEventListener('pointerup', onPointerUp, { passive: true });

    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointerup', onPointerUp);
    };
  }, [enabled]);
}

/** Used value of `--safe-area-top` in CSS pixels (handles `max(env(…), 59px)`). */
export function readSafeAreaTop(): number {
  const specified = getComputedStyle(document.documentElement).getPropertyValue('--safe-area-top').trim();
  const fromVar = parseFloat(specified);
  if (Number.isFinite(fromVar) && fromVar > 0) {
    return fromVar;
  }

  const probe = document.createElement('div');
  probe.style.cssText =
    'position:absolute;visibility:hidden;pointer-events:none;padding-top:var(--safe-area-top, 0px)';
  document.body.appendChild(probe);
  const px = parseFloat(getComputedStyle(probe).paddingTop);
  probe.remove();

  return Number.isFinite(px) ? px : 0;
}

export function canScrollY(el: HTMLElement): boolean {
  const overflowY = getComputedStyle(el).overflowY;

  return SCROLLABLE_OVERFLOW.has(overflowY) && el.scrollHeight > el.clientHeight + 1;
}

function isVisibleScroller(el: HTMLElement): boolean {
  if (!el.isConnected || el.hidden) {
    return false;
  }

  if (el.closest('[hidden], [aria-hidden="true"]')) {
    return false;
  }

  const style = getComputedStyle(el);

  return style.display !== 'none' && style.visibility !== 'hidden' && canScrollY(el);
}

function walkScrollers(root: ParentNode): HTMLElement[] {
  const found: HTMLElement[] = [];

  if (root instanceof HTMLElement && isVisibleScroller(root)) {
    found.push(root);
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof HTMLElement && isVisibleScroller(node)) {
      found.push(node);
    }
  }

  return found;
}

function innermost(els: HTMLElement[]): HTMLElement {
  return els.reduce((best, el) => {
    if (best.contains(el)) {
      return el;
    }

    if (el.contains(best)) {
      return best;
    }

    return el.scrollTop >= best.scrollTop ? el : best;
  });
}

function portalRoot(id: string): HTMLElement | null {
  const portal = document.getElementById(id);

  return portal && portal.childElementCount > 0 ? portal : null;
}

/**
 * The list that's actually on screen: a sheet/modal if one is open, else the
 * innermost scroller that has moved, else a marked page scroller.
 */
export function findFrontmostScroller(): HTMLElement | null {
  const root = portalRoot('overlay-modal') ?? portalRoot('content-modal') ?? document;
  const scrollers = walkScrollers(root);
  const scrolled = scrollers.filter((el) => el.scrollTop > 1);

  if (scrolled.length > 0) {
    return innermost(scrolled);
  }

  const marked = scrollers.filter(
    (el) => el.hasAttribute('data-page-scroll') || el.hasAttribute('data-list-scroll'),
  );

  if (marked.length > 0) {
    return innermost(marked);
  }

  return scrollers.length > 0 ? innermost(scrollers) : null;
}

export function scrollFrontmostListToTop(): boolean {
  const target = findFrontmostScroller();

  if (!target) {
    return false;
  }

  const behavior: ScrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 'instant'
    : 'smooth';
  target.scrollTo({ top: 0, behavior });

  return true;
}

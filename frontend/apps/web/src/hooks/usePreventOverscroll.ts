import { useLayoutEffect, useRef } from 'react';

/**
 * Keep the phone chrome pinned when iOS opens the keyboard.
 *
 * WKWebView / Safari scrolls the visual viewport to keep the caret on screen,
 * which walks the header off the top and parks bottom sheets under the keys.
 * We publish the visible height and keyboard overlap as CSS vars, and cancel
 * that viewport scroll so inner overflow (notes, sheets) is what moves.
 *
 * Pinch-zoom shrinks the visual viewport as well, and that is not a keyboard.
 * The height is taken back to layout pixels, and the scroll reset is skipped
 * while zoomed in, because then the scroll is the person panning to read.
 */
function syncVisualViewportInsets() {
  const viewport = window.visualViewport;
  const root = document.documentElement;

  if (!viewport) {
    root.style.setProperty('--keyboard-inset', '0px');
    root.style.setProperty('--vv-height', '100dvh');

    return;
  }

  // `viewport.height` is the area on screen at the current zoom, so a 2x pinch
  // halves it. Left as is, the column sized by `--vv-height` is crushed to a
  // fraction of the screen the moment anyone zooms.
  const zoomed = viewport.scale > 1.01;
  const visibleHeight = zoomed ? Math.round(viewport.height * viewport.scale) : viewport.height;
  // `innerHeight` follows the zoom in some engines and `clientHeight` never
  // does, so the larger of the two is the layout height in all of them.
  const layoutHeight = Math.max(window.innerHeight, root.clientHeight);
  const keyboard = Math.max(0, layoutHeight - visibleHeight);
  root.style.setProperty('--keyboard-inset', `${keyboard}px`);
  root.style.setProperty('--vv-height', `${visibleHeight}px`);

  if (!zoomed && (window.scrollY !== 0 || viewport.offsetTop !== 0)) {
    window.scrollTo(0, 0);
  }
}

export function usePreventOverscroll(isLocked: boolean = true) {
  const scrollPosition = useRef(0);

  useLayoutEffect(() => {
    if (isLocked) {
      scrollPosition.current = window.scrollY;

      const { style } = document.body;

      style.overflow = 'hidden';
      style.position = 'fixed';
      style.width = '100%';
      style.top = `-${scrollPosition.current}px`;

      return () => {
        style.overflow = '';
        style.position = '';
        style.width = '';
        style.top = '';

        window.scrollTo(0, scrollPosition.current);
      };
    }

    return undefined;
  }, [isLocked]);

  useLayoutEffect(() => {
    syncVisualViewportInsets();

    const viewport = window.visualViewport;

    viewport?.addEventListener('resize', syncVisualViewportInsets);
    viewport?.addEventListener('scroll', syncVisualViewportInsets);
    window.addEventListener('orientationchange', syncVisualViewportInsets);

    return () => {
      viewport?.removeEventListener('resize', syncVisualViewportInsets);
      viewport?.removeEventListener('scroll', syncVisualViewportInsets);
      window.removeEventListener('orientationchange', syncVisualViewportInsets);
      document.documentElement.style.removeProperty('--keyboard-inset');
      document.documentElement.style.removeProperty('--vv-height');
    };
  }, []);
}

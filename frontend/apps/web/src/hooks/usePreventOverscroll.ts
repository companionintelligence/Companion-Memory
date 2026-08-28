import { useLayoutEffect, useRef } from 'react';

/**
 * Keep the phone chrome pinned when iOS opens the keyboard.
 *
 * WKWebView / Safari scrolls the visual viewport to keep the caret on screen,
 * which walks the header off the top and parks bottom sheets under the keys.
 * We publish the visible height and keyboard overlap as CSS vars, and cancel
 * that viewport scroll so inner overflow (notes, sheets) is what moves.
 */
function syncVisualViewportInsets() {
  const viewport = window.visualViewport;
  const root = document.documentElement;

  if (!viewport) {
    root.style.setProperty('--keyboard-inset', '0px');
    root.style.setProperty('--vv-height', '100dvh');

    return;
  }

  const keyboard = Math.max(0, window.innerHeight - viewport.height);
  root.style.setProperty('--keyboard-inset', `${keyboard}px`);
  root.style.setProperty('--vv-height', `${viewport.height}px`);

  if (window.scrollY !== 0 || viewport.offsetTop !== 0) {
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

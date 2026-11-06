import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Whether the viewer has asked the OS for reduced motion, read once. For code
 * that is not a component — a gesture's release, a scroll's behaviour. False
 * where there is no window or no `matchMedia` (a test, a server render).
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }

  return window.matchMedia(QUERY).matches;
}

/**
 * Whether the viewer has asked the OS for reduced motion, kept live.
 *
 * Motion cannot always simply be switched off — the map's fly-through is
 * motion by definition, so what changes there is the CAMERA: it stops gliding
 * and re-centres in discrete steps. What goes away everywhere is continuous,
 * unrequested movement, which is what triggers vestibular symptoms.
 *
 * Live, not read-once: macOS and Windows both let this be toggled without
 * reloading the page, and a viewer turning it on mid-playback is exactly the
 * viewer who needs it to take effect immediately.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => prefersReducedMotion());

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const query = window.matchMedia(QUERY);
    const onChange = () => setReduced(query.matches);

    setReduced(query.matches);
    query.addEventListener('change', onChange);

    return () => query.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

import { useEffect, useState } from 'react';

/**
 * Whether the viewer has asked the OS for reduced motion.
 *
 * The fly-through is motion by definition, so it cannot simply be switched off
 * — what changes is the CAMERA. With reduced motion the map stops gliding and
 * instead re-centres in discrete steps, only when the playhead would otherwise
 * leave the screen. The trace still draws and the playhead still moves; what
 * goes away is the continuous, unrequested panning that triggers vestibular
 * symptoms.
 *
 * Live, not read-once: macOS and Windows both let this be toggled without
 * reloading the page, and a viewer turning it on mid-playback is exactly the
 * viewer who needs it to take effect immediately.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => matches());

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(query.matches);

    setReduced(query.matches);
    query.addEventListener('change', onChange);

    return () => query.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

function matches(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }

  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

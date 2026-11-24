import { useEffect, useRef } from 'react';

/** Two signals for one return (focus then visibility) count once. */
const RETURN_THROTTLE_MS = 1_000;

/**
 * Re-run `refetch` when the person comes back: the tab becomes visible again,
 * the window regains focus, or the browser comes back online. A page left open
 * on another screen while an edit was made elsewhere is then current the moment
 * it is looked at, whether or not the live stream was up while it was away. A
 * page that sat through a dropped connection is current again as soon as the
 * connection is, instead of at the next poll.
 *
 * Not on mount — the query already ran — and not while hidden, where a focus
 * event can still arrive.
 */
export function useRefetchOnReturn(refetch: () => void): void {
  const refetchRef = useRef(refetch);

  useEffect(() => {
    refetchRef.current = refetch;
  }, [refetch]);

  useEffect(() => {
    let last = Date.now();

    const onReturn = () => {
      if (document.visibilityState === 'hidden') {
        return;
      }

      const now = Date.now();

      if (now - last < RETURN_THROTTLE_MS) {
        return;
      }

      last = now;
      refetchRef.current();
    };

    // Not throttled against the other two. On waking a laptop the focus or
    // visibility refetch often goes out before the network is back and fails,
    // and `online` lands a moment later; swallowing it as the same return
    // would leave the page on that failure until the next poll.
    const onOnline = () => {
      if (document.visibilityState === 'hidden') {
        return;
      }

      last = Date.now();
      refetchRef.current();
    };

    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    window.addEventListener('online', onOnline);

    return () => {
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
      window.removeEventListener('online', onOnline);
    };
  }, []);
}

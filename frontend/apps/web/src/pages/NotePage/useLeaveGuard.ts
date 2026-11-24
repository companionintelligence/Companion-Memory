import { useCallback, useContext, useEffect, useRef, useState } from 'react';

import { UNSAFE_NavigationContext } from 'react-router-dom';

/**
 * Asks before the page is left while something on it is not saved.
 *
 * - `unsaved`: closing or reloading the tab asks. Nothing can save once the page is going,
 *   so the browser's own "Leave site?" question is the only thing that can step in.
 * - `ask`: links and `navigate()` inside the app ask. React Router's `useBlocker` only
 *   works under a data router and the app runs on `BrowserRouter`, so while this is armed
 *   the router's history is wrapped instead, and the page asks with its own dialog
 *   (`asking`, then `stay` or `leave`). The browser's Back button goes around it: by the
 *   time the app hears of that, the history entry has already changed.
 *
 * A navigation held for the question goes ahead by itself once nothing is unsaved (the
 * save landed while the question was up). `allow` lets one of the page's own navigations
 * through, such as a new note moving to the id it was saved under.
 */
export function useLeaveGuard({ unsaved, ask }: { unsaved: boolean; ask: boolean }) {
  const { navigator } = useContext(UNSAFE_NavigationContext);
  const [held, setHeld] = useState<(() => void) | null>(null);
  const allowingRef = useRef(false);

  useEffect(() => {
    if (!unsaved) {
      return;
    }

    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };

    window.addEventListener('beforeunload', warn);

    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved]);

  useEffect(() => {
    if (!ask) {
      return;
    }

    const { push, replace, go } = navigator;

    const hold = (proceed: () => void) => {
      if (allowingRef.current) {
        proceed();

        return;
      }

      setHeld(() => proceed);
    };

    navigator.push = (...args) => hold(() => push(...args));
    navigator.replace = (...args) => hold(() => replace(...args));
    navigator.go = (delta) => hold(() => go(delta));

    return () => {
      navigator.push = push;
      navigator.replace = replace;
      navigator.go = go;
    };
  }, [navigator, ask]);

  // Everything was saved while the question was up: go where the person was going. Not on
  // `ask` turning off, which also happens for a moment between a save failing and the page
  // noting the failure.
  useEffect(() => {
    if (!unsaved && held) {
      setHeld(null);
      held();
    }
  }, [unsaved, held]);

  const allow = useCallback((navigation: () => void) => {
    allowingRef.current = true;

    try {
      navigation();
    } finally {
      allowingRef.current = false;
    }
  }, []);

  return {
    asking: held !== null,
    stay: () => setHeld(null),
    leave: () => {
      setHeld(null);
      held?.();
    },
    allow,
  };
}

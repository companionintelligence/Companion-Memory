import { useEffect, useRef } from 'react';

import { useLocation, useNavigate } from 'react-router-dom';

/** The history-state key that marks the entry this hook pushed for an open sheet. */
const STATE_KEY = 'backClosesSheet';

type SheetState = { [STATE_KEY]?: string } | null;

/**
 * Make Back close an open sheet instead of leaving the page.
 *
 * A details drawer is not a route: opening it changes nothing in the URL, so the
 * browser's Back button (and the Android hardware button, which `useNativeShell`
 * maps to `navigate(-1)`) left the page with the drawer still "open" in state.
 * This pushes one history entry — same URL, tagged in `location.state` — when the
 * sheet opens, and treats that entry disappearing while the sheet is still open as
 * a Back press. Closing the sheet from its own controls pops the entry again, so
 * history reads the same as if the drawer had never opened.
 *
 * The tag is unique per mount: a page remounted onto a stale entry (Back after
 * navigating elsewhere from inside the drawer) does not reopen anything, it just
 * costs one more Back press.
 *
 * `open` is the sheet's effective visibility (mounted AND open), `close` is what
 * its `onOpenChange(false)` does.
 */
export function useBackClosesSheet(open: boolean, close: () => void): void {
  const location = useLocation();
  const navigate = useNavigate();

  const token = useRef<string | null>(null);
  token.current ??= `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  const closeRef = useRef(close);
  closeRef.current = close;

  const entryOnTop = (location.state as SheetState)?.[STATE_KEY] === token.current;

  // Keep the latest location in a ref so the open/close effect can read it
  // without re-running on every navigation.
  const locationRef = useRef(location);
  locationRef.current = location;
  const entryOnTopRef = useRef(entryOnTop);
  entryOnTopRef.current = entryOnTop;

  const wasOpen = useRef(false);
  // Set once our entry has been seen on top; only then is its disappearance a Back.
  const armed = useRef(false);

  useEffect(() => {
    if (open && !wasOpen.current) {
      wasOpen.current = true;

      if (!entryOnTopRef.current) {
        const { pathname, search, hash, state } = locationRef.current;

        navigate(
          { pathname, search, hash },
          { state: { ...((state as object | null) ?? {}), [STATE_KEY]: token.current } },
        );
      }
    } else if (!open && wasOpen.current) {
      wasOpen.current = false;

      if (entryOnTopRef.current) {
        navigate(-1);
      }
    }
  }, [open, navigate]);

  useEffect(() => {
    if (!open) {
      armed.current = false;

      return;
    }

    if (entryOnTop) {
      armed.current = true;
    } else if (armed.current) {
      armed.current = false;
      closeRef.current();
    }
  }, [open, entryOnTop]);
}

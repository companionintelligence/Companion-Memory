import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';

const STORAGE_KEY = 'ci-power-rail-expanded';

export type PowerRailVariant = 'dock' | 'overlay';

interface PowerRailContextValue {
  /** Showing labels right now — pinned open, or held by a popover. */
  expanded: boolean;
  /** Pinned open by a deliberate click. Persisted; survives a reload. */
  pinned: boolean;
  /**
   * Keeps an already-wide rail wide while something that lives outside the
   * rail DOM (the portaled colour picker) is open, so unpinning underneath it
   * does not collapse the rail mid-click. Set it only while `expanded` is
   * true: holding a collapsed rail widens it, and the swap to the expanded
   * tree remounts whatever asked for the hold.
   */
  holdOpen: boolean;
  /** `overlay` is the phone drawer; `dock` is the desktop lane. */
  variant: PowerRailVariant;
  /** Pin it open, or unpin it. On overlay, opens or closes the drawer. */
  toggle: () => void;
  openOverlay: () => void;
  closeOverlay: () => void;
  setHoldOpen: (holdOpen: boolean) => void;
  /**
   * Which rail submenu is open by a click. Exclusive: clicking Jobs open
   * must close Planning, not stack both.
   */
  openSubmenuId: string | null;
  setOpenSubmenuId: Dispatch<SetStateAction<string | null>>;
}

const PowerRailContext = createContext<PowerRailContextValue | null>(null);

function readStoredExpanded(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeStoredExpanded(expanded: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, String(expanded));
  } catch {
    // Private mode / quota — the session still toggles.
  }
}

export function PowerRailProvider({
  children,
  variant = 'dock',
}: {
  children: ReactNode;
  variant?: PowerRailVariant;
}) {
  // The rail only widens on a deliberate click. `pinned` is that decision: it
  // persists across a reload. `holdOpen` only keeps a wide rail wide: while a
  // portaled popover (Colours) opened from it is up, unpinning underneath must
  // not collapse it. It never widens a collapsed rail.
  //
  // Overlay (phone) is a third case: a swipe or the edge control opens a
  // drawer over the page. It is not pinned and not stored.
  const [pinned, setPinned] = useState(variant === 'dock' ? readStoredExpanded : false);
  const [holdOpen, setHoldOpen] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [openSubmenuId, setOpenSubmenuId] = useState<string | null>(null);

  const toggle = useCallback(() => {
    if (variant === 'overlay') {
      setOverlayOpen((current) => !current);

      return;
    }

    setPinned((current) => {
      const next = !current;
      writeStoredExpanded(next);

      return next;
    });
  }, [variant]);

  const openOverlay = useCallback(() => setOverlayOpen(true), []);
  const closeOverlay = useCallback(() => setOverlayOpen(false), []);

  const value = useMemo(
    () => ({
      expanded: variant === 'overlay' ? overlayOpen : pinned || holdOpen,
      // Overlay is always a floating drawer, never a pinned column.
      pinned: variant === 'overlay' ? false : pinned,
      holdOpen,
      variant,
      toggle,
      openOverlay,
      closeOverlay,
      setHoldOpen,
      openSubmenuId,
      setOpenSubmenuId,
    }),
    [variant, overlayOpen, pinned, holdOpen, toggle, openOverlay, closeOverlay, openSubmenuId],
  );

  return <PowerRailContext.Provider value={value}>{children}</PowerRailContext.Provider>;
}

export function usePowerRail() {
  const context = useContext(PowerRailContext);

  if (!context) {
    throw new Error('usePowerRail must be used within a PowerRailProvider.');
  }

  return context;
}

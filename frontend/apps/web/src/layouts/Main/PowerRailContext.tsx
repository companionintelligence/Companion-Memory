import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

const STORAGE_KEY = 'ci-power-rail-expanded';

export type PowerRailVariant = 'dock' | 'overlay';

interface PowerRailContextValue {
  /** Showing labels right now — pinned open, or held open by a popover. */
  expanded: boolean;
  /** Pinned open by a deliberate choice. Persisted; survives the pointer leaving. */
  pinned: boolean;
  /**
   * Held open by an interaction that lives outside the rail DOM (e.g. a
   * portaled colour picker). Without this, moving into the portal fires
   * mouseleave and collapses the rail mid-click.
   */
  holdOpen: boolean;
  /** `overlay` is the mobile glass drawer; `dock` is the desktop lane. */
  variant: PowerRailVariant;
  /** Pin it open, or unpin it. On overlay, opens or closes the drawer. */
  toggle: () => void;
  openOverlay: () => void;
  closeOverlay: () => void;
  /**
   * Whether the pointer/focus is inside the rail. No longer widens anything —
   * it exists only so leaving closes a submenu that hover opened. See the
   * note on `expanded` in the provider for why width stopped following it.
   */
  setPointerWithin: (within: boolean) => void;
  setHoldOpen: (holdOpen: boolean) => void;
  /**
   * Which rail submenu the pointer is in. Hover is exclusive: opening Jobs
   * must close Planning, not stack both.
   */
  hoveredSubmenuId: string | null;
  setHoveredSubmenuId: (id: string | null) => void;
  /** Chevron-pinned submenu. One at a time; a peer pin replaces it. */
  stickySubmenuId: string | null;
  setStickySubmenuId: (id: string | null) => void;
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
  // The rail opens because someone asked it to, and for no other reason.
  //
  // `pinned` is that decision: persisted, and it survives both the pointer
  // leaving and a reload. It used to be one of two reasons, the other being
  // hover — brushing past the rail on the way to something else widened a
  // drawer over the page. That is now gone: passing a pointer near an edge is
  // not a request, and the cost of guessing wrong was paid on every stray
  // mouse movement.
  //
  // `holdOpen` is the one remaining involuntary reason, and it only ever keeps
  // an already-open rail open: a portaled popover (Colours) has taken the
  // pointer outside the rail's DOM, which fires mouseleave, and collapsing
  // underneath an open picker would be a bug rather than a preference.
  //
  // Overlay (phone) is separate: a swipe or the edge control opens a glass
  // drawer. It is not pinned, not stored, and never pointer-driven.
  const [pinned, setPinned] = useState(variant === 'dock' ? readStoredExpanded : false);
  const [holdOpen, setHoldOpen] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [hoveredSubmenuId, setHoveredSubmenuId] = useState<string | null>(null);
  const [stickySubmenuId, setStickySubmenuId] = useState<string | null>(null);

  // Leaving the rail still closes whatever submenu hover opened inside it —
  // that hover is between the groups in the rail, not the rail and the page,
  // and it is unaffected by the width change.
  const setPointerWithin = useCallback((within: boolean) => {
    if (!within) {
      setHoveredSubmenuId(null);
    }
  }, []);

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
      setPointerWithin,
      setHoldOpen,
      hoveredSubmenuId,
      setHoveredSubmenuId,
      stickySubmenuId,
      setStickySubmenuId,
    }),
    [
      variant,
      overlayOpen,
      pinned,
      holdOpen,
      toggle,
      openOverlay,
      closeOverlay,
      setPointerWithin,
      hoveredSubmenuId,
      stickySubmenuId,
    ],
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

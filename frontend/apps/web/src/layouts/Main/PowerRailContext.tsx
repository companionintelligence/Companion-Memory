import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

const STORAGE_KEY = 'ci-power-rail-expanded';

export type PowerRailVariant = 'dock' | 'overlay';

interface PowerRailContextValue {
  /** Showing labels right now — pinned open, hovered open, or held by a popover. */
  expanded: boolean;
  /** Pinned open by a deliberate choice. Persisted; survives the pointer leaving. */
  pinned: boolean;
  /** Open only because the pointer (or focus) is in it. */
  hovered: boolean;
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
  setHovered: (hovered: boolean) => void;
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
  // Two reasons the rail is open, and they must not fight. `pinned` is a
  // decision: it survives the pointer leaving, and a reload. `hovered` is a
  // passing intention that expires the moment you move away. Pinned wins, so
  // brushing across a pinned rail never collapses it, and a mouse passing
  // through never overwrites the stored preference.
  //
  // `holdOpen` is a third reason: a portaled popover (Colours) is open, so the
  // pointer left the rail on purpose and must not collapse it underneath.
  //
  // Overlay (phone) is a fourth: a swipe or the edge control opens a glass
  // drawer. It is not pinned, not stored, and never hover-driven.
  const [pinned, setPinned] = useState(variant === 'dock' ? readStoredExpanded : false);
  const [hovered, setHoveredState] = useState(false);
  const [holdOpen, setHoldOpen] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [hoveredSubmenuId, setHoveredSubmenuId] = useState<string | null>(null);
  const [stickySubmenuId, setStickySubmenuId] = useState<string | null>(null);

  const setHovered = useCallback((next: boolean) => {
    setHoveredState(next);
    if (!next) {
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
      expanded: variant === 'overlay' ? overlayOpen : pinned || hovered || holdOpen,
      // Overlay is always a floating drawer, never a pinned column.
      pinned: variant === 'overlay' ? false : pinned,
      hovered: variant === 'overlay' ? overlayOpen : hovered,
      holdOpen,
      variant,
      toggle,
      openOverlay,
      closeOverlay,
      setHovered,
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
      hovered,
      holdOpen,
      toggle,
      openOverlay,
      closeOverlay,
      setHovered,
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

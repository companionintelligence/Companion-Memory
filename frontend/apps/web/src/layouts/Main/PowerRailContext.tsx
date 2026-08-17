import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

const STORAGE_KEY = 'ci-power-rail-expanded';

interface PowerRailContextValue {
  /** Whether the rail is showing labels right now, pinned or hovered. */
  expanded: boolean;
  /** Pin it open, or unpin it. Persisted. */
  toggle: () => void;
  /** The pointer entered or left the rail. */
  setHovered: (hovered: boolean) => void;
  /** Pinned open by a deliberate choice, as opposed to merely hovered. */
  pinned: boolean;
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

export function PowerRailProvider({ children }: { children: ReactNode }) {
  // Two reasons the rail is open, and they must not fight. `pinned` is a
  // decision — it survives the pointer leaving, and a reload. `hovered` is a
  // passing intention that expires the moment you move away. Pinned wins, so
  // hovering a pinned rail and leaving again does not collapse it, and the
  // stored preference is never overwritten by a mouse passing through.
  const [pinned, setPinned] = useState(readStoredExpanded);
  const [hovered, setHovered] = useState(false);

  const toggle = useCallback(() => {
    setPinned((current) => {
      const next = !current;
      writeStoredExpanded(next);

      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ expanded: pinned || hovered, pinned, toggle, setHovered }),
    [pinned, hovered, toggle],
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

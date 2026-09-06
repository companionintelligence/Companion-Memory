import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/**
 * What the host's single footer should show for the step that is currently on
 * screen. Every field is optional: a step that says nothing gets the host's
 * own defaults, which is what a plain question step wants.
 */
export interface WizardNavState {
  /** Primary control's label. Omitted: the host's default ("Next"). */
  primaryLabel?: string;
  /** Disable the primary control — prefer changing what it does over this. */
  primaryDisabled?: boolean;
  /**
   * What the primary control does. Omitted: advance the host's own step.
   *
   * A nested flow uses this to consume the press for its own sub-phase, so the
   * one button on screen means "forward" at whatever depth the user is at.
   */
  onPrimary?: () => void;
  /**
   * What Back does. Omitted: the host's own previous step. `null` hides Back.
   *
   * A nested flow sets this to walk back through its sub-phases first, so Back
   * is the exact inverse of the primary control at every depth.
   */
  onBack?: (() => void) | null;
}

interface WizardNavContextValue {
  /** The active step's overrides, or null when it has not registered any. */
  readonly nav: WizardNavState | null;
  readonly register: (nav: WizardNavState | null) => void;
}

const WizardNavContext = createContext<WizardNavContextValue | null>(null);

/**
 * Lets the step on screen drive the host's footer.
 *
 * Onboarding steps are not all one shape: most are a single question that
 * Back/Skip/Next fits exactly, but the import step is a flow of its own with
 * phases inside it. Before this, that flow drew its own Continue / ← Pick /
 * Next → / Finish row *above* onboarding's Back/Skip/Next — two rows, two
 * vocabularies, and an outer Next that jumped the whole step. This is how a
 * nested flow borrows the one row instead of growing a second one.
 */
export function WizardNavProvider({ children }: { children: ReactNode }) {
  const [nav, setNav] = useState<WizardNavState | null>(null);
  const register = useCallback((next: WizardNavState | null) => setNav(next), []);
  const value = useMemo(() => ({ nav, register }), [nav, register]);

  return <WizardNavContext.Provider value={value}>{children}</WizardNavContext.Provider>;
}

/** The host footer reads this. Null outside a provider. */
export function useWizardNavState(): WizardNavState | null {
  return useContext(WizardNavContext)?.nav ?? null;
}

/** Whether a host footer exists to drive — a nested flow keeps its own controls when not. */
export function useHasWizardNav(): boolean {
  return useContext(WizardNavContext) != null;
}

/**
 * Register this step's footer overrides for as long as it is mounted.
 *
 * Callbacks are held in a ref so a step re-rendering with fresh closures does
 * not re-register (and so the host does not re-render) on every keystroke; only
 * the values the footer actually paints are dependencies.
 */
export function useWizardNav(state: WizardNavState | null): void {
  const ctx = useContext(WizardNavContext);
  const register = ctx?.register;

  const onPrimaryRef = useRef(state?.onPrimary);
  const onBackRef = useRef(state?.onBack);

  // Written in an effect, not during render: a render that React throws away
  // (StrictMode's double invoke, a suspended sibling) must not leave the ref
  // pointing at handlers from a render that never committed.
  useEffect(() => {
    onPrimaryRef.current = state?.onPrimary;
    onBackRef.current = state?.onBack;
  });

  const primaryLabel = state?.primaryLabel;
  const primaryDisabled = state?.primaryDisabled;
  // `undefined` (host default) and `null` (hidden) are different answers, and
  // both are stable across renders — unlike the function itself.
  const backMode = state == null ? 'none' : state.onBack === null ? 'hidden' : state.onBack ? 'own' : 'host';
  // Whether a primary exists is part of what the footer paints (its label falls
  // back to the host's "Next" without one), so it has to be a dependency. Its
  // identity is not — that is what the ref is for.
  const hasPrimary = state?.onPrimary != null;

  useEffect(() => {
    if (!register) {
      return;
    }

    if (backMode === 'none') {
      register(null);

      return;
    }

    register({
      primaryLabel,
      primaryDisabled,
      onPrimary: hasPrimary ? () => onPrimaryRef.current?.() : undefined,
      onBack: backMode === 'hidden' ? null : backMode === 'own' ? () => onBackRef.current?.() : undefined,
    });
  }, [register, primaryLabel, primaryDisabled, backMode, hasPrimary]);

  // Leaving the step must not leave its labels on the footer. This runs on
  // unmount only — `register` is stable — so it cannot clear a newer step's
  // registration, which would happen if `register` changed identity.
  useEffect(() => () => register?.(null), [register]);
}

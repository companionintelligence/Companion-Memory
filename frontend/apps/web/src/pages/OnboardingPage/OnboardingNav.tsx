import { Button } from '@ci/shadcn';

import { useWizardNavState } from '@/components/WizardNav';

import { OnboardingButton } from './OnboardingButton';

export interface OnboardingNavProps {
  /** Whether there is a previous onboarding step to go back to. */
  canGoBack: boolean;
  onBack: () => void;
  onSkip: () => void;
  onNext: () => void;
}

/**
 * The one control row for the whole wizard, at every depth.
 *
 * A step that is itself a flow (import) registers its own primary and back
 * through `WizardNav`, so this row keeps meaning "forward" and "backward"
 * wherever the user actually is, instead of the step drawing a second row of
 * its own above this one and the outer Next jumping over it.
 *
 * Skip is never overridden: it always leaves the whole onboarding step, which
 * is the promise the step dots make ("every step is skippable"). A nested flow
 * that wants out of a sub-phase says so through Back.
 */
export function OnboardingNav({ canGoBack, onBack, onSkip, onNext }: OnboardingNavProps) {
  const nav = useWizardNavState();

  // `undefined` means "no opinion, use the host's". `null` means "hide it".
  const backHandler = nav?.onBack === null ? null : (nav?.onBack ?? (canGoBack ? onBack : null));
  const primaryLabel = nav?.primaryLabel ?? 'Next';
  const primaryHandler = nav?.onPrimary ?? onNext;

  return (
    <div
      data-testid="onboarding-nav"
      // `w-full` + `min-w-0` children: the primary's label is supplied by the
      // step and can be long ("Continue → 12 selected"), which at 375px used to
      // push Back off the left edge and the primary off the right — the row was
      // centred with no width of its own, so it just overflowed both ways.
      // Now the row owns the width, Back/Skip stay at their intrinsic size, and
      // the primary takes what is left and ellipsizes rather than pushing.
      className="mb-5 flex w-full items-center justify-center gap-1 px-4 device:mb-6 device:gap-3"
    >
      {backHandler && (
        <Button
          type="button"
          variant="ghost"
          size="lg"
          className="h-11 shrink-0 px-3 text-base device:px-6"
          onClick={backHandler}
        >
          Back
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="lg"
        className="h-11 shrink-0 px-3 text-base device:px-6"
        onClick={onSkip}
      >
        Skip
      </Button>
      <OnboardingButton
        type="button"
        size="lg"
        // The label is the step's own words when it has any, so the button says
        // what pressing it will do rather than a generic "Next" over a flow
        // that is really about to pick, upload or sync.
        className="h-12 min-w-0 max-w-full flex-1 px-4 text-base device:flex-none device:px-14 device:text-lg"
        disabled={nav?.primaryDisabled}
        onClick={primaryHandler}
      >
        <span className="truncate">{primaryLabel}</span>
      </OnboardingButton>
    </div>
  );
}

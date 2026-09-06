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
      className="mb-5 flex items-center justify-center gap-2 px-4 sm:mb-6 sm:gap-3"
    >
      {backHandler && (
        <Button type="button" variant="ghost" size="lg" className="text-base" onClick={backHandler}>
          Back
        </Button>
      )}
      <Button type="button" variant="ghost" size="lg" className="text-base" onClick={onSkip}>
        Skip
      </Button>
      <OnboardingButton
        type="button"
        size="lg"
        // The label is the step's own words when it has any, so the button says
        // what pressing it will do rather than a generic "Next" over a flow
        // that is really about to pick, upload or sync.
        className="h-12 px-10 text-base sm:px-14 sm:text-lg"
        disabled={nav?.primaryDisabled}
        onClick={primaryHandler}
      >
        {primaryLabel}
      </OnboardingButton>
    </div>
  );
}

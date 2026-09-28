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
      // Next keeps one width on a phone. It used to be `flex-1`, so the moment
      // Back appeared on step 2 the primary shrank. Back and Skip are the only
      // things that come and go. A long step label still ellipsizes inside that
      // fixed width. Desktop sizes the primary to its label again.
      className="mb-5 flex w-full items-center justify-between gap-1 px-4 device:mb-6 device:justify-center device:gap-3"
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
        className="ml-auto h-12 w-44 shrink-0 px-4 text-base device:ml-0 device:w-auto device:px-14 device:text-lg"
        disabled={nav?.primaryDisabled}
        onClick={primaryHandler}
      >
        <span className="truncate">{primaryLabel}</span>
      </OnboardingButton>
    </div>
  );
}

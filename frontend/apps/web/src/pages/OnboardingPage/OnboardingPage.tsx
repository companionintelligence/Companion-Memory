import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { LoadingPage, usePageTitle } from '@ci/common';
import { Form, formDataResolver, cn, formDataSchema as s, useForm } from '@ci/shadcn';
import { Navigate } from 'react-router-dom';

import { useFeatures } from '@/common/feature';
import { CompanionMark } from '@/components/CompanionMark';
import { ThemeToggle } from '@/components/ThemePicker';
import { WizardNavProvider } from '@/components/WizardNav';
import { useCurrentUser } from '@/hooks';
import { appHomePath } from '@/lib/appHome';

import { ActivityPreferences } from './ActivityPreferences';
import { ConnectSourceStep } from './ConnectSourceStep';
import {
  BROWSER_TIMEZONE,
  ONBOARDING_OAUTH_RESUME_KEY,
  buildOnboardingStepKeys,
  type OnboardingStepKey,
} from './constants';
import { FocusAreas } from './FocusAreas';
import { FoodPreferences } from './FoodPreferences';
import { IdentityStep } from './IdentityStep';
import { ImportArchivesStep } from './ImportArchivesStep';
import { Intro } from './Intro';
import { MoviePreferences } from './MoviePreferences';
import { OnboardingNav } from './OnboardingNav';
import { RunFirstSyncStep } from './RunFirstSyncStep';
import { SocialConnections } from './SocialConnections';
import { TimeAndPlaceStep } from './TimeAndPlaceStep';
import { TrustDialStep } from './TrustDialStep';
import { useOnboardingProgress } from './useOnboardingProgress';

export const OnboardingFormSchema = s.object({
  name: s.string().nullable().optional(),
  timezone: s.string().nullable().optional(),
  schedule: s
    .object({
      wake_time: s.string(),
      sleep_time: s.string(),
      work_start: s.string(),
      work_end: s.string(),
    })
    .nullable()
    .optional(),
  trust_mode: s.enum(['cautious', 'balanced', 'hands_off']).nullable().optional(),
  focus_areas: s.array(s.string()).nullable().default(null),
  people: s
    .array(
      s.object({
        first: s.string(),
        last: s.string(),
        relationship: s.string(),
      }),
    )
    .nullable()
    .default(null),
  food_preference: s.enum(['Pasta', 'Burgers', 'Salad', 'Tacos']).nullable().default(null),
  movie_preference: s.enum(['Dramas', 'Documentaries', 'Comedies', 'Horror']).nullable().default(null),
  activity_preference: s.enum(['Hiking', 'Bowling', 'Skating', 'Arcading']).nullable().default(null),
});

export type OnboardingFormData = s.input<typeof OnboardingFormSchema>;

const EMPTY_PERSON = { first: '', last: '', relationship: '' } as const;

const DEFAULT_PEOPLE = [EMPTY_PERSON, EMPTY_PERSON, EMPTY_PERSON] as OnboardingFormData['people'];

const DEFAULT_FORM_VALUES: OnboardingFormData = {
  name: null,
  timezone: BROWSER_TIMEZONE,
  schedule: {
    wake_time: '07:00',
    sleep_time: '21:00',
    work_start: '09:00',
    work_end: '18:00',
  },
  trust_mode: 'balanced',
  focus_areas: null,
  people: DEFAULT_PEOPLE,
  food_preference: null,
  movie_preference: null,
  activity_preference: null,
};

function normalizePeopleDraft(people: OnboardingFormData['people']): OnboardingFormData['people'] {
  if (people == null || people.length === 0) {
    return DEFAULT_PEOPLE;
  }

  return people;
}

export function OnboardingPage() {
  usePageTitle('Onboarding - Companion Memory');

  const { user, loading: userLoading } = useCurrentUser();
  const { isFeatureEnabled } = useFeatures();
  const { fetchProgress, saveProgress, loading: progressLoading } = useOnboardingProgress();

  const preferenceStepsEnabled = isFeatureEnabled('onboarding.preference.steps');
  // Same flag /import is routed behind, so the step never leads somewhere the
  // appliance does not serve.
  const importEnabled = isFeatureEnabled('import.page');
  const needsIdentity = user?.needsIdentityStep ?? user?.name === user?.email;

  const stepKeys = useMemo(
    () => buildOnboardingStepKeys({ needsIdentity: !!needsIdentity, preferenceStepsEnabled, importEnabled }),
    [needsIdentity, preferenceStepsEnabled, importEnabled],
  );

  const form = useForm<OnboardingFormData>({
    resolver: formDataResolver(OnboardingFormSchema),
    shouldUnregister: false,
    defaultValues: DEFAULT_FORM_VALUES,
  });

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  const [showWelcomeBackBanner, setShowWelcomeBackBanner] = useState(false);

  const currentStepKey = stepKeys[stepIndex] ?? 'intro';

  const dismissWelcomeBackBanner = useCallback(() => {
    setShowWelcomeBackBanner(false);
  }, []);

  useEffect(() => {
    if (userLoading || hydrated) {
      return;
    }

    void (async () => {
      const progress = await fetchProgress();
      const mergedDraft = { ...DEFAULT_FORM_VALUES, ...(progress?.draft ?? {}) } as OnboardingFormData;
      const draft = {
        ...mergedDraft,
        people: normalizePeopleDraft(mergedDraft.people),
      };
      form.reset(draft);

      if (progress?.updatedAt) {
        setShowWelcomeBackBanner(true);
      }

      const oauthResume = localStorage.getItem(ONBOARDING_OAUTH_RESUME_KEY);
      const targetKey =
        oauthResume != null
          ? ('connect-source' as OnboardingStepKey)
          : ((progress?.stepKey as OnboardingStepKey | undefined) ?? 'intro');

      if (oauthResume != null) {
        localStorage.removeItem(ONBOARDING_OAUTH_RESUME_KEY);
      }

      const idx = stepKeys.indexOf(targetKey);
      setStepIndex(idx >= 0 ? idx : 0);
      setHydrated(true);
    })();
  }, [userLoading, hydrated, fetchProgress, form, stepKeys]);

  const persistProgress = useCallback(
    async (nextIndex: number, draftOverride?: OnboardingFormData) => {
      const key = stepKeys[nextIndex] ?? 'intro';
      const draft = draftOverride ?? form.getValues();

      if (currentStepKey === 'time-and-place' && !draft.timezone) {
        draft.timezone = BROWSER_TIMEZONE;
      }

      await saveProgress(key, draft as Record<string, unknown>);
    },
    [currentStepKey, form, saveProgress, stepKeys],
  );

  const scrollToTop = useCallback(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: 0, behavior: 'instant' });
    });
  }, []);

  /**
   * Move first, save after.
   *
   * The save used to be awaited before the step changed, which made every
   * footer press wait on a network write — and the footer is now the ONE
   * control row, so a single failed PUT deadened Back, Skip and the primary at
   * once with nothing on screen to say so. `saveProgress` no longer throws;
   * the ref below keeps a slow write from clobbering a newer one, since two
   * quick presses now put two PUTs in flight and they can land out of order.
   */
  const progressSeq = useRef(0);

  const goToStep = useCallback(
    (nextIndex: number) => {
      dismissWelcomeBackBanner();
      setStepIndex(nextIndex);
      scrollToTop();

      const seq = ++progressSeq.current;

      void persistProgress(nextIndex).then(() => {
        if (seq !== progressSeq.current) {
          return;
        }
      });
    },
    [dismissWelcomeBackBanner, persistProgress, scrollToTop],
  );

  const handleNext = useCallback(() => {
    if (currentStepKey === 'time-and-place') {
      form.setValue('timezone', BROWSER_TIMEZONE);
    }

    void goToStep(Math.min(stepIndex + 1, stepKeys.length - 1));
  }, [currentStepKey, form, goToStep, stepIndex, stepKeys.length]);

  const handleBack = useCallback(() => {
    void goToStep(Math.max(stepIndex - 1, 0));
  }, [goToStep, stepIndex]);

  const handleSkip = useCallback(() => {
    void handleNext();
  }, [handleNext]);

  const setTrustMode = useCallback(
    (value: NonNullable<OnboardingFormData['trust_mode']>) => {
      form.setValue('trust_mode', value);
    },
    [form],
  );

  // Watched outside the memo below: reading it inside would subscribe (so the page
  // re-renders on change) without being a dependency, so the memo kept handing back
  // the element built from the first value and the dial looked unclickable.
  const trustMode = form.watch('trust_mode');

  const stepContent = useMemo(() => {
    switch (currentStepKey) {
      case 'intro':
        return <Intro />;
      case 'identity':
        return <IdentityStep />;
      case 'time-and-place':
        return <TimeAndPlaceStep />;
      case 'focus-areas':
        return <FocusAreas />;
      case 'people':
        return <SocialConnections />;
      case 'preferences-food':
        return <FoodPreferences />;
      case 'preferences-movie':
        return <MoviePreferences />;
      case 'preferences-activity':
        return <ActivityPreferences />;
      case 'connect-source':
        return <ConnectSourceStep />;
      case 'import-archives':
        return <ImportArchivesStep />;
      case 'trust-dial':
        return <TrustDialStep value={trustMode} onChange={setTrustMode} />;
      case 'run-first-sync':
        return <RunFirstSyncStep />;
      default:
        return <Intro />;
    }
  }, [currentStepKey, setTrustMode, trustMode]);

  const contentMaxWidth =
    currentStepKey === 'connect-source' || currentStepKey === 'import-archives'
      ? 'max-w-5xl'
      : currentStepKey === 'people'
        ? 'max-w-2xl'
        : 'max-w-2xl';

  // Typeform-style: keep the question centered in the viewport. Only denser
  // multi-card steps scroll from the top so content isn't clipped.
  const verticallyCenterStep =
    currentStepKey !== 'connect-source' &&
    currentStepKey !== 'import-archives' &&
    currentStepKey !== 'focus-areas' &&
    currentStepKey !== 'people';

  if (user?.onboarded) {
    return <Navigate to={appHomePath()} replace />;
  }

  // `userLoading` gates the first hydrate above, and then it has to stay out of
  // this check. A later `me` refetch (the phone has no JWT, so the Apollo cache
  // used to get cleared under an active API-key session) flipped it true, this
  // page swapped for the loader, and the welcome typing mounted again from the
  // first character.
  if (!hydrated || progressLoading) {
    return <LoadingPage message="Loading your setup…" />;
  }

  const isFinalStep = currentStepKey === 'run-first-sync';
  const showNav = !isFinalStep;

  // Always pinned below the scroller — never inside it. The source steps used
  // to append the nav to the scrolling content ("one page scroller",
  // 037d0e9b0), which put Back/Skip/Next below the fold on any step tall
  // enough to scroll; the step content scrolls, the nav does not.
  const navRow = showNav ? (
    <OnboardingNav canGoBack={stepIndex > 0} onBack={handleBack} onSkip={handleSkip} onNext={handleNext} />
  ) : null;

  return (
    <Form {...form}>
      {/* The provider wraps the form, not just the step area: the footer lives
          inside it too, and the footer is the thing a nested flow is driving. */}
      <WizardNavProvider>
        <form
          className="relative h-lvh flex flex-col"
          // Steps use type="button" CTAs; still block native submit so a mis-typed
          // control (or label→control activation) cannot navigate off the wizard.
          onSubmit={(event) => event.preventDefault()}
        >
          <div className="absolute top-0 left-0 h-[max(0.25rem,var(--safe-area-top))] w-full">
            <div className="absolute top-full right-3 z-10 text-foreground">
              <ThemeToggle />
            </div>
          </div>

          <div className="flex flex-col items-center flex-1 w-full h-full gap-1.5">
            <div className="self-start px-4 pt-[max(0.5rem,var(--safe-area-top))]">
              <CompanionMark className="h-7 w-7 rounded-full" />
            </div>

            {showWelcomeBackBanner && (
              <div
                className={cn('w-full mx-auto px-5 md:px-8 -mt-1 mb-1 flex justify-center', contentMaxWidth)}
              >
                <div className="max-w-lg rounded-lg border border-green-800/30 bg-background/95 px-4 py-2.5 text-sm text-foreground text-center shadow-sm backdrop-blur-sm">
                  Welcome back. Everything you&apos;ve entered is saved.
                </div>
              </div>
            )}

            <div
              ref={scrollRef}
              data-testid="onboarding-scroll"
              className={cn(
                'relative flex-1 overflow-x-hidden overflow-y-auto min-h-0 w-full min-w-0 mx-auto px-5 md:px-8',
                contentMaxWidth,
              )}
            >
              <div
                className={cn(
                  'flex min-w-0 flex-col items-center text-center w-full py-2',
                  verticallyCenterStep ? 'justify-center min-h-full' : 'justify-start',
                )}
              >
                {stepContent}
              </div>
            </div>

            {navRow}

            <div className="flex flex-col items-center gap-1 px-4 pb-[max(0.5rem,var(--safe-area-bottom))]">
              <div className="flex justify-center items-center gap-1.5">
                {stepKeys.map((key, i) => (
                  <div
                    key={key}
                    className={cn(
                      'h-1.5 w-1.5 rounded-full transition-all duration-500',
                      i === stepIndex ? 'bg-foreground scale-125' : 'bg-muted-foreground/35',
                    )}
                  />
                ))}
              </div>
              {/* The caption only has words on the first step. The line stays either
                  way, so Next and Skip do not drop when the words go away. */}
              <p
                data-testid="onboarding-step-caption"
                className="min-h-4 text-center text-xs text-muted-foreground sm:min-h-5 sm:text-sm"
              >
                {stepIndex === 0 ? `Step ${stepIndex + 1} of ${stepKeys.length} — every step is skippable` : null}
              </p>
            </div>
          </div>
        </form>
      </WizardNavProvider>
    </Form>
  );
}

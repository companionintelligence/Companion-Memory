import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { LoadingPage, usePageTitle } from '@ci/common';
import { Button, Form, formDataResolver, cn, formDataSchema as s, useForm } from '@ci/shadcn';
import { Navigate } from 'react-router-dom';

import logo from '@/assets/logo.png';
import { useFeatures } from '@/common/feature';
import { ThemeToggle } from '@/components/ThemePicker';
import { useCurrentUser } from '@/hooks';

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
import { Intro } from './Intro';
import { MoviePreferences } from './MoviePreferences';
import { OnboardingButton } from './OnboardingButton';
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
  people: null,
  food_preference: null,
  movie_preference: null,
  activity_preference: null,
};

export function OnboardingPage() {
  usePageTitle('Onboarding - Companion Intelligence');

  const { user, loading: userLoading } = useCurrentUser();
  const { isFeatureEnabled } = useFeatures();
  const { fetchProgress, saveProgress, loading: progressLoading } = useOnboardingProgress();

  const preferenceStepsEnabled = isFeatureEnabled('onboarding.preference.steps');
  const needsIdentity = user?.needsIdentityStep ?? user?.name === user?.email;

  const stepKeys = useMemo(
    () => buildOnboardingStepKeys({ needsIdentity: !!needsIdentity, preferenceStepsEnabled }),
    [needsIdentity, preferenceStepsEnabled],
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
      const draft = { ...DEFAULT_FORM_VALUES, ...(progress?.draft ?? {}) } as OnboardingFormData;
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

  const goToStep = useCallback(
    async (nextIndex: number) => {
      dismissWelcomeBackBanner();
      await persistProgress(nextIndex);
      setStepIndex(nextIndex);
      scrollToTop();
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
      case 'trust-dial':
        return <TrustDialStep value={form.watch('trust_mode')} onChange={setTrustMode} />;
      case 'run-first-sync':
        return <RunFirstSyncStep />;
      default:
        return <Intro />;
    }
  }, [currentStepKey, form, setTrustMode]);

  const contentMaxWidth =
    currentStepKey === 'connect-source'
      ? 'max-w-5xl'
      : currentStepKey === 'people'
        ? 'max-w-2xl'
        : 'max-w-2xl';

  // Typeform-style: keep the question centered in the viewport. Only denser
  // multi-card steps scroll from the top so content isn't clipped.
  const verticallyCenterStep =
    currentStepKey !== 'connect-source' && currentStepKey !== 'focus-areas' && currentStepKey !== 'people';

  if (user?.onboarded) {
    return <Navigate to="/feed" replace />;
  }

  if (userLoading || progressLoading || !hydrated) {
    return <LoadingPage message="Loading your setup…" />;
  }

  const isFinalStep = currentStepKey === 'run-first-sync';
  const showNav = !isFinalStep;

  return (
    <Form {...form}>
      <form className="relative h-lvh flex flex-col">
        <div className="absolute top-0 left-0 h-[max(0.25rem,env(safe-area-inset-top))] w-full">
          <div className="absolute top-full right-3 z-10 text-foreground">
            <ThemeToggle />
          </div>
        </div>

        <div className="flex flex-col items-center flex-1 w-full h-full gap-1.5">
          <div className="self-start px-4 pt-[max(0.5rem,env(safe-area-inset-top))]">
            <img src={logo} className="w-7 h-7" alt="" />
          </div>

          {showWelcomeBackBanner && (
            <div className={cn('w-full mx-auto px-5 md:px-8 -mt-1 mb-1 flex justify-center', contentMaxWidth)}>
              <div className="max-w-lg rounded-lg border border-green-800/30 bg-background/95 px-4 py-2.5 text-sm text-foreground text-center shadow-sm backdrop-blur-sm">
                Welcome back. Everything you&apos;ve entered is saved.
              </div>
            </div>
          )}

          <div
            ref={scrollRef}
            className={cn(
              'relative flex-1 overflow-y-auto min-h-0 w-full mx-auto px-5 md:px-8',
              contentMaxWidth,
            )}
          >
            <div
              className={cn(
                'flex flex-col items-center text-center w-full py-2',
                verticallyCenterStep ? 'justify-center min-h-full' : 'justify-start',
              )}
            >
              {stepContent}
            </div>
          </div>

          {showNav && (
            <div className="mb-5 flex items-center gap-2 px-4 sm:mb-6 sm:gap-3">
              {stepIndex > 0 && (
                <Button type="button" variant="ghost" size="lg" className="text-base" onClick={handleBack}>
                  Back
                </Button>
              )}
              <Button type="button" variant="ghost" size="lg" className="text-base" onClick={handleSkip}>
                Skip
              </Button>
              <OnboardingButton
                type="button"
                size="lg"
                className="px-10 sm:px-14 text-base sm:text-lg h-12"
                onClick={handleNext}
              >
                Next
              </OnboardingButton>
            </div>
          )}

          <div className="flex flex-col items-center gap-1 px-4 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
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
            {stepIndex === 0 && (
              <p className="text-xs sm:text-sm text-muted-foreground text-center">
                Step {stepIndex + 1} of {stepKeys.length} — every step is skippable
              </p>
            )}
          </div>
        </div>
      </form>
    </Form>
  );
}

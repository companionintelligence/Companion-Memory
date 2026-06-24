import { useCallback, useMemo, useRef, useState } from 'react';

import { usePageTitle } from '@ci/common';
import { Button, Form, formDataResolver, cn, formDataSchema as s, useForm } from '@ci/shadcn';

import logo from '@/assets/logo.png';
import { ThemeToggle } from '@/components/ThemePicker';

import { ActivityPreferences } from './ActivityPreferences';
import focusAreasImage from './assets/focus-areas.png';
import peopleImage from './assets/people.png';
import { DataImportStep } from './DataImportStep';
import { FocusAreas } from './FocusAreas';
import { FoodPreferences } from './FoodPreferences';
import { Intro } from './Intro';
import { MoviePreferences } from './MoviePreferences';
import { SocialConnections } from './SocialConnections';
import { Submit } from './Submit';

export const OnboardingFormSchema = s.object({
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

export function OnboardingPage() {
  usePageTitle('Onboarding - Companion Intelligence');

  const form = useForm<OnboardingFormData>({
    resolver: formDataResolver(OnboardingFormSchema),
    shouldUnregister: false,
  });

  const scrollRef = useRef<HTMLDivElement | null>(null);

  const [step, setStep] = useState(0);

  const steps = useMemo(
    () => [
      <Intro />,
      <FocusAreas />,
      <SocialConnections />,
      <FoodPreferences />,
      <MoviePreferences />,
      <ActivityPreferences />,
      <DataImportStep />,
      <Submit />,
    ],
    [],
  );

  const handleNextStep = useCallback(() => {
    setStep((current) => current + 1);

    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTo({
          top: 0,
          behavior: 'instant',
        });
      }
    });
  }, []);

  const images = [
    null,
    <div
      className="flex-1 bg-cover bg-center hidden md:block"
      style={{
        backgroundImage: `url(${focusAreasImage})`,
      }}
    />,
    <div
      className="flex-1 bg-cover bg-center hidden md:block"
      style={{
        backgroundImage: `url(${peopleImage})`,
      }}
    />,
    null,
    null,
    null,
    null,
    null,
  ];
  const finalGuidanceStep = steps.length - 2;

  return (
    <Form {...form}>
      <form className="relative h-lvh flex md:flex-row flex-col">
        <div className="absolute top-0 left-0 h-[max(0.5rem,env(safe-area-inset-top))] w-full">
          <div className="absolute top-full right-2 z-10 text-white md:text-foreground">
            <ThemeToggle />
          </div>
        </div>

        <div className="flex flex-col items-center flex-1/4 gap-4 h-full">
          <div className="self-start px-4 pt-[max(1rem,env(safe-area-inset-top))]">
            <img src={logo} className="w-8 h-8" />
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0 md:max-w-xl mx-4 md:mx-8">
            <div className="flex flex-col justify-center min-h-full">{steps[step % steps.length]}</div>
          </div>

          {step < steps.length - 1 && (
            <Button type="button" className="px-24" onClick={handleNextStep}>
              {step === finalGuidanceStep ? 'Finish setup' : 'Next'}
            </Button>
          )}

          <div className="flex justify-center items-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {Array.from({ length: steps.length }).map((_, i) => (
              <div
                key={i}
                className={cn(
                  'h-2 w-2 m-2 rounded-full transition-all duration-500',
                  i === step % steps.length ? 'bg-slate-800 scale-115' : 'bg-slate-300',
                )}
              />
            ))}
          </div>
        </div>

        {images[step % steps.length]}
      </form>
    </Form>
  );
}

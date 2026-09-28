import { Form, cn, useFormContext } from '@ci/shadcn';
import { Check } from '@ci/shadcn/icons';

import { StepHeader } from './StepHeader';

const focusAreaOptions = [
  {
    id: 'personal_fitness',
    label: 'Personal fitness and health',
    // Describes organizing what you tell it, NOT tracking or monitoring you.
    // The app takes no measurements and reads no biometrics: a focus area is a
    // topic tag (a concept node + a PREFERS edge, see OnboardingService
    // captureFocusAreas). Copy implying workout tracking would both overstate
    // the product and jeopardise the Play "no health features" certification —
    // see GOOGLE_HEALTH_DECLARATION.md. Keep these two descriptions literal.
    description: 'Organize workout notes, routines, and goals so your training context stays in one place',
  },
  {
    id: 'nutrition',
    label: 'Nutrition and meal planning',
    description: 'Plan meals, organize grocery lists, and keep recipes and preferences together',
  },
  {
    id: 'communication',
    label: 'Communication management',
    description: 'Centralize messages, schedule conversations, and keep track of important interactions',
  },
  {
    id: 'entertainment',
    label: 'Entertainment and activities',
    description: 'Organize hobbies, events, and downtime to bring balance and enjoyment to your schedule',
  },
  {
    id: 'travel',
    label: 'Travel planning',
    description: 'Manage itineraries, bookings, and logistics to make trips easier from start to finish',
  },
];

export function FocusAreas() {
  const form = useFormContext();

  return (
    <div className="w-full min-w-0 max-w-xl mx-auto space-y-4 text-left device:space-y-6">
      <StepHeader title="What should we focus on?" description="Pick anything that matters right now." />
      <div className="space-y-2 device:space-y-3">
        {focusAreaOptions.map((item) => (
          <Form.Field
            key={item.id}
            control={form.control}
            name="focus_areas"
            render={({ field }) => {
              const checked = field.value?.includes(item.id) ?? false;
              const checkboxId = `focus-area-${item.id}`;

              // One type="button" owns the whole tile. A label wrapping Radix's
              // checkbox <button> inside the onboarding <form> was activating a
              // native submit path and navigating off the step to a blank screen.
              const toggle = () => {
                field.onChange(
                  checked
                    ? (field.value || []).filter((entry: string) => entry !== item.id)
                    : [...(field.value || []), item.id],
                );
              };

              return (
                <button
                  type="button"
                  id={checkboxId}
                  role="checkbox"
                  aria-checked={checked}
                  aria-label={item.label}
                  className={cn(
                    'grid w-full min-w-0 grid-cols-[max-content_1fr] items-start gap-x-3 rounded-xl border border-border/70 bg-muted/40 px-3 py-2.5 text-left transition-colors cursor-pointer hover:bg-muted/55 device:gap-x-4 device:px-4 device:py-3.5',
                    checked && 'border-primary/40 bg-muted/60',
                  )}
                  onClick={toggle}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'mt-1 flex size-5 shrink-0 items-center justify-center rounded-[4px] border border-border bg-background shadow-xs',
                      checked && 'border-primary bg-primary text-primary-foreground',
                    )}
                  >
                    {checked ? <Check className="size-3.5" /> : null}
                  </span>

                  <div className="space-y-1">
                    <span className="text-base font-medium leading-snug device:text-xl">{item.label}</span>
                    <p className="text-sm text-muted-foreground leading-snug device:text-base">
                      {item.description}
                    </p>
                  </div>
                </button>
              );
            }}
          />
        ))}
      </div>
    </div>
  );
}

import { Checkbox, Form, cn, useFormContext } from '@ci/shadcn';

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
    <div className="space-y-6 w-full max-w-xl mx-auto text-left">
      <StepHeader title="What should we focus on?" description="Pick anything that matters right now." />
      <div className="space-y-3">
        {focusAreaOptions.map((item) => (
          <Form.Field
            key={item.id}
            control={form.control}
            name="focus_areas"
            render={({ field }) => {
              const checked = field.value?.includes(item.id) ?? false;
              const checkboxId = `focus-area-${item.id}`;

              return (
                <label
                  htmlFor={checkboxId}
                  className={cn(
                    'grid grid-cols-[max-content_1fr] items-start gap-x-4 rounded-xl border border-border/70 bg-muted/40 px-4 py-3.5 transition-colors cursor-pointer hover:bg-muted/55',
                    checked && 'border-primary/40 bg-muted/60',
                  )}
                >
                  <Checkbox
                    id={checkboxId}
                    className="mt-1 size-5 border-border bg-background"
                    checked={checked}
                    onCheckedChange={(value) => {
                      field.onChange(
                        value
                          ? [...(field.value || []), item.id]
                          : field.value?.filter((entry: string) => entry !== item.id),
                      );
                    }}
                  />

                  <div className="space-y-1">
                    <span className="text-lg sm:text-xl font-medium leading-snug">{item.label}</span>
                    <p className="text-base text-muted-foreground leading-snug">{item.description}</p>
                  </div>
                </label>
              );
            }}
          />
        ))}
      </div>
    </div>
  );
}

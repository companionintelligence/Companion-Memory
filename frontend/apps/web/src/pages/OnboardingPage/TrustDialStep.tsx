import { cn } from '@ci/shadcn';

import type { OnboardingFormData } from './OnboardingPage';
import { StepHeader } from './StepHeader';

// The last clause of each hint is the chat tool gate (`PendingActionService`):
// deleting, sending, completing a task and a connected MCP server's tools ask
// first on Cautious and Balanced; reading from an outside service (the owner's
// messages, streaming availability) asks first on Cautious only; Hands-off
// waives all of it. Keep the three in step with `trustForToolCall` — this copy
// and the Autonomy settings text are the only places the owner learns the rule.
export const TRUST_OPTIONS = [
  {
    value: 'cautious' as const,
    label: 'Cautious',
    hint: 'Ask before adding to-dos or placing them on your calendar, and before chat deletes, sends, or reads from an outside service',
  },
  {
    value: 'balanced' as const,
    label: 'Balanced',
    hint: 'High-confidence to-dos join the backlog; scheduling, deleting, sending, completing tasks and connected MCP tools still ask first',
  },
  {
    value: 'hands_off' as const,
    label: 'Hands-off',
    hint: 'Add and place solid to-dos automatically; chat deletes, sends and uses connected tools without asking',
  },
];

interface TrustDialStepProps {
  value: OnboardingFormData['trust_mode'];
  onChange: (value: NonNullable<OnboardingFormData['trust_mode']>) => void;
}

export function TrustDialStep({ value, onChange }: TrustDialStepProps) {
  const selected = value ?? 'balanced';

  return (
    <div className="w-full min-w-0 max-w-xl mx-auto space-y-4 device:space-y-8">
      <StepHeader title="How much trust?" description="How much should your companion do on its own?" />

      {/* TODO(settings): Autonomy subsection — same dial, reads/writes self-entity properties.planner.trust_mode */}
      <div className="flex flex-col gap-2 device:gap-3">
        {TRUST_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            // Selection was signalled by border/background alone, so which option is
            // active reached assistive tech not at all (and colour-blind users only
            // faintly). aria-pressed exposes the same state non-visually.
            aria-pressed={selected === opt.value}
            className={cn(
              'cursor-pointer rounded-xl border border-border px-4 py-3 text-left transition-colors hover:border-teal-600/60 device:px-5 device:py-4',
              selected === opt.value && 'border-teal-600 bg-teal-500/10',
            )}
            onClick={() => onChange(opt.value)}
          >
            <span className="block text-lg font-medium leading-tight text-foreground device:text-2xl">
              {opt.label}
            </span>
            <span className="mt-1 block text-sm leading-snug text-muted-foreground device:text-lg">
              {opt.hint}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

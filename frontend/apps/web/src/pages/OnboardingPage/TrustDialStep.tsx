import { cn } from '@ci/shadcn';

import type { OnboardingFormData } from './OnboardingPage';
import { StepHeader } from './StepHeader';

const TRUST_OPTIONS = [
  { value: 'cautious' as const, label: 'Cautious', hint: 'Review everything yourself' },
  { value: 'balanced' as const, label: 'Balanced', hint: 'High-confidence items auto-promote' },
  {
    value: 'hands_off' as const,
    label: 'Hands-off',
    hint: 'Auto-promote and auto-schedule estimate-bearing work',
  },
];

interface TrustDialStepProps {
  value: OnboardingFormData['trust_mode'];
  onChange: (value: NonNullable<OnboardingFormData['trust_mode']>) => void;
}

export function TrustDialStep({ value, onChange }: TrustDialStepProps) {
  const selected = value ?? 'balanced';

  return (
    <div className="space-y-8 w-full max-w-xl mx-auto">
      <StepHeader title="How much trust?" description="How much should your companion do on its own?" />

      {/* TODO(settings): Autonomy subsection — same dial, reads/writes self-entity properties.planner.trust_mode */}
      <div className="flex flex-col gap-3">
        {TRUST_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            // Selection was signalled by border/background alone, so which option is
            // active reached assistive tech not at all (and colour-blind users only
            // faintly). aria-pressed exposes the same state non-visually.
            aria-pressed={selected === opt.value}
            className={cn(
              'cursor-pointer rounded-xl border border-border px-5 py-4 text-left transition-colors hover:border-teal-600/60',
              selected === opt.value && 'border-teal-600 bg-teal-500/10',
            )}
            onClick={() => onChange(opt.value)}
          >
            <span className="block text-xl sm:text-2xl font-medium text-foreground leading-tight">
              {opt.label}
            </span>
            <span className="block text-base sm:text-lg text-muted-foreground mt-1 leading-snug">
              {opt.hint}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

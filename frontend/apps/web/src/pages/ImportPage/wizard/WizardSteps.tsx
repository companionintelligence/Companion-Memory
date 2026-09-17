import { cn } from '@ci/shadcn';
import { Check } from '@ci/shadcn/icons';

import type { ImportStage } from '../ImportPage';

export interface WizardStepsProps {
  /** The step being shown. */
  step: ImportStage;
  /** Export is unreachable until something is picked. */
  canExport: boolean;
  onStep: (step: ImportStage) => void;
  className?: string;
}

const STEPS: readonly { step: ImportStage; number: number; title: string; caption: string }[] = [
  { step: 'pick', number: 1, title: 'Pick', caption: 'the platforms and services you use' },
  { step: 'export', number: 2, title: 'Export', caption: 'your data from the sources you picked' },
  { step: 'sync', number: 3, title: 'Sync', caption: 'the staged data into your memory' },
];

const ORDER: Record<ImportStage, number> = { pick: 0, export: 1, sync: 2 };

/**
 * Where you are in the import, as the surface's one navigation row.
 *
 * This used to be a second row stacked directly under an Import/Inbox/History
 * tab bar — two rows of chrome, one of which repeated the other ("Import", then
 * "1 Pick"). Then for a while the steps doubled as the way back from Inbox and
 * History, shown there with no step current. Now the row is shown only with
 * the wizard — the surface buttons on the heading do the switching — so a
 * step is always exactly one of: done, where you are, or ahead of you.
 *
 * Lives here rather than inside `ImportWizard` because the page host pins it
 * above the scrolling wizard, while the onboarding host shows no row at all.
 */
export function WizardSteps({ step, canExport, onStep, className }: WizardStepsProps) {
  return (
    <ol className={cn('grid gap-2 sm:grid-cols-3', className)}>
      {STEPS.map((entry) => {
        const state = entry.step === step ? 'active' : ORDER[entry.step] < ORDER[step] ? 'done' : 'todo';

        const reachable = entry.step !== 'export' || canExport;

        return (
          <li key={entry.step}>
            <button
              type="button"
              disabled={!reachable}
              onClick={() => {
                if (reachable) {
                  onStep(entry.step);
                }
              }}
              aria-current={state === 'active' ? 'step' : undefined}
              className={cn(
                'flex w-full items-center gap-3 rounded-md border p-3 text-left transition-colors',
                state === 'active'
                  ? 'border-primary bg-primary/5'
                  : reachable
                    ? 'hover:bg-muted/50'
                    : 'cursor-not-allowed opacity-50',
              )}
            >
              <span
                className={cn(
                  'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-medium',
                  state === 'done'
                    ? 'bg-primary text-primary-foreground'
                    : state === 'active'
                      ? 'border-2 border-primary text-primary'
                      : 'border text-muted-foreground',
                )}
              >
                {state === 'done' ? <Check className="h-4 w-4" aria-hidden /> : entry.number}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">{entry.title}</span>
                <span className="block truncate text-xs text-muted-foreground">{entry.caption}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

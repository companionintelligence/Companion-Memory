import { cn } from '@ci/shadcn';
import { Check } from '@ci/shadcn/icons';

import type { ImportStage } from '../ImportPage';

export interface WizardStepsProps {
  /**
   * The step being shown, or `null` when the surface is on Inbox or History —
   * then no step is current, and every one of them is a way back.
   */
  step: ImportStage | null;
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
 * "1 Pick"). They are one row now: the three steps ARE the import tab, so
 * clicking any of them returns from Inbox or History to the wizard at that
 * step, and the tab bar keeps only the two destinations the steps do not name.
 *
 * Lives here rather than inside `ImportWizard` because the wizard unmounts when
 * the surface is on Inbox or History, and the row has to survive that to be the
 * way back.
 */
export function WizardSteps({ step, canExport, onStep, className }: WizardStepsProps) {
  return (
    <ol className={cn('grid gap-2 sm:grid-cols-3', className)}>
      {STEPS.map((entry) => {
        const state =
          step == null
            ? 'todo'
            : entry.step === step
              ? 'active'
              : ORDER[entry.step] < ORDER[step]
                ? 'done'
                : 'todo';

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

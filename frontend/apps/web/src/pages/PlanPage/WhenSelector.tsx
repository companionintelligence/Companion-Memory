import { Button } from '@ci/shadcn';

import { addLocalDays, localDateOf } from './taskSections';

export const WHEN_CHIPS = [
  { key: 'today', label: 'Today', days: 0 },
  { key: 'tomorrow', label: 'Tomorrow', days: 1 },
  { key: 'next-week', label: 'Next week', days: 7 },
] as const;

interface Props {
  onPick: (date: string) => void;
  onCancel?: () => void;
}

/**
 * One-decision Time selector for overdue reschedule: named day chips, plus a
 * calendar input when those three aren't the day.
 *
 * Same chips iOS App Intents expose as `PlanWhen` so Siri/Shortcuts and this
 * page ask the same question.
 */
export function WhenSelector({ onPick, onCancel }: Props) {
  const today = localDateOf(new Date());

  return (
    <div className="mt-1 flex flex-col gap-2" role="group" aria-label="Reschedule to">
      <div className="flex flex-wrap gap-2">
        {WHEN_CHIPS.map((chip) => (
          <Button
            key={chip.key}
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => onPick(addLocalDays(today, chip.days))}
          >
            {chip.label}
          </Button>
        ))}
        {onCancel ? (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        Pick a day
        <input
          type="date"
          min={today}
          className="rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground"
          onChange={(event) => {
            if (event.target.value) {
              onPick(event.target.value);
            }
          }}
        />
      </label>
    </div>
  );
}

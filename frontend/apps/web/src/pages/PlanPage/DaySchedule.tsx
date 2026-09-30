import { IconButton } from '@ci/shadcn';
import { Pencil } from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';

import { useDateTimeFormat } from '@/hooks/useDateTimeFormat';
import { HOUR_MINUTE } from '@/lib/dateTimeFormat';

export interface DayEvent {
  id: string;
  title?: string | null;
  startTime: string;
  endTime?: string | null;
  eventType?: string | null;
  taskId?: string | null;
}

interface Props {
  events: DayEvent[];
  onEdit?: (event: DayEvent) => void;
}

export function DaySchedule({ events, onEdit }: Props) {
  const { t } = useTranslation();
  const fmt = useDateTimeFormat();
  const formatClock = (iso: string) => fmt.time(iso, HOUR_MINUTE);

  if (events.length === 0) {
    return (
      <section className="rounded-lg border border-dashed border-border px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          On the calendar
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Nothing on the calendar yet. Schedule a task below.
        </p>
      </section>
    );
  }

  const sorted = [...events].sort((a, b) => a.startTime.localeCompare(b.startTime));

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        On the calendar
        <span className="ml-2 font-normal">{sorted.length}</span>
      </h2>
      <ol className="flex flex-col gap-1">
        {sorted.map((event) => {
          const planned = event.eventType === 'planned_block';
          const end = event.endTime ? `–${formatClock(event.endTime)}` : '';
          const title = event.title || 'Untitled';

          return (
            <li
              key={event.id}
              className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2 text-sm"
            >
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {formatClock(event.startTime)}
                {end}
              </span>
              <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
              {planned ? (
                <span className="shrink-0 text-xs text-teal-600 dark:text-teal-400">Planned</span>
              ) : null}
              {onEdit ? (
                <IconButton
                  variant="ghost"
                  label={t('PLAN_EVENT_EDIT', { title })}
                  onClick={() => onEdit(event)}
                >
                  <Pencil className="h-4 w-4" />
                </IconButton>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

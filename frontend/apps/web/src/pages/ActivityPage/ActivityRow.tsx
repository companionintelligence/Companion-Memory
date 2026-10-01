import { Badge } from '@ci/shadcn';

import { useDateTimeFormat } from '@/hooks/useDateTimeFormat';
import { appLabel } from '@/lib/appLabel';

import type { ActivityOutcome, ActivityRow as Row } from './useActivity';

/**
 * How each outcome reads, and how loudly.
 *
 * `refused` is deliberately the most prominent, and is NOT styled as an error.
 * A refusal is the gate working — the appliance declining to do something
 * irreversible unasked — and presenting it in the same red as a crash would
 * teach the owner to read a working safety boundary as a malfunction to be
 * silenced.
 */
const OUTCOME_COPY: Record<ActivityOutcome, { label: string; className: string }> = {
  success: { label: 'ran', className: 'text-muted-foreground' },
  error: { label: 'failed', className: 'text-destructive' },
  timeout: { label: 'timed out', className: 'text-destructive' },
  refused: { label: 'refused', className: 'font-medium text-amber-600 dark:text-amber-500' },
};

function outcomeCopy(outcome: ActivityOutcome) {
  return OUTCOME_COPY[outcome] ?? { label: outcome, className: 'text-muted-foreground' };
}

/** `1.2s` reads faster than `1200ms` at a glance, and sub-second precision does not matter here. */
function formatDuration(ms: number | null): string | null {
  if (ms == null) {
    return null;
  }

  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

interface Props {
  row: Row;
}

export function ActivityRow({ row }: Props) {
  const fmt = useDateTimeFormat();
  const outcome = outcomeCopy(row.outcome);
  const who = appLabel(row.principalName) ?? (row.principal === 'managed-app' ? 'An app' : 'You');
  const duration = formatDuration(row.durationMs);

  return (
    <li className="flex flex-col gap-1 border-b py-3 last:border-b-0" data-testid={`activity-${row.id}`}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {/*
          WHO first, then WHAT, then how it ended — the order the question is
          asked in. `capability` used to be the only answer to "who", which
          could not distinguish the owner's own `full` key from an installed
          harness's; it rides along as a title so it stays inspectable.
        */}
        <span
          className="text-sm font-medium"
          title={row.capability ? `capability: ${row.capability}` : undefined}
        >
          {who}
        </span>
        <code className="text-sm">{row.intent}</code>
        <span className={`text-sm ${outcome.className}`}>{outcome.label}</span>
        <span className="ml-auto text-xs text-muted-foreground">{fmt.dateTime(row.occurredAt)}</span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {/*
          The privacy facets, shown only when true. A row of mostly-"no" badges
          is noise that trains the eye to skip the line where one of them says
          yes.
        */}
        {row.destructive && (
          <Badge variant="outline" title="This intent removes data or is otherwise irreversible">
            irreversible
          </Badge>
        )}
        {row.external && (
          <Badge variant="outline" title="This intent reaches a third-party service">
            leaves appliance
          </Badge>
        )}
        {/* NULL tier means `appliance` — the documented default, so only `local` is worth saying. */}
        {row.tier === 'local' && (
          <Badge variant="outline" title="Dispatched from the on-device tier">
            on-device
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">
          {row.source}
          {duration ? ` · ${duration}` : ''}
        </span>
      </div>

      {/*
        The refusal's own words. This is the line that makes the page worth
        having: without it a refused row says only that something did not
        happen, and the owner cannot tell a policy decision from a bug.
      */}
      {row.error != null && row.error !== '' && (
        <p className="text-xs text-muted-foreground">
          {row.errorCode != null && row.errorCode !== '' && <code className="mr-1.5">{row.errorCode}</code>}
          {row.error}
        </p>
      )}
    </li>
  );
}

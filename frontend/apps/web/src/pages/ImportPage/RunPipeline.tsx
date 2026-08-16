import { Badge, Button, Card, cn } from '@ci/shadcn';
import { AlertTriangle, Check, ChevronUp, RefreshCcw, X } from '@ci/shadcn/icons';

import { DESTINATION_LABELS, compactNumber, runStatusLabel, stageLabel, STAGE_BLURBS } from './runFormat';
import { ServiceBadges } from './ServiceBadges';
import { StageBar } from './StageBar';
import type { ImportRunDetail, ImportStage } from './useImportApi';

export interface RunPipelineProps {
  run: ImportRunDetail;
  onCancel?: () => void;
  onRetryStage?: (stageId: string) => void;
  /** Collapse this run back to its summary card in the list. */
  onClose?: () => void;
  /** Detected services, already resolved to display titles. */
  services?: readonly string[];
}

/**
 * One import, as it happens.
 *
 * A stage per row, in the order they run, each with its own bar. The run's own
 * percentage is a weighted rollup the server maintains — unpacking a 40GB
 * archive and saving the rows it produced are not the same size of job, and a
 * bar that gave each stage a third would sit at 66% for most of an import and
 * then finish in a blink.
 */
export function RunPipeline({ run, onCancel, onRetryStage, onClose, services = [] }: RunPipelineProps) {
  const finished = run.finishedAt != null;

  return (
    <Card className="gap-0 space-y-2 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h3 className="truncate font-medium">{run.label ?? 'Import'}</h3>
          <p className="text-sm text-muted-foreground">{runStatusLabel(run.status)}</p>
          <ServiceBadges services={services} expandable />
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <RunStatusBadge status={run.status} />
          {!finished && onCancel ? (
            <Button variant="ghost" size="sm" onClick={onCancel}>
              <X className="mr-1 h-3 w-3" />
              Cancel
            </Button>
          ) : null}
        </div>
      </div>

      <StageBar processed={run.percent} total={100} status={run.status} />

      {run.error ? (
        <p className="flex items-start gap-2 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{run.error}</span>
        </p>
      ) : null}

      <ol className="space-y-3">
        {run.stages.map((stage) => (
          <StageRow key={stage.id} stage={stage} onRetry={onRetryStage} />
        ))}
      </ol>

      {/* Bottom-centre, mirroring the View button that opened it: the way back
          out of a run has to be where the eye already is after reading the
          stages, not back up at the header.

          Withheld while the import is still running. Closing a live run hid the
          only thing reporting on it, and the list it collapses into is a list of
          EARLIER imports — so there was nowhere for it to go. Cancel is the
          in-progress action; Close is for a run that is over. */}
      {onClose && finished ? (
        <div className="flex justify-center pt-1">
          <Button variant="ghost" size="sm" onClick={onClose}>
            <ChevronUp className="mr-1 h-3 w-3" />
            Close
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function StageRow({ stage, onRetry }: { stage: ImportStage; onRetry?: (stageId: string) => void }) {
  const retryable = stage.status === 'failed' || stage.status === 'cancelled';

  return (
    <li className="space-y-1">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <StageStatusIcon status={stage.status} />
          <span className="font-medium">{stageLabel(stage.kind)}</span>
          {/* The sub-label the runner sets: "parsing gmail (1/2)", "expanding". */}
          {stage.phase ? <span className="truncate text-sm text-muted-foreground">{stage.phase}</span> : null}
        </div>

        {retryable && onRetry ? (
          <Button variant="ghost" size="sm" onClick={() => onRetry(stage.id)}>
            <RefreshCcw className="mr-1 h-3 w-3" />
            Try again
          </Button>
        ) : null}
      </div>

      <p className="text-xs text-muted-foreground">{STAGE_BLURBS[stage.kind] ?? ''}</p>

      <StageBar
        processed={stage.processed}
        total={stage.total}
        status={stage.status}
        etaSeconds={stage.etaSeconds}
      />

      {stage.error ? <p className="text-xs text-destructive">{stage.error}</p> : null}

      <StageDetail stage={stage} />
    </li>
  );
}

/**
 * What a stage found, when it has something worth saying.
 *
 * Only rendered for outcomes a person would ask about: what was recognized, what
 * was saved and where, what could not be read. A stage that simply worked says
 * nothing beyond its bar.
 */
function StageDetail({ stage }: { stage: ImportStage }) {
  const detail = stage.detail ?? {};

  const recognized = Array.isArray(detail.recognized) ? (detail.recognized as string[]) : [];
  const rejected = Array.isArray(detail.rejected)
    ? (detail.rejected as Array<{ archive?: string; reason?: string }>)
    : [];
  const destinations = isRecord(detail.destinations) ? detail.destinations : null;
  const entities = isRecord(detail.entities) ? detail.entities : null;

  // ParseStage catches a throwing parser and carries on with the rest, recording
  // the casualty here. Nothing read it, so a Gmail parser that blew up inside a
  // Takeout while Photos succeeded left no trace anywhere in the UI — and
  // because the per-source counts are filtered to rows > 0, the failed service
  // also vanished from the badges while "Found: gmail, google_photos" went on
  // claiming it was read. Distinct from `detail.failed`, which is PushStage's
  // count of rows that could not be written.
  const parserFailures = Array.isArray(detail.failures)
    ? (detail.failures as Array<{ dataSource?: string; error?: string }>)
    : [];
  const skippedEntities = entities && typeof entities.skipped === 'number' ? entities.skipped : 0;
  const deduped = typeof detail.deduped === 'number' ? detail.deduped : 0;
  const failed = typeof detail.failed === 'number' ? detail.failed : 0;

  if (
    !recognized.length &&
    !rejected.length &&
    !destinations &&
    !skippedEntities &&
    !deduped &&
    !failed &&
    !parserFailures.length
  ) {
    return null;
  }

  return (
    <div className="space-y-1 pt-1 text-xs text-muted-foreground">
      {recognized.length ? <p>Found: {recognized.join(', ')}</p> : null}

      {destinations ? (
        <p>
          Saved:{' '}
          {DESTINATION_LABELS.filter(([key]) => typeof destinations[key] === 'number')
            .map(([key, label]) => `${compactNumber(destinations[key] as number)} ${label}`)
            .join(' · ')}
        </p>
      ) : null}

      {/* A finished bar over a mixed result needs the mix spelled out, or "10.8k
          of 10.8k" reads as though everything was written fresh.

          Worded WITHOUT claiming a previous import, because the usual cause is
          repetition inside THIS one: content is keyed on the work, not on the
          occurrence, so fifty listens of one audiobook are fifty events and a
          single document. A first Amazon archive deduped 4,985 of 10,808 rows
          that way. */}
      {deduped ? (
        <p>{compactNumber(deduped)} already in your memory (repeat references to the same thing)</p>
      ) : null}

      {failed ? <p className="text-destructive">{compactNumber(failed)} could not be saved</p> : null}

      {/* Surfaced rather than swallowed: these are records that did NOT arrive. */}
      {skippedEntities ? <p>{skippedEntities} groups skipped (albums, threads and places)</p> : null}

      {rejected.map((entry) => (
        <p key={entry.archive ?? entry.reason} className="text-destructive">
          Could not read {entry.archive}: {entry.reason}
        </p>
      ))}

      {/* Named, because "one service failed" is not actionable and the rest of
          the import succeeding is exactly why nobody would go looking. */}
      {parserFailures.map((entry) => (
        <p key={entry.dataSource ?? entry.error} className="text-destructive">
          Could not read your {entry.dataSource} data: {entry.error}
        </p>
      ))}
    </div>
  );
}

function StageStatusIcon({ status }: { status: string }) {
  if (status === 'completed') {
    return <Check className="h-4 w-4 shrink-0 text-emerald-500" />;
  }

  if (status === 'failed') {
    return <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />;
  }

  return (
    <span
      className={cn(
        'h-2 w-2 shrink-0 rounded-full',
        status === 'running' ? 'animate-pulse bg-primary' : 'bg-muted-foreground/40',
      )}
    />
  );
}

function RunStatusBadge({ status }: { status: string }) {
  // `partial` is a terminal SUCCESS — some of the archive imported and some did
  // not. Rendering it as a failure is what sends people back to re-upload 40GB.
  const variant = status === 'failed' ? 'destructive' : status === 'partial' ? 'secondary' : 'outline';

  return <Badge variant={variant}>{runStatusLabel(status)}</Badge>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

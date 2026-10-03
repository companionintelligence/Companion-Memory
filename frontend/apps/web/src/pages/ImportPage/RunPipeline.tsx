import { Badge, Button, Card, cn } from '@ci/shadcn';
import { AlertTriangle, Check, ChevronUp, RefreshCcw, X } from '@ci/shadcn/icons';

import {
  DESTINATION_LABELS,
  compactNumber,
  runStatusLabel,
  serviceLabels,
  stageLabel,
  stagePhase,
  STAGE_BLURBS,
  type ServiceTitles,
} from './runFormat';
import { ServiceBadges } from './ServiceBadges';
import { StageBar } from './StageBar';
import type { ImportRunDetail, ImportStage } from './useImportApi';

export interface RunPipelineProps {
  run: ImportRunDetail;
  onCancel?: () => void;
  onRetryStage?: (stageId: string) => void;
  /**
   * Re-queue the rows a COMPLETED push could not write. Distinct from
   * `onRetryStage`, which re-runs a stage that failed outright — a push that
   * mostly worked completes, and its casualties sit at `failed` where nothing
   * would ever look at them again.
   */
  onRetryFailedPush?: () => void;
  /** Collapse this run back to its summary card in the list. */
  onClose?: () => void;
  /** Detected services, already resolved to display titles. */
  services?: readonly string[];
  /**
   * The importer catalogue, so the "Found:" line can say what each recognized
   * importer is called. Optional: without it that line falls back to the importer
   * name with its underscores removed.
   */
  sources?: ServiceTitles;
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
export function RunPipeline({
  run,
  onCancel,
  onRetryStage,
  onRetryFailedPush,
  onClose,
  services = [],
  sources = [],
}: RunPipelineProps) {
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
          <StageRow
            key={stage.id}
            stage={stage}
            sources={sources}
            onRetry={onRetryStage}
            onRetryFailedPush={onRetryFailedPush}
          />
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

function StageRow({
  stage,
  sources,
  onRetry,
  onRetryFailedPush,
}: {
  stage: ImportStage;
  sources: ServiceTitles;
  onRetry?: (stageId: string) => void;
  onRetryFailedPush?: () => void;
}) {
  const retryable = stage.status === 'failed' || stage.status === 'cancelled';
  const phase = stagePhase(stage);

  return (
    <li className="space-y-1">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <StageStatusIcon status={stage.status} />
          <span className="font-medium">{stageLabel(stage.kind)}</span>
          {/* The sub-label the runner sets: "parsing gmail (1/2)", "expanding".
              Only while the stage is not done — the runner never clears it, so
              a completed stage would go on saying what it was doing. */}
          {phase ? <span className="truncate text-sm text-muted-foreground">{phase}</span> : null}
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

      <StageDetail stage={stage} sources={sources} onRetryFailedPush={onRetryFailedPush} />
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
function StageDetail({
  stage,
  sources,
  onRetryFailedPush,
}: {
  stage: ImportStage;
  sources: ServiceTitles;
  onRetryFailedPush?: () => void;
}) {
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
  // The subset of `skipped` that is a LOSS rather than a design decision: a
  // record with neither a name nor an email/phone, which entity resolution has
  // nothing to key on. It no longer makes the run `partial` (see PushStage), so
  // this line is the whole of its visibility.
  const unresolved = isRecord(entities?.unresolvedDetail) ? entities.unresolvedDetail : null;
  const unresolvedCount = typeof unresolved?.count === 'number' ? unresolved.count : 0;
  const unresolvedReason = typeof unresolved?.message === 'string' ? unresolved.message : null;
  const unresolvedExamples = Array.isArray(unresolved?.examples)
    ? (unresolved.examples as unknown[]).filter((value): value is string => typeof value === 'string')
    : [];
  // Whatever is left is the by-design half — an album, a place, a gmail thread.
  const excludedEntities = Math.max(skippedEntities - unresolvedCount, 0);
  const deduped = typeof detail.deduped === 'number' ? detail.deduped : 0;
  const failed = typeof detail.failed === 'number' ? detail.failed : 0;

  if (
    !recognized.length &&
    !rejected.length &&
    !destinations &&
    !skippedEntities &&
    !unresolvedCount &&
    !deduped &&
    !failed &&
    !parserFailures.length
  ) {
    return null;
  }

  return (
    <div className="space-y-1 pt-1 text-xs text-muted-foreground">
      {/* One entry per recognized FILE, so a Takeout lists `google_my_activity`
          thirty times — and as the importer's id, not its name. Said once each,
          in the catalogue's words. */}
      {recognized.length ? <p>Found: {serviceLabels(recognized, sources).join(', ')}</p> : null}

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

      {/* The only route back for these rows. The push reads `pending` and these
          are `failed`, Sync skips a run that already has a push stage, and the
          stage retry refuses a stage that completed — so before this button
          existed a run that saved 461,000 records and missed 297 kept missing
          them forever, with the count above as the only evidence. */}
      {failed ? (
        <div className="flex items-center gap-2">
          <p className="text-destructive">{compactNumber(failed)} could not be saved</p>
          {stage.kind === 'push' && onRetryFailedPush ? (
            <Button variant="ghost" size="sm" className="h-6 px-2" onClick={onRetryFailedPush}>
              <RefreshCcw className="mr-1 h-3 w-3" />
              Try these again
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Surfaced rather than swallowed: these are records that did NOT arrive. */}
      {excludedEntities ? <p>{excludedEntities} groups skipped (albums, threads and places)</p> : null}

      {/* The reason was always recorded on the staged row and was reachable
          only by hand-writing SQL against ci_import; the run said `partial` and
          nothing else. Named here, with the export the records came from,
          because "one contact could not be identified" is answerable and "this
          import is partial" is not. */}
      {unresolvedCount ? (
        <div>
          <p>
            {compactNumber(unresolvedCount)} {unresolvedCount === 1 ? 'record' : 'records'} could not be
            identified
            {unresolvedReason ? ` — ${unresolvedReason}` : ''}
          </p>
          {unresolvedExamples.length ? (
            <p className="truncate pl-3">{unresolvedExamples.join(' · ')}</p>
          ) : null}
        </div>
      ) : null}

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

import { useCallback, useMemo, useState } from 'react';

import { Badge, Card, cn } from '@ci/shadcn';
import { AlertTriangle, Check, ChevronDown, ChevronRight, Hourglass, Minus } from '@ci/shadcn/icons';

import {
  compactNumber,
  describeConcurrency,
  formatElapsed,
  formatEta,
  formatRate,
  humanizeUnit,
  queueStateLabel,
  runStatusLabel,
  serviceLabels,
  stageLabel,
} from '@/pages/ImportPage/runFormat';
import { RunPipeline } from '@/pages/ImportPage/RunPipeline';
import { StageBar } from '@/pages/ImportPage/StageBar';
import {
  useActiveImports,
  type ActiveImportRun,
  type ActiveImportSnapshot,
  type ActiveImportStage,
} from '@/pages/ImportPage/useImportApi';

export interface ImportActivityProps {
  className?: string;
}

/**
 * What the appliance is importing, right now — pinned wherever someone might
 * be watching.
 *
 * ## The problem it exists to solve
 *
 * A real 13-source import (one run per top-level folder of an inbox scan) was
 * running for an hour and NOTHING on screen said so. `/sources/import` opens on
 * the wizard's Pick step, which is a service picker; the run pipeline lived
 * three clicks away inside History, or on Export/Sync cards for runs that
 * particular card had started. The Jobs page showed pg-boss rows, which say
 * "import-stages: 142 created" and nothing about what is being imported.
 *
 * And when it WAS found, every run in the batch rendered as its label —
 * "qa-full-corpus", thirteen times — with twelve of them reading "queued".
 * There was no way to tell which run was the 704k-item Takeout, and no way to
 * tell a stage that had been legitimately waiting 51 minutes for the
 * appliance's single execution slot from one that was genuinely stuck.
 *
 * ## What it shows, and why each part earns its line
 *
 *  - **The unit** — `Google Takeout`, `Amazon`, `WhatsApp`. The one thing that
 *    makes a batch legible, and it comes from the staged source so it is there
 *    from the first poll, before any parse has produced `dataSources`.
 *  - **Queued vs running, spelled out.** `waiting` (enqueued, needs the slot,
 *    with its place in line) is drawn differently from `blocked` (its own run
 *    has not reached this stage) and differently again from `running`. All
 *    three are what the database calls `queued` or `running`; only the first
 *    distinction removes the "is it stuck?" question.
 *  - **The concurrency, stated.** One sentence — "runs 1 unpack, 1 read, 2
 *    store files and 1 save at a time" — is what turns a 51-minute wait from
 *    alarming into expected. Read from the server's own constants, per kind,
 *    because the numbers differ and have already changed once.
 *  - **Throughput and elapsed per stage.** 6/s against 555/s is the difference
 *    between a slow parser and a big archive, and it was recorded all along.
 *  - **Errors inline, on the stage that failed**, with the stage's own text.
 *
 * Expanding a run hands off to {@link RunPipeline} — the full card, with the
 * per-stage detail (what was found, what was saved where, what was deduped,
 * what could not be written) and the cancel/retry actions. This region is the
 * dense overview; that is the depth, and there is no second copy of it.
 *
 * ## Where it is mounted
 *
 * Exactly two places, both of which pass through this one component so they
 * cannot drift: the top of the import surface (`ImportSurface`, so it shows on
 * every wizard step and both tabs) and the top of the Jobs page. It renders
 * NOTHING when no run is unfinished, which is what lets it be pinned
 * unconditionally.
 *
 * One poll feeds all of it — see {@link useActiveImports}, which is a single
 * request per tick regardless of run count, slows to 30s when idle, and pauses
 * entirely on a hidden tab.
 */
export function ImportActivity({ className }: ImportActivityProps) {
  const { snapshot } = useActiveImports();

  // The whole surface is conditional on there being something to say. No empty
  // state, no "nothing is importing" card: a permanent widget reporting absence
  // is exactly the chrome that pushed the Pick grid's Continue button off a
  // 375px screen, and the honest answer to "is anything importing" when nothing
  // is, is silence.
  if (snapshot == null || !snapshot.active) {
    return null;
  }

  return <ImportActivityCard snapshot={snapshot} className={className} />;
}

/**
 * The rendering half, split out so tests can drive it with a fixed snapshot
 * instead of a fake clock and a fake fetch.
 */
export function ImportActivityCard({
  snapshot,
  className,
}: {
  snapshot: ActiveImportSnapshot;
  className?: string;
}) {
  const { batch, queue, runs } = snapshot;
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const toggle = useCallback(
    (runId: string) => setExpanded((current) => (current === runId ? null : runId)),
    [],
  );

  // What a person watching actually needs on screen: the run holding the
  // execution slot, and anything that went wrong. Thirteen rows of "waiting
  // their turn" is the same sentence thirteen times, and rendering it by
  // default is what took the region past the height of the surface it is
  // pinned to — measured at 1280×800, where the card came out 489px tall
  // inside a 440px column and pushed the ENTIRE wizard, Continue button and
  // all, off the bottom of a page that does not scroll. The count and the
  // queue line above already say how many are behind; this says which one is
  // moving. Everything else is one click away.
  //
  // Failures sort first. The region is height-capped, so the top of it is what
  // gets read, and "how did it go wrong" is the question this whole surface was
  // asked for. The rest keep the order the appliance will work through, which
  // under one slot is also the order they will finish.
  const spotlit = useMemo(
    () =>
      runs
        .filter(needsWatching)
        .sort((left, right) => Number(hasFailure(right)) - Number(hasFailure(left)))
        .slice(0, 4),
    [runs],
  );
  const visible = showAll ? runs : spotlit.length > 0 ? spotlit : runs.slice(0, 1);
  const hidden = runs.length - visible.length;
  // The toggle is about DETAIL, not only about count: with a single run there
  // is nothing hidden below, but its finished and not-yet-queued stages are
  // still folded away, and "show me the whole ladder" has to be reachable
  // without opening the full pipeline card.
  const trimmed = visible.some((run) => liveStages(run.stages).length < run.stages.length);

  const finishedRuns = batch.completed + batch.failed + batch.cancelled;
  const importing = batch.total - finishedRuns;

  return (
    <Card
      // `shrink-0` is load-bearing on the import surface: the host is a bounded
      // flex column whose other child (the wizard) is `min-h-0 flex-1` and pins
      // its own Continue button. Without it this region and the wizard would
      // fight over the same space and the button would be the loser.
      //
      // `overflow-hidden` + the `min-h-0 flex-1` list below is what turns the
      // host's height cap (see ImportPage, which passes one) into an internal
      // scroll instead of a clip — a Card that overflows its cap paints over
      // whatever is beneath it and swallows the clicks meant for it.
      className={cn('shrink-0 gap-0 space-y-2 overflow-hidden p-3 sm:p-4', className)}
      data-testid="import-activity"
      aria-label="Import progress"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="font-medium">
          Importing{' '}
          <span className="text-muted-foreground">
            {importing} of {batch.total} {batch.total === 1 ? 'source' : 'sources'}
          </span>
        </h2>

        <p className="text-xs text-muted-foreground">
          {[
            `${batch.percent}%`,
            formatElapsed(batch.elapsedMs) && `${formatElapsed(batch.elapsedMs)} elapsed`,
            batch.records > 0 && `${compactNumber(batch.records)} records saved`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>

      {/* `compact`: the readout under a full-size bar would say "16 / 100",
          which is a fraction of nothing anyone asked about. The percent it
          means rides in the header line above, where it is next to the elapsed
          time it should be read against. */}
      <StageBar processed={batch.percent} total={100} status="running" compact />

      {/* The aggregate the owner asked for, in the vocabulary that is true:
          RUNS are what finish, STAGES are what queue. Saying "12 running"
          because twelve runs have status `running` would be the most misleading
          number on the page — the appliance has five stage slots in total, so
          at most five of those twelve are doing anything. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <Count value={queue.running} label={`${queue.running === 1 ? 'stage' : 'stages'} running`} />
        <Count value={queue.waiting} label="waiting for the importer" />
        {finishedRuns > 0 ? <Count value={finishedRuns} label="done" /> : null}
        {batch.failed > 0 ? (
          <span className="font-medium text-destructive">{batch.failed} failed</span>
        ) : null}

        {/* THE sentence. A twelve-deep queue on a personal appliance reads as a
            malfunction until you know only one stage can run at a time; with
            that said once, "waiting 51 minutes" becomes arithmetic instead of
            alarm. Withheld when nothing is waiting, because then it explains
            nothing — and kept on the SAME line as the counts it explains, since
            this region is height-capped and every line it spends on chrome is a
            line it does not spend on the runs. */}
        {/* No leading dash: at 375px this wraps onto a line of its own, and a
            sentence that starts with a punctuation mark left over from the line
            above reads like a rendering bug. */}
        {queue.waiting > 0 ? (
          <span>
            this appliance runs {describeConcurrency(queue.concurrency)} at a time, so the rest wait their
            turn
            {queue.longestWaitMs != null && queue.longestWaitMs > 60_000
              ? ` (longest wait ${formatElapsed(queue.longestWaitMs)})`
              : ''}
          </span>
        ) : null}
      </div>

      {/* Self-scrolling inside whatever ceiling the host set, so a long batch
          never grows the region past its share of the page. `min-h-0` is the
          part that makes it scroll rather than push: a flex child's default
          minimum size is its content, which is exactly how a list of thirteen
          runs shoved the wizard off screen. */}
      <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto">
        {visible.map((run) => (
          <li key={run.id}>
            <RunRow
              run={run}
              dense={!showAll}
              expanded={expanded === run.id}
              onToggle={() => toggle(run.id)}
            />
          </li>
        ))}
      </ul>

      {/* The rest of the batch, on request. Named with the count so the button
          says what it is hiding rather than "show more". */}
      {hidden > 0 || trimmed || showAll ? (
        <button
          type="button"
          onClick={() => setShowAll((current) => !current)}
          className="cursor-pointer self-start text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          {showAll
            ? 'Show only what is running'
            : hidden > 0
              ? `Show all ${runs.length} ${runs.length === 1 ? 'source' : 'sources'}`
              : 'Show every stage'}
        </button>
      ) : null}

      {snapshot.truncated ? (
        <p className="text-xs text-muted-foreground">Older finished runs of this batch are in History.</p>
      ) : null}
    </Card>
  );
}

/**
 * Is this run one somebody needs to SEE, as opposed to count?
 *
 * A run holding the appliance's single execution slot, or one that failed —
 * those are the two things a person came to the page for. A run whose every
 * stage is waiting its turn is already fully described by the aggregate line
 * ("11 waiting for the importer"), and thirteen copies of that sentence is what
 * made this region taller than the surface it is pinned to.
 *
 * `status` is deliberately not the only test: a run's cached status can read
 * `running` while every stage of it is queued behind another run's, which is
 * exactly the state that looks like a stall. The stage rows are the truth.
 */
function needsWatching(run: ActiveImportRun): boolean {
  return run.stages.some((stage) => stage.queueState === 'running') || hasFailure(run);
}

/** Did anything about this run go wrong — the run itself, or one of its stages? */
function hasFailure(run: ActiveImportRun): boolean {
  return (
    run.status === 'failed' ||
    run.error != null ||
    run.stages.some((stage) => stage.error != null || stage.status === 'failed')
  );
}

function Count({ value, label }: { value: number; label: string }) {
  return (
    <span>
      <span className="font-medium text-foreground">{value}</span> {label}
    </span>
  );
}

/**
 * One run: what it is, how far along, and what each of its stages is doing.
 *
 * Collapsed by default even for a single run — the stage lines below already
 * carry the live numbers, and the full {@link RunPipeline} adds the per-stage
 * BREAKDOWN (found / saved / deduped / could-not-save) plus cancel and retry,
 * which is a different question asked deliberately.
 */
function RunRow({
  run,
  dense,
  expanded,
  onToggle,
}: {
  run: ActiveImportRun;
  /** Show only the stage that is actually happening — see {@link liveStages}. */
  dense: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const finished = run.finishedAt != null;
  const failed = run.status === 'failed' || run.status === 'cancelled';
  const stages = dense ? liveStages(run.stages) : run.stages;

  // The unit first and the label second, which is the opposite of what the run
  // list did. A batch gives thirteen runs one label; only the unit says which
  // of them this is.
  const title = humanizeUnit(run.unit) ?? run.label ?? run.id;
  const subtitle = [run.unit != null && run.label !== null ? run.label : null, describeSources(run)]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className={cn('rounded-md border', failed && 'border-destructive/40')}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full cursor-pointer items-start gap-2 p-2 text-left hover:bg-muted/40"
      >
        {expanded ? (
          <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        )}

        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="truncate font-medium">{title}</span>
            <span className="text-xs text-muted-foreground">{runStatusLabel(run.status)}</span>
            {run.elapsedMs != null ? (
              <span className="text-xs text-muted-foreground">{formatElapsed(run.elapsedMs)}</span>
            ) : null}
          </span>

          {subtitle ? <span className="block truncate text-xs text-muted-foreground">{subtitle}</span> : null}
        </span>

        <Badge variant={failed ? 'destructive' : finished ? 'secondary' : 'outline'} className="shrink-0">
          {run.percent}%
        </Badge>
      </button>

      {/* The run's own error, above the stages — a run can fail for a reason no
          single stage owns (a claim conflict, a cancelled parent). */}
      {run.error ? (
        <p className="flex items-start gap-1.5 px-2 pb-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">{run.error}</span>
        </p>
      ) : null}

      {expanded ? (
        <div className="px-2 pb-2">
          {/* Not a second implementation of the stage list — the same card the
              History tab and the wizard show, so a fix to it lands everywhere. */}
          <RunPipeline run={run} services={serviceLabels(run.dataSources, [])} />
        </div>
      ) : (
        <ol className="space-y-1 px-2 pb-2">
          {stages.map((stage) => (
            <StageLine key={stage.id} stage={stage} />
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * The stage lines worth a row when the region is at its narrowest.
 *
 * A run has four stages and at most one of them is happening; the other three
 * are a ladder of "done" and "not started yet" that says nothing a person is
 * asking. Four lines per run is also, measured, the difference between this
 * region fitting its ceiling and showing a run clipped through the middle.
 *
 * So: whatever is RUNNING, plus anything that FAILED (never hidden — the error
 * is the reason to look), and failing both, the one stage that is waiting for
 * the appliance's slot. A run with none of those is finished, and its last
 * stage is the summary of how it ended. Every stage is still one click away in
 * the pipeline card, and the "Show all sources" toggle restores the full
 * ladders wholesale.
 */
function liveStages(stages: readonly ActiveImportStage[]): ActiveImportStage[] {
  const notable = stages.filter(
    (stage) => stage.queueState === 'running' || stage.error != null || stage.status === 'failed',
  );

  if (notable.length > 0) {
    return notable;
  }

  const waiting = stages.find((stage) => stage.queueState === 'waiting');

  return waiting ? [waiting] : stages.slice(-1);
}

/**
 * One stage, in one line, with the four numbers that answer "is this fine?".
 *
 * What is being said, in priority order:
 *
 *  - `running`  → the phase the runner set, live counts, throughput, ETA —
 *    or, when its heartbeat has gone silent, that it has STALLED.
 *  - `waiting`  → that it is IN THE QUEUE and where, plus how long it has been
 *    there. This is the line that did not exist, and the reason a normal batch
 *    import looked broken.
 *  - `blocked`  → "Not started yet", with no clock at all. Attaching an elapsed
 *    time here would read as "stuck for an hour" when nothing is even waiting
 *    on it.
 *  - `done`     → how long it took, and its error if it has one.
 */
function StageLine({ stage }: { stage: ActiveImportStage }) {
  const detail = describeStage(stage);
  const running = stage.queueState === 'running';
  const waiting = stage.queueState === 'waiting';

  return (
    <li className="text-xs">
      <div className="flex items-baseline gap-2">
        <StageIcon stage={stage} />

        <span
          className={cn(
            'w-20 shrink-0 font-medium',
            stage.queueState === 'blocked' && 'text-muted-foreground',
          )}
        >
          {stageLabel(stage.kind)}
        </span>

        <span
          className={cn('min-w-0 flex-1 truncate', waiting ? 'text-foreground' : 'text-muted-foreground')}
        >
          {detail}
        </span>

        {stage.elapsedMs != null ? (
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {formatElapsed(stage.elapsedMs)}
          </span>
        ) : null}
      </div>

      {/* A running stage gets a bar; nothing else does. A bar on a queued stage
          is a bar that will not move, which is precisely the thing that makes a
          waiting import look hung. */}
      {running ? (
        <div className="mt-0.5 pl-[4.5rem]">
          <StageBar processed={stage.processed} total={stage.total} status={stage.status} compact />
        </div>
      ) : null}

      {/* Inline, on the stage that failed, in the stage's own words — not folded
          into a status word three levels up. This is the single most important
          thing on the screen when it exists. */}
      {stage.error ? (
        <p className="mt-0.5 flex items-start gap-1.5 pl-[4.5rem] text-destructive">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          {/* `min-w-0` or the path in an ENOSPC message runs off the side of a
              375px card and takes the reason with it: a flex child's automatic
              minimum size is its longest unbreakable run, and a filesystem path
              has no break opportunities for `break-words` to use until the
              child is allowed to be narrower than its content. */}
          <span className="min-w-0 break-words">{stage.error}</span>
        </p>
      ) : null}
    </li>
  );
}

/**
 * The middle column of a stage line.
 *
 * Exported because it is the piece the tests care about most: it is where
 * "queued" stops being one word for two situations.
 */
export function describeStage(stage: ActiveImportStage): string {
  const queued = queueStateLabel(stage.queueState, {
    position: stage.queuePosition,
    kind: stage.kind,
  });

  if (queued != null) {
    // Back in the queue because its worker died — say so, or a stage that was
    // halfway through reads as one that never started.
    return stage.detail?.interrupted != null ? `${queued} · retrying, its worker stopped` : queued;
  }

  const parts: string[] = [];

  // First, because it is the reason to look: the counts after it are frozen.
  if (stage.stalled) {
    parts.push('Stalled — no heartbeat');
  }

  if (stage.phase) {
    parts.push(stage.phase);
  }

  if (stage.total != null && stage.total > 0) {
    parts.push(`${compactNumber(stage.processed)} / ${compactNumber(stage.total)}`);
  } else if (stage.processed > 0) {
    parts.push(compactNumber(stage.processed));
  }

  const rate = formatRate(stage.itemsPerSec);

  if (rate != null) {
    parts.push(rate);
  }

  // Only while it is actually moving: a finished stage's leftover ETA is a lie,
  // and StageBar makes the same call for the same reason. So is a stalled one's.
  if (stage.queueState === 'running' && !stage.stalled) {
    const eta = formatEta(stage.etaSeconds);

    if (eta != null) {
      parts.push(eta);
    }
  }

  return parts.join(' · ');
}

function StageIcon({ stage }: { stage: ActiveImportStage }) {
  if (stage.status === 'failed' || stage.status === 'cancelled') {
    return <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" aria-label="failed" />;
  }

  if (stage.queueState === 'done') {
    return <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" aria-label="done" />;
  }

  // A pulsing "running" dot on a stage nothing is working on is the exact
  // false reassurance the stall flag exists to remove.
  if (stage.queueState === 'running' && stage.stalled) {
    return <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-label="stalled" />;
  }

  if (stage.queueState === 'running') {
    return (
      <span
        className="mx-[0.3rem] h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary"
        aria-label="running"
      />
    );
  }

  // Waiting and blocked get DIFFERENT marks, because that is the whole point:
  // an hourglass says "in the queue, its turn is coming"; a dash says "nothing
  // is even waiting on this yet".
  if (stage.queueState === 'waiting') {
    return <Hourglass className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="waiting" />;
  }

  return <Minus className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" aria-label="not started" />;
}

/**
 * The services a run turned out to hold, at a length that fits one line.
 *
 * Already deduped and frequency-ordered by the server — a Google Takeout
 * arrives as 47 recognized files of which 30 are `google_my_activity`, and the
 * raw array wrapped a run row over five lines of the same word.
 */
function describeSources(run: ActiveImportRun): string | null {
  const names = serviceLabels(run.dataSources.slice(0, 3), []);

  if (names.length === 0) {
    return null;
  }

  const extra = run.dataSources.length - names.length;

  return extra > 0 ? `${names.join(', ')} +${extra}` : names.join(', ');
}

/** Jobs and Import both want this; `RunPipeline` is not exported from here on purpose. */
export default ImportActivity;

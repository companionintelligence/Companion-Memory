import { useEffect, useMemo, useState } from 'react';

import { Accordion, Badge, Card, Input, Skeleton, Switch, cn } from '@ci/shadcn';
import { AlertTriangle, Lock } from '@ci/shadcn/icons';

import { describeCron } from './cronDescriptor';
import { FoldBody, FoldCard, FoldTrigger, cardPad, usePhone } from './Fold';
import { categoryDot, categoryLabel, CATEGORY_LABELS } from './jobCategories';
import type {
  CronMode,
  JobControlsPatch,
  JobControlsResponse,
  JobCronControl,
  JobMode,
  JobQueueControl,
} from './useJobControls';
import type { JobTypesResponse } from './useJobTypes';

/**
 * The operator's controls over the job system.
 *
 * ── The one thing this card has to get right ───────────────────────────────
 *
 * Every control here can make the appliance do less, and "does less" and "is
 * broken" look identical from the outside. So the copy is doing as much work as
 * the switches: what each state costs is written next to the state, a disabled
 * queue reports how much work it has thrown away, and the numbers show what the
 * appliance will actually do rather than echoing back what was typed (they are
 * routinely different — see `jobConcurrency.ts` on the server).
 *
 * ── Off vs paused ──────────────────────────────────────────────────────────
 *
 * Two off-states, because they cost different things and an operator reaching
 * for one at 2am should not discover the difference afterwards. **Paused** stops
 * the workers and keeps the queue filling: the box cools, the backlog grows,
 * nothing is lost. **Off** also stops the enqueue, so new work is dropped and
 * does not come back when it is switched on again. Pause is the safe one, so it
 * is the middle option and off is the one that says what it costs.
 */
export function JobControlsCard({
  controls,
  loading,
  saving,
  error,
  errorStatus,
  jobTypes,
  onSave,
}: {
  controls: JobControlsResponse | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  /** HTTP status behind `error`, when there was one. Decides the explanation. */
  errorStatus?: number | null;
  jobTypes: JobTypesResponse | null;
  onSave: (patch: JobControlsPatch) => Promise<boolean>;
}) {
  const phone = usePhone();

  const queueGroups = useMemo(() => groupQueues(controls?.queues ?? []), [controls?.queues]);
  const cronRows = useMemo(
    () => (controls?.crons ?? []).map((cron) => ({ cron, descriptor: describeCron(cron.name, jobTypes) })),
    [controls?.crons, jobTypes],
  );

  const offQueues = (controls?.queues ?? []).filter((queue) => queue.mode !== 'enabled').length;
  const offCrons = (controls?.crons ?? []).filter((cron) => cron.mode === 'disabled').length;
  // Zero on a single-process appliance (CI_ROLE=all), which is the default and
  // every test, so the note below is silent unless the split is actually in use.
  const elsewhereCount = (controls?.crons ?? []).filter((cron) => !cron.servedHere).length;

  return (
    <FoldCard fold>
      <Card.Header className={cardPad(phone)}>
        <FoldTrigger>
          <Card.Title className="text-base">Controls</Card.Title>
          <Card.Description>
            Turn jobs off and cap how hard this box works. Saved on the appliance — these survive a restart,
            and they apply to every account on it.
          </Card.Description>
        </FoldTrigger>
      </Card.Header>
      <FoldBody>
        <Card.Content className={cn('space-y-4', cardPad(phone))}>
          {/* A red alert means SOMETHING YOU DID FAILED — a save that did not
              stick. It is not the right shape for "this section has nothing in
              it", which is a state, not a failure, and which the paragraph
              below explains in words an operator can act on.

              The card used to raise the alert for both, so an appliance that
              simply predates job controls greeted you with a raw Express string
              in red — `Cannot GET /jobs/controls` — stacked on a diagnosis of an
              unrelated problem. The server's own words are still worth keeping,
              but as a detail under the explanation, not as the headline. */}
          {error && controls ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            >
              <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0 break-words">{error}</span>
            </div>
          ) : null}

          {loading && !controls ? (
            <Skeleton className="h-40 w-full" />
          ) : !controls ? (
            <div className="space-y-1.5">
              <p className="text-sm text-muted-foreground">{explainUnavailable(errorStatus)}</p>
              {error ? (
                <p className="break-words font-mono text-xs text-muted-foreground/70">
                  {errorStatus != null ? `${errorStatus} · ` : ''}
                  {error}
                </p>
              ) : null}
            </div>
          ) : (
            <>
              <GlobalControls controls={controls} saving={saving} onSave={onSave} />

              <Accordion type="multiple" className="w-full">
                <Accordion.Item value="queues">
                  <Accordion.Trigger className="py-2.5 text-sm hover:no-underline">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate">Queues</span>
                      <span className="text-xs font-normal text-muted-foreground tabular-nums">
                        {controls.queues.length}
                      </span>
                      {offQueues > 0 ? (
                        <Badge variant="secondary" className="text-[10px] uppercase">
                          {offQueues} not running
                        </Badge>
                      ) : null}
                    </span>
                  </Accordion.Trigger>
                  <Accordion.Content>
                    <div className="space-y-4 pb-2">
                      {queueGroups.map(([category, queues]) => (
                        <section key={category} aria-label={categoryLabel(category)}>
                          <h4 className="flex items-center gap-2 border-b border-border/40 pb-1 text-xs uppercase text-muted-foreground">
                            <span aria-hidden className={`h-2 w-2 rounded-full ${categoryDot(category)}`} />
                            {categoryLabel(category)}
                          </h4>
                          <ul>
                            {queues.map((queue) => (
                              <QueueRow
                                key={queue.name}
                                queue={queue}
                                saving={saving}
                                onSave={onSave}
                                globallyPaused={controls.global.nonInteractive === 'paused'}
                              />
                            ))}
                          </ul>
                        </section>
                      ))}
                    </div>
                  </Accordion.Content>
                </Accordion.Item>

                <Accordion.Item value="schedules">
                  <Accordion.Trigger className="py-2.5 text-sm hover:no-underline">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate">Schedules</span>
                      <span className="text-xs font-normal text-muted-foreground tabular-nums">
                        {controls.crons.length}
                      </span>
                      {offCrons > 0 ? (
                        <Badge variant="secondary" className="text-[10px] uppercase">
                          {offCrons} off
                        </Badge>
                      ) : null}
                    </span>
                  </Accordion.Trigger>
                  <Accordion.Content>
                    {/* Said once at the top rather than repeated per row. The
                        list used to come from THIS process's scheduler, which
                        under CI_ROLE=web omits the eleven schedules the worker
                        runs — presented under a plain count, so a schedule an
                        operator came here to switch off was absent with nothing
                        to say it existed. The list is now every @Cron in the
                        build; this sentence covers the one thing that is still
                        true and worth knowing. */}
                    {elsewhereCount > 0 ? (
                      <p className="pb-2 text-xs text-muted-foreground">
                        {elsewhereCount} of these run in the worker process rather than this one. They are
                        listed and switchable from here — the setting is stored on the appliance and every
                        process reads it. The Schedules card above still covers only this process, so it has
                        no last-run time for them.
                      </p>
                    ) : null}
                    <ul className="pb-2">
                      {cronRows.map(({ cron, descriptor }) => (
                        <CronRow
                          key={cron.name}
                          cron={cron}
                          label={descriptor.label}
                          category={descriptor.category}
                          saving={saving}
                          onSave={onSave}
                        />
                      ))}
                    </ul>
                  </Accordion.Content>
                </Accordion.Item>
              </Accordion>
            </>
          )}
        </Card.Content>
      </FoldBody>
    </FoldCard>
  );
}

/**
 * Why the controls are not here — from the STATUS, not a guess.
 *
 * This used to be one fixed sentence blaming an unmigrated settings table,
 * printed under whatever the server said. On an appliance running a build from
 * before job controls existed that read:
 *
 *     Cannot GET /jobs/controls
 *     Job controls are unavailable. The settings table may not have been migrated yet…
 *
 * — a raw Express 404 stacked on a diagnosis of a completely different problem,
 * sending the reader to check migrations when the endpoint simply is not in the
 * build they are running. The two need opposite actions, so the copy has to
 * distinguish them.
 */
function explainUnavailable(status?: number | null): string {
  if (status === 404) {
    return 'This appliance is running a build from before job controls shipped — the endpoint is not there. Update the server and restart it; nothing is wrong with the settings. Until then every queue and schedule runs with its shipped defaults.';
  }

  if (status === 401 || status === 403) {
    return 'You are not signed in to this appliance, or this account cannot read job controls. Everything keeps running on its shipped defaults meanwhile.';
  }

  if (status != null && status >= 500) {
    return 'The server has the controls endpoint but could not answer it — the settings table may not have been migrated yet. Until it is, every queue and schedule runs with its shipped defaults.';
  }

  // No status at all: the request never reached a server (offline, wrong host,
  // proxy down). Claiming a migration problem here would be a guess.
  return 'Job controls could not be loaded. Every queue and schedule is running with its shipped defaults meanwhile.';
}

function GlobalControls({
  controls,
  saving,
  onSave,
}: {
  controls: JobControlsResponse;
  saving: boolean;
  onSave: (patch: JobControlsPatch) => Promise<boolean>;
}) {
  const paused = controls.global.nonInteractive === 'paused';
  const { queueWorkerProcesses, perProcessConcurrency, role } = controls.topology;

  return (
    <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="flex items-start justify-between gap-3">
        {/* The description sits OUTSIDE the label and is referenced instead.
            Inside it, the switch's accessible name becomes the whole paragraph —
            which is what a screen reader would then read out on focus, and what
            a control has to be identified by. */}
        <div className="min-w-0">
          <label htmlFor="pause-background-work" className="text-sm font-medium">
            Pause background work
          </label>
          <p id="pause-background-work-help" className="mt-0.5 text-xs text-muted-foreground">
            Stops the workers on every queue except the ones a person is waiting on, so chat keeps answering.
            Nothing is lost — jobs keep queuing and run when you switch this back.
          </p>
        </div>
        <Switch
          id="pause-background-work"
          aria-describedby="pause-background-work-help"
          checked={paused}
          disabled={saving}
          onCheckedChange={(next) => void onSave({ global: { nonInteractive: next ? 'paused' : 'enabled' } })}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <NumberControl
          id="global-concurrency"
          label="Jobs at once, whole appliance"
          help={
            queueWorkerProcesses > 1
              ? `Split across ${queueWorkerProcesses} worker processes (CI_ROLE=${role}), so each gets ${perProcessConcurrency}.`
              : 'The total number of jobs this box will run at the same time.'
          }
          control={controls.global.concurrency}
          saving={saving}
          onCommit={(value) => onSave({ global: { concurrency: value } })}
        />
        <NumberControl
          id="per-queue-concurrency"
          label="Jobs at once, per queue"
          help="Default ceiling for any single queue. A queue can be given a lower one below; none can go higher."
          control={controls.global.perQueueConcurrency}
          saving={saving}
          onCommit={(value) => onSave({ global: { perQueueConcurrency: value } })}
        />
      </div>

      {/* Said once, above both boxes, rather than implied by two `max`
          attributes nobody reads until the field refuses a keystroke.

          Both numbers used to accept 64 against a shipped 10 and 6, which made
          this page a way to take the appliance six times past what the build
          allows — on the page you opened *because* the machine was hot. They
          now clamp at the shipped figure, so the direction of travel is the
          same as every other control here: this makes the box quieter. */}
      <p className="text-xs text-muted-foreground">
        Both numbers only go <strong>down</strong>. {shippedSummary(controls)} is what this build ships with
        and the most either box will take — more throughput than that is a{' '}
        <code className="font-mono">CI_QUEUE_CONCURRENCY</code> change and a restart, not a setting.
      </p>

      {/* The single most common way to be wrong about this page: assuming one of
          the two limits covers the other. They do not overlap at all — the Hub's
          limit is how much CPU the container may use, this is how many jobs
          Memory will start. A box with a generous CPU limit and no queue cap
          still pegs; a tight CPU limit with an uncapped queue still stacks
          thousands of jobs and thrashes. */}
      <p className="text-xs text-muted-foreground">
        This caps the <strong>queue</strong>. The Hub&apos;s per-app CPU limit caps the{' '}
        <strong>container</strong>. They are different ceilings and a hot box usually needs both.
      </p>
    </div>
  );
}

/**
 * "10 appliance-wide, 6 per queue" — the shipped pair, read off the DTO rather
 * than hardcoded, because an appliance whose compose file already raised
 * `CI_QUEUE_CONCURRENCY` ships with different numbers and this sentence has to
 * name the ones that are actually binding.
 */
function shippedSummary(controls: JobControlsResponse): string {
  return `${controls.global.concurrency.max} appliance-wide and ${controls.global.perQueueConcurrency.max} per queue`;
}

function QueueRow({
  queue,
  saving,
  globallyPaused,
  onSave,
}: {
  queue: JobQueueControl;
  saving: boolean;
  globallyPaused: boolean;
  onSave: (patch: JobControlsPatch) => Promise<boolean>;
}) {
  const summary = queue.jobTypes
    .slice(0, 3)
    .map((type) => type.label)
    .join(', ');
  const extra = queue.jobTypes.length - Math.min(queue.jobTypes.length, 3);

  return (
    <li className="border-t border-border/40 py-2 first:border-t-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
            {queue.name}
            {queue.interactive ? (
              <Badge
                variant="outline"
                className="text-[10px] uppercase"
                title="Something on this queue is work a person is waiting on, so the global pause leaves it running."
              >
                interactive
              </Badge>
            ) : null}
            {queue.locked ? <LockedBadge reason={queue.lockedReason} /> : null}
          </span>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {summary || 'No job types registered'}
            {extra > 0 ? ` +${extra} more` : ''}
          </p>
          <QueueStatusLine queue={queue} globallyPaused={globallyPaused} />
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <ConcurrencyField queue={queue} saving={saving} onSave={onSave} />
          <ModeControl
            label={`${queue.name} mode`}
            value={queue.mode}
            locked={queue.locked}
            saving={saving}
            onChange={(mode) => void onSave({ queues: [{ name: queue.name, mode }] })}
          />
        </div>
      </div>
    </li>
  );
}

/**
 * The line that keeps a switched-off queue from reading as a broken one.
 *
 * Three distinct things can make a queue quiet, and they need three different
 * actions from the operator, so they get three different sentences rather than
 * one greyed-out row.
 */
function QueueStatusLine({ queue, globallyPaused }: { queue: JobQueueControl; globallyPaused: boolean }) {
  const dropped =
    queue.skippedCount > 0 ? (
      <>
        {' '}
        {queue.skippedCount.toLocaleString()} job{queue.skippedCount === 1 ? '' : 's'} dropped
        {queue.lastSkippedAt ? `, last ${new Date(queue.lastSkippedAt).toLocaleString()}` : ''}.
      </>
    ) : null;

  if (queue.mode === 'disabled') {
    return (
      <p className="mt-0.5 text-xs text-destructive">
        Off — new work for this queue is dropped, not queued.{dropped}
      </p>
    );
  }

  if (queue.mode === 'paused') {
    return (
      <p className="mt-0.5 text-xs text-amber-600 dark:text-amber-400">
        {queue.pausedByGlobal && globallyPaused
          ? 'Paused by “Pause background work”. Jobs are queuing up and will run when you switch that back.'
          : 'Paused — jobs are queuing up and nothing is being worked.'}
        {dropped}
      </p>
    );
  }

  return dropped ? <p className="mt-0.5 text-xs text-muted-foreground">Running.{dropped}</p> : null;
}

function CronRow({
  cron,
  label,
  category,
  saving,
  onSave,
}: {
  cron: JobCronControl;
  label: string;
  category: string;
  saving: boolean;
  onSave: (patch: JobControlsPatch) => Promise<boolean>;
}) {
  const disabled = cron.mode === 'disabled';
  const inputId = `cron-${cron.name.replace(/[^\w-]/g, '-')}`;

  return (
    <li className="flex items-start justify-between gap-3 border-t border-border/40 py-2 first:border-t-0">
      {/* Only the schedule's name is inside the label — the cadence and the
          off-notice are described-by instead, so the switch is identified by
          "Planning jobs todo scan" rather than by that plus a cron expression. */}
      <div className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
          <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${categoryDot(category)}`} />
          <label htmlFor={inputId}>{label}</label>
          {cron.locked ? <LockedBadge reason={cron.lockedReason} /> : null}
          {/* Only when it is NOT this process. On a single-process appliance
              every row would carry the badge, which says nothing. */}
          {!cron.servedHere ? (
            <Badge
              variant="outline"
              className="text-[10px] uppercase"
              title={`Runs in the ${cron.role} process, not the one serving this page. The switch still applies — it is stored on the appliance and read by every process.`}
            >
              {cron.role}
            </Badge>
          ) : null}
        </span>
        <p id={`${inputId}-cadence`} className="mt-0.5 text-xs text-muted-foreground" title={cron.name}>
          {cron.cron}
        </p>
        {disabled ? (
          <p className="mt-0.5 text-xs text-destructive">
            Off — this schedule does not run.
            {cron.skippedCount > 0
              ? ` ${cron.skippedCount.toLocaleString()} tick${cron.skippedCount === 1 ? '' : 's'} skipped.`
              : ''}
          </p>
        ) : null}
      </div>
      <Switch
        id={inputId}
        aria-describedby={`${inputId}-cadence`}
        checked={!disabled}
        disabled={saving || cron.locked}
        onCheckedChange={(next) =>
          void onSave({ crons: [{ name: cron.name, mode: (next ? 'enabled' : 'disabled') as CronMode }] })
        }
      />
    </li>
  );
}

function LockedBadge({ reason }: { reason: string | null }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground"
      title={reason ?? 'This job cannot be switched off.'}
    >
      <Lock aria-hidden className="h-3 w-3" />
      required
    </span>
  );
}

/**
 * On / Pause / Off.
 *
 * Three buttons rather than a switch and a menu, because the middle state is the
 * one an operator should reach for and burying it would make "off" the obvious
 * choice for a problem that pausing solves without losing anything.
 */
function ModeControl({
  label,
  value,
  locked,
  saving,
  onChange,
}: {
  label: string;
  value: JobMode;
  locked: boolean;
  saving: boolean;
  onChange: (mode: JobMode) => void;
}) {
  const options: ReadonlyArray<{ mode: JobMode; text: string; title: string }> = [
    { mode: 'enabled', text: 'On', title: 'Enqueue and work normally.' },
    {
      mode: 'paused',
      text: 'Pause',
      title: 'Keep queuing, stop working. The backlog grows; nothing is lost.',
    },
    {
      mode: 'disabled',
      text: 'Off',
      title: 'Stop queuing and stop working. New work for this queue is dropped.',
    },
  ];

  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex overflow-hidden rounded-md border border-border/60"
    >
      {options.map((option) => (
        <button
          key={option.mode}
          type="button"
          title={locked ? 'This queue cannot be switched off.' : option.title}
          aria-pressed={value === option.mode}
          disabled={saving || (locked && option.mode !== 'enabled')}
          onClick={() => onChange(option.mode)}
          className={cn(
            'px-2 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40',
            value === option.mode
              ? option.mode === 'enabled'
                ? 'bg-muted font-medium'
                : option.mode === 'paused'
                  ? 'bg-amber-500/20 font-medium text-amber-700 dark:text-amber-400'
                  : 'bg-destructive/20 font-medium text-destructive'
              : 'text-muted-foreground hover:bg-muted/60',
          )}
        >
          {option.text}
        </button>
      ))}
    </div>
  );
}

function ConcurrencyField({
  queue,
  saving,
  onSave,
}: {
  queue: JobQueueControl;
  saving: boolean;
  onSave: (patch: JobControlsPatch) => Promise<boolean>;
}) {
  // A queue whose code declares its own ceiling has nothing to offer here: the
  // declaration wins over anything typed, so an editable box would be a control
  // that silently does nothing. Show the number and say who set it instead.
  if (queue.declaredConcurrency != null && queue.declaredConcurrency <= 1) {
    return (
      <span
        className="text-xs tabular-nums text-muted-foreground"
        title={`This queue declares a ceiling of ${queue.declaredConcurrency} in code, so it cannot be raised.`}
      >
        {queue.concurrency.effective}×
      </span>
    );
  }

  return (
    <NumberControl
      id={`queue-concurrency-${queue.name}`}
      label={`${queue.name} concurrency`}
      labelHidden
      control={queue.concurrency}
      saving={saving}
      onCommit={(value) => onSave({ queues: [{ name: queue.name, concurrency: value }] })}
    />
  );
}

/**
 * A number an operator can set, or leave alone.
 *
 * Empty means "use the default", and clearing the box is how you get back to it
 * — there is no separate reset control to find. The value is committed on blur
 * or Enter rather than on every keystroke, so typing "12" does not save a 1 on
 * the way past.
 */
function NumberControl({
  id,
  label,
  labelHidden = false,
  help,
  control,
  saving,
  onCommit,
}: {
  id: string;
  label: string;
  labelHidden?: boolean;
  help?: string;
  control: { value: number | null; default: number; max: number; effective: number };
  saving: boolean;
  onCommit: (value: number | null) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(control.value == null ? '' : String(control.value));

  // The server is the source of truth: it clamps, and a save elsewhere on the
  // card returns a whole new state. Re-sync whenever its answer changes so the
  // box shows what was stored rather than what was typed at it.
  useEffect(() => {
    setDraft(control.value == null ? '' : String(control.value));
  }, [control.value]);

  const commit = () => {
    const trimmed = draft.trim();
    const next = trimmed === '' ? null : Number.parseInt(trimmed, 10);

    if (next !== null && (!Number.isFinite(next) || next < 1)) {
      setDraft(control.value == null ? '' : String(control.value));

      return;
    }

    if (next === control.value) {
      return;
    }

    void onCommit(next);
  };

  return (
    <div className="min-w-0">
      <label htmlFor={id} className={labelHidden ? 'sr-only' : 'text-sm font-medium'}>
        {label}
      </label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={1}
        max={control.max}
        value={draft}
        disabled={saving}
        placeholder={String(control.default)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur();
          }
        }}
        className={labelHidden ? 'h-7 w-16 px-2 text-xs tabular-nums' : 'mt-1 h-8'}
      />
      {help ? <p className="mt-1 text-xs text-muted-foreground">{help}</p> : null}
      {/* Only shown when it disagrees with the request — the case where a number
          was typed and something tighter overruled it. Saying "effective: 6"
          under every box that already says 6 trains people to stop reading it. */}
      {control.value != null && control.value !== control.effective ? (
        <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
          Running at {control.effective} — a lower ceiling applies.
        </p>
      ) : null}
    </div>
  );
}

/** Queues by their primary category, in the order the rest of the page lists categories. */
function groupQueues(queues: readonly JobQueueControl[]): Array<[string, JobQueueControl[]]> {
  const groups = new Map<string, JobQueueControl[]>();

  for (const queue of queues) {
    const category = queue.categories[0] ?? 'unclassified';
    const bucket = groups.get(category) ?? [];

    bucket.push(queue);
    groups.set(category, bucket);
  }

  const order = Object.keys(CATEGORY_LABELS);

  return [...groups.entries()].sort((left, right) => {
    const li = order.indexOf(left[0]);
    const ri = order.indexOf(right[0]);

    return (li === -1 ? 99 : li) - (ri === -1 ? 99 : ri);
  });
}

import { useCallback, useMemo, useState } from 'react';

import { fetchJson, usePageTitle } from '@ci/common';
import { Accordion, Badge, Card, Skeleton, Switch, cn } from '@ci/shadcn';
import { AlertTriangle } from '@ci/shadcn/icons';
import { useLocation, useNavigate } from 'react-router-dom';

import { PageContent } from '@/components/layout';
import { PullToRefresh } from '@/components/PullToRefresh';

import { describeCron } from './cronDescriptor';
import { describeCronExpression } from './cronSchedule';
import { DeadLettersCard } from './DeadLettersCard';
import { FoldBody, FoldCard, FoldTrigger, cardPad, usePhone } from './Fold';
import { categoryDot, categoryLabel, CATEGORY_LABELS } from './jobCategories';
import { JobControlsCard } from './JobControlsCard';
import { JobHealthCard } from './JobHealthCard';
import { JobHistoryCharts } from './JobHistoryCharts';
import { JobsImportActivity } from './JobsImportActivity';
import { categoryFromPath, JOBS_SECTIONS } from './jobsSections';
import { JobsTable } from './JobsTable';
import { useDeadLetters } from './useDeadLetters';
import { useJobControls, type JobControlsPatch, type JobCronControl } from './useJobControls';
import { useHistoryWindow, useJobFilters } from './useJobFilters';
import { useJobHistory } from './useJobHistory';
import { useJobsAuth } from './useJobsAuth';
import { useJobsDashboard, type JobsDashboardResponse } from './useJobsDashboard';
import { DESKTOP_JOB_PAGE_SIZE, MOBILE_JOB_PAGE_SIZE, useJobsList, type JobFilters } from './useJobsList';
import { useJobTypes, type JobTypesResponse } from './useJobTypes';

export function JobsPage() {
  usePageTitle('Jobs - Companion Intelligence');

  const phone = usePhone();
  const { pathname } = useLocation();
  const navigate = useNavigate();

  const [refreshing, setRefreshing] = useState(false);

  // Phone pages of 50 cards are unreadable; desktop stays at 50. Derived rather
  // than stored: it is a property of the device, not of the view, so it must not
  // travel in a shared link — a phone-sized URL opened on a desktop should not
  // stay phone-sized.
  const limit = phone ? MOBILE_JOB_PAGE_SIZE : DESKTOP_JOB_PAGE_SIZE;

  // The query string is the source of truth for every filter. See useJobFilters
  // for why: a reload used to drop you back to "everything, page 1", and there
  // was no way to hand anyone a view except a screenshot and directions.
  const { filters, setFilters, isFiltered, clear } = useJobFilters(limit);
  const [windowHours, setWindowHours] = useHistoryWindow(24);

  const dashboard = useJobsDashboard();
  const list = useJobsList(filters);
  const { types: jobTypes } = useJobTypes();
  const history = useJobHistory(windowHours, filters.queue);
  const deadLetters = useDeadLetters();
  const controls = useJobControls();
  const { headers: jobsAuthHeaders } = useJobsAuth();

  const onFilterChange = useCallback((next: Partial<JobFilters>) => setFilters(next), [setFilters]);

  const clearTerminal = useCallback(
    async (scope: 'dead-letter' | 'failed') => {
      await fetchJson<{ scope: string; deleted: number }>('/api/jobs/clear', {
        method: 'POST',
        headers: { ...jobsAuthHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope }),
      });
      await Promise.all([dashboard.refresh(), list.refresh()]);
    },
    [dashboard.refresh, list.refresh, jobsAuthHeaders],
  );

  /**
   * The Health card's verdicts and empty state must read the SAME unfiltered,
   * appliance-wide source its own state tiles already use (`dashboard.data.
   * summary`) — not `list.data.stateCounts`, which the server scopes to the
   * active category/type/queue/search filter. Passing the filtered counts
   * made the card contradict its own tiles: open a category route with no
   * rows and the verdicts said "nothing has ever been queued" while the
   * tiles directly underneath showed the real, appliance-wide counts.
   *
   * Reshaped to the state keys `jobVerdicts` and the tiles already key off
   * (`created`, `dead-letter`, …), the same as `list.data.stateCounts` was,
   * so nothing downstream has to change.
   */
  const healthStateCounts = useMemo<Readonly<Record<string, number>>>(() => {
    const summary = dashboard.data?.summary;

    return {
      created: summary?.pending ?? 0,
      active: summary?.active ?? 0,
      retry: summary?.retry ?? 0,
      completed: summary?.completed ?? 0,
      failed: summary?.failed ?? 0,
      'dead-letter': summary?.deadLettered ?? 0,
    };
  }, [dashboard.data?.summary]);

  // Which surface this address shows. A category deep-link is the table, so it
  // falls through to the same branch Overview's table lives in.
  const section = JOBS_SECTIONS.find((candidate) => candidate.match(pathname))?.id ?? 'overview';
  const isCategoryRoute = categoryFromPath(pathname) != null;

  /**
   * Refetch every card, and RESOLVE when they have all answered.
   *
   * Returning the promise is what makes the swipe-down gesture legible:
   * `PullToRefresh` holds its spinner until this settles, and a version that
   * returned `void` would flash it away on the next frame — indistinguishable,
   * on a phone, from the gesture not being wired at all.
   *
   * Depends on the four `refresh` callbacks rather than the hook results, which
   * are fresh objects on every poll tick. A `refreshAll` that changed identity
   * every few seconds would keep re-registering the gesture's touch listeners
   * underneath the finger.
   */
  const refreshAll = useCallback(() => {
    setRefreshing(true);

    return Promise.all([
      dashboard.refresh(),
      list.refresh(),
      history.refresh(),
      deadLetters.refresh(),
      controls.refresh(),
    ]).finally(() => setRefreshing(false));
  }, [dashboard.refresh, list.refresh, history.refresh, deadLetters.refresh, controls.refresh]);

  const jobsTable = (
    <JobsTable
      data={list.data}
      loading={list.loading}
      error={list.error}
      jobTypes={jobTypes}
      filters={filters}
      onChange={onFilterChange}
      onClear={clear}
      isFiltered={isFiltered}
    />
  );
  const historyCharts = (
    <JobHistoryCharts
      data={history.data}
      loading={history.loading}
      error={history.error}
      windowHours={windowHours}
      onWindowChange={setWindowHours}
      queue={filters.queue}
    />
  );
  const schedules = (
    <SchedulesCard
      crons={dashboard.data?.crons ?? []}
      loading={dashboard.loading}
      jobTypes={jobTypes}
      // The on/off state lives in the controls payload, not the dashboard one,
      // so the table joins them by cron name. Absent (older server, or controls
      // still loading) the column simply does not render — see SchedulesTable.
      cronControls={controls.data?.crons ?? null}
      saving={controls.saving}
      onSave={controls.save}
    />
  );
  const controlsCard = (
    <JobControlsCard
      controls={controls.data}
      loading={controls.loading}
      saving={controls.saving}
      error={controls.error}
      errorStatus={controls.errorStatus}
      onSave={controls.save}
    />
  );
  const deadLettersCard = (
    <DeadLettersCard
      groups={deadLetters.groups}
      total={deadLetters.total}
      loading={deadLetters.loading}
      error={deadLetters.error}
      onReplay={deadLetters.replay}
    />
  );

  return (
    // Swipe-down refetches the whole page, the way People, Places and the
    // Memory list already do. `overscroll-y-contain` keeps the drag inside this
    // scroller so WKWebView bounces nothing behind it while the pull is held.
    <PullToRefresh onRefresh={refreshAll}>
      <PageContent className="overscroll-y-contain">
        <div className="flex flex-col gap-3">
          {/* Above Queue Activity, because it outranks it while it exists.

              This page answers "what is the queue doing" for an operator, and
              pg-boss answers that in pg-boss's terms: on a live 13-source
              import it read `import-stages: 142 created, 1 active` — a number
              that is not even the backlog (a redelivered stage job is a
              deliberate no-op and leaves its row behind; those 142 rows covered
              19 distinct stages). Nothing on this page said which archive was
              importing, how far along it was, or which stage had been waiting
              an hour.

              The SAME component the import surface pins, not a second copy —
              two implementations of a progress card drift, and the one nobody
              is looking at is the one that rots. Renders nothing when no import
              is in flight, so the page is unchanged the rest of the time. */}
          <JobsImportActivity />

          {/* One card, not two. This and "Queue Activity" sat next to each
              other answering the same question in two registers: the sentences
              here already said "8,535 jobs have given up" and "36 are failing
              but still retrying", and the six tiles below repeated both figures
              at the weight of "Retrying 0".

              Now the card says what it thinks, then shows its working — the six
              live counts, then the proportional split by category. The counts
              stayed clickable, because they are how an operator filters the
              table underneath. */}
          <JobHealthCard
            stateCounts={healthStateCounts}
            categoryCounts={list.data?.categoryCounts ?? {}}
            crons={dashboard.data?.crons ?? []}
            loading={list.loading || dashboard.loading}
            onSelect={(filter) => onFilterChange(filter)}
            onOpenSchedules={() => navigate('/jobs/schedules')}
            onClearTerminal={clearTerminal}
            summary={dashboard.data?.summary}
            refreshing={refreshing || dashboard.refreshing}
            error={dashboard.error}
            staleSince={dashboard.staleSince}
            updatedAt={dashboard.updatedAt}
            onRefresh={refreshAll}
            onSelectState={(state: string) => onFilterChange({ state, offset: 0 })}
          />

          {/* Controls sit directly under the counts on both form factors.
              "Something is pegging this box" is answered by the tiles and acted
              on here, and a control an operator has to scroll past four cards to
              find is one they reach for after they have already restarted the
              appliance. Folded closed by default, so the page it sits on is
              still a monitoring page.

              Above the section switch, so it is reachable from every Jobs
              address rather than only from Overview — the reason it is placed
              high is the same reason it should not be one more thing to
              navigate to. */}
          {controlsCard}

          {/* A focused section shows one surface. Overview keeps the whole
              stack, because "what is the queue doing right now" is a question
              you answer by scanning several cards at once, and that is the
              address someone lands on from the rail's Jobs row. */}
          {section === 'jobs-history' ? (
            historyCharts
          ) : section === 'jobs-schedules' ? (
            schedules
          ) : section === 'jobs-dead-letters' ? (
            deadLettersCard
          ) : isCategoryRoute ? (
            jobsTable
          ) : phone ? (
            /* Phone: live work first (jobs), reference last (history, schedules,
               dead letters). Desktop keeps history above the table and dead
               letters next to the tab that points at them. */
            <>
              {jobsTable}
              {historyCharts}
              {schedules}
              <div className="order-last">{deadLettersCard}</div>
            </>
          ) : (
            <>
              {historyCharts}
              {jobsTable}
              {deadLettersCard}
              {schedules}
            </>
          )}
        </div>
      </PageContent>
    </PullToRefresh>
  );
}

function SchedulesCard({
  crons,
  loading,
  jobTypes,
  cronControls,
  saving,
  onSave,
}: {
  crons: JobsDashboardResponse['crons'];
  loading: boolean;
  jobTypes: JobTypesResponse | null;
  cronControls: readonly JobCronControl[] | null;
  saving: boolean;
  onSave: (patch: JobControlsPatch) => Promise<boolean>;
}) {
  const phone = usePhone();
  // Joined by name, which is the key both payloads agree on. A schedule the
  // controls endpoint does not know about (older server, or one registered
  // since the controls were read) keeps its row and loses only its switch —
  // the table is the record of what is registered, not of what is switchable.
  const controlByName = useMemo(
    () => new Map((cronControls ?? []).map((control) => [control.name, control])),
    [cronControls],
  );

  /**
   * Every schedule in the build, not every schedule THIS process registered.
   *
   * `crons` comes from JobMonitorService, which can only see what reached its
   * own SchedulerRegistry — under `CI_ROLE=web` that omits the eleven
   * `role: 'worker'` schedules (of 53). Listing only those left a schedule an
   * operator came to switch off simply absent, with nothing to say it existed;
   * #2546 fixed that for the controls list, and this table has to hold the same
   * line now that the switches live here.
   *
   * The monitor lists them itself now, with the durable history it had been
   * fetching and discarding, so on a current server this merge finds nothing to
   * append. It is kept for the appliance running a build from before that: the
   * controls payload IS complete (CronRegistry is filled by the decorator before
   * the role gate), so anything it knows about and the monitor does not is
   * appended with no timings rather than going missing.
   */
  const rows = useMemo(() => {
    const seen = new Set(crons.map((cron) => cron.name));
    const registered = crons.map((cron) => ({
      cron,
      descriptor: describeCron(cron.name, jobTypes),
      schedule: describeCronExpression(cron.cron),
      control: controlByName.get(cron.name) ?? null,
    }));
    // Only reached against a server that predates the monitor listing these
    // itself. It cannot supply run times — that is the point of the fix on the
    // server — but it must not claim `running: false` either: the status badge
    // renders that as "stopped", so eleven schedules ticking normally in the
    // worker read as stopped on the page an operator opens to find out what
    // stopped. `null` plus `servedHere: false` is what the badge reads.
    const elsewhere = (cronControls ?? [])
      .filter((control) => !seen.has(control.name))
      .map((control) => ({
        cron: {
          name: control.name,
          cron: control.cron,
          timezone: null,
          running: null,
          role: control.role,
          servedHere: false,
          nextRunAt: null,
          lastRunAt: null,
          lastSuccessAt: null,
          overdue: false,
        } as JobsDashboardResponse['crons'][number],
        descriptor: describeCron(control.name, jobTypes),
        schedule: describeCronExpression(control.cron),
        control,
      }));

    return [...registered, ...elsewhere];
  }, [crons, jobTypes, controlByName, cronControls]);

  // Zero on a single-process appliance (CI_ROLE=all), which is the default, so
  // the note stays silent unless the split is actually in use.
  const elsewhereCount = (cronControls ?? []).filter((control) => !control.servedHere).length;

  return (
    <FoldCard fold>
      <Card.Header className={cardPad(phone)}>
        <FoldTrigger>
          <Card.Title className="text-base">Schedules</Card.Title>
          <Card.Description>
            {elsewhereCount > 0
              ? `Every schedule in this build (${rows.length})`
              : `Recurring jobs registered in this process (${rows.length})`}
          </Card.Description>
        </FoldTrigger>
      </Card.Header>
      <FoldBody>
        <Card.Content className={cardPad(phone)}>
          {/* `rows`, not `crons`: under CI_ROLE=web the dashboard reports no
              schedules at all while the controls payload still has all 53, and
              keying the empty state off the raw prop printed "nothing is
              registered here" over a full table. */}
          {loading && !rows.length ? (
            <Skeleton className="h-32 w-full" />
          ) : !rows.length ? (
            <p className="text-sm text-muted-foreground">No recurring jobs are registered here.</p>
          ) : (
            <>
              {/* Said once, not per row. These schedules are listed and
                  switchable from here because the mode is a ci.job_settings row
                  every process reads — but their run times come from the
                  scheduler that registered them, which is not this one. */}
              {elsewhereCount > 0 ? (
                <p className="pb-2 text-xs text-muted-foreground">
                  {elsewhereCount} of these run in the worker process rather than this one. They are
                  switchable from here, and their last run and last success are shown — those are durable,
                  written by whichever process ticks. When they fire next is only knowable there.
                </p>
              ) : null}
              {phone ? (
                <SchedulesPhoneList rows={rows} saving={saving} onSave={onSave} />
              ) : (
                // A table, like the Jobs list — same columns-and-rows shape, so the two
                // cards read as one system rather than two unrelated widgets. The grid
                // of cards it replaced could not be scanned down a column (every
                // schedule's cron sat at a different x-position).
                <SchedulesTable rows={rows} saving={saving} onSave={onSave} />
              )}
            </>
          )}
        </Card.Content>
      </FoldBody>
    </FoldCard>
  );
}

type ScheduleRow = {
  cron: JobsDashboardResponse['crons'][number];
  descriptor: ReturnType<typeof describeCron>;
  schedule: ReturnType<typeof describeCronExpression>;
  /** Null when the controls payload has no row for this schedule. */
  control: JobCronControl | null;
};

/**
 * A schedule whose registry key is a UUID the scheduler minted for it.
 *
 * `@nestjs/schedule` falls back to `crypto.randomUUID()` when a `@Cron` has no
 * `name`, and re-mints it on every boot, so the durable side of the job — its
 * `ci.cron_runs` history, its last-run cell, firing it by hand — is looking up a
 * string that no longer exists. Only a backend change fixes that, so the row
 * asks for one instead of quietly rendering a UUID as if it were a name.
 */
function UnnamedCronWarning() {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase text-amber-700 dark:text-amber-400"
      title="The @Cron behind this schedule has no name, so the scheduler mints a new one every boot and its run history cannot be found. Give the decorator a { name }."
    >
      <AlertTriangle aria-hidden className="h-3 w-3" />
      needs a name
    </span>
  );
}

/**
 * What the schedule is doing, in the order of what an operator can act on.
 *
 * `running` is not health — the `@Cron` wrapper catches, logs and returns, so a
 * schedule whose body throws on every tick stays started forever, and its "last
 * run" stays two minutes old because that stamp lands before the body. The
 * server's `overdue` (its own expression, evaluated against the last recorded
 * attempt) is the only one of the three that can say something has gone wrong,
 * so it takes the badge whenever it is set.
 *
 * `disabled` outranks all of them, because it is the only one that is somebody's
 * decision rather than a symptom.
 */
function ScheduleStatus({ cron, className }: { cron: ScheduleRow['cron']; className?: string }) {
  const badge = cn('text-[10px] uppercase', className);

  // Outranks every other status. The scheduler still holds a disabled schedule
  // and `nextRunAt` still advances, so without this the row reads "scheduled" —
  // a job that says it will run at 03:00 and then does not is the exact failure
  // the Controls card exists to avoid creating.
  if (cron.disabled) {
    return (
      <Badge
        variant="secondary"
        className={badge}
        title="Switched off in Controls. The schedule is still registered, but its body does not run."
      >
        off
      </Badge>
    );
  }

  // Outranks the elsewhere badge: `overdue` is now derived from durable state
  // (the declared expression against ci.cron_runs), so it is as true for a
  // worker schedule as for a local one — and it is the one signal that says a
  // worker process has died. A row that is late must say so wherever it runs.
  if (cron.overdue) {
    return (
      <Badge
        variant="destructive"
        className={badge}
        title="The scheduler has this job started, but its expression asked for a fire that never got recorded."
      >
        <AlertTriangle aria-hidden className="h-3 w-3" />
        overdue
      </Badge>
    );
  }

  // Checked before `running`, which is null for these rows rather than false.
  // Read as a boolean it badges every worker schedule "stopped" — on the page an
  // operator opens precisely to find out what has stopped.
  if (cron.servedHere === false) {
    return (
      <Badge
        variant="outline"
        className={badge}
        title={`Runs in the ${cron.role ?? 'worker'} process, not the one serving this page. Its last run, last success and overdue verdict are durable and shown; whether its scheduler is started and when it fires next are only knowable there.`}
      >
        {cron.role ?? 'elsewhere'}
      </Badge>
    );
  }

  if (!cron.running) {
    return (
      <Badge variant="secondary" className={badge}>
        stopped
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className={badge}>
      scheduled
    </Badge>
  );
}

/**
 * When this schedule last completed a tick — "never" rather than "—" once it has
 * attempted one, because a cron that fires on time and fails every time is
 * exactly the case both "scheduled" and "last run" report as healthy.
 */
function lastSucceeded(cron: ScheduleRow['cron']): string {
  if (cron.lastSuccessAt) {
    return new Date(cron.lastSuccessAt).toLocaleTimeString();
  }

  return cron.lastRunAt ? 'never' : '—';
}

/**
 * The on/off switch for one schedule, in the row that already describes it.
 *
 * This used to live in the Controls card, as a second list of all 53 schedules
 * with its own name and cadence beside each switch — so the page rendered every
 * schedule twice, and the answer to "is this one on, and when does it next
 * run?" was split across two cards that had to be read together. The switch
 * belongs next to the thing it switches.
 *
 * A locked schedule renders a disabled switch rather than nothing: the state is
 * still worth showing, and the title says who locked it.
 */
function ScheduleSwitch({
  cron,
  control,
  saving,
  onSave,
}: {
  cron: string;
  control: JobCronControl | null;
  saving: boolean;
  onSave: (patch: JobControlsPatch) => Promise<boolean>;
}) {
  if (!control) {
    return null;
  }

  const enabled = control.mode !== 'disabled';

  return (
    <Switch
      checked={enabled}
      disabled={saving || control.locked}
      aria-label={`${cron} enabled`}
      title={
        control.locked
          ? (control.lockedReason ?? 'This schedule is locked on.')
          : enabled
            ? 'Running on its schedule. Switch off to stop it.'
            : `Off — this schedule does not run.${
                control.skippedCount > 0
                  ? ` ${control.skippedCount.toLocaleString()} tick${control.skippedCount === 1 ? '' : 's'} skipped.`
                  : ''
              }`
      }
      onCheckedChange={(next) =>
        void onSave({ crons: [{ name: cron, mode: next ? 'enabled' : 'disabled' }] })
      }
    />
  );
}

function SchedulesTable({
  rows,
  saving,
  onSave,
}: {
  rows: readonly ScheduleRow[];
  saving: boolean;
  onSave: (patch: JobControlsPatch) => Promise<boolean>;
}) {
  // Only offer the column when something in it can actually be switched.
  const switchable = rows.some((row) => row.control != null);

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border/60 text-left text-xs uppercase text-muted-foreground">
            {switchable ? (
              <th scope="col" className="w-10 py-1.5 pr-3 font-medium">
                {/* The switches identify themselves; a visible "On" here would
                    be read out again for every row. */}
                <span className="sr-only">Enabled</span>
              </th>
            ) : null}
            <th scope="col" className="py-1.5 pr-3 font-medium">
              Schedule
            </th>
            <th scope="col" className="py-1.5 pr-3 font-medium">
              Category
            </th>
            <th scope="col" className="py-1.5 pr-3 font-medium">
              Every
            </th>
            <th scope="col" className="py-1.5 pr-3 font-medium">
              When
            </th>
            <th scope="col" className="py-1.5 pr-3 font-medium">
              Status
            </th>
            <th scope="col" className="py-1.5 pr-3 text-right font-medium">
              Next run
            </th>
            <th scope="col" className="py-1.5 pr-3 text-right font-medium">
              Last run
            </th>
            <th scope="col" className="py-1.5 text-right font-medium">
              Last succeeded
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ cron, descriptor, schedule, control }) => (
            <tr key={cron.name} className="border-b border-border/40 last:border-0">
              {switchable ? (
                <td className="py-1.5 pr-3">
                  <ScheduleSwitch cron={cron.name} control={control} saving={saving} onSave={onSave} />
                </td>
              ) : null}
              <td className="py-1.5 pr-3">
                <span className="flex items-center gap-1.5 font-medium" title={cron.name}>
                  <span
                    aria-hidden
                    className={`h-2 w-2 shrink-0 rounded-full ${categoryDot(descriptor.category)}`}
                  />
                  <span className="truncate">{descriptor.label}</span>
                  {descriptor.unnamed && <UnnamedCronWarning />}
                </span>
              </td>
              <td className="py-1.5 pr-3 text-muted-foreground">{descriptor.categoryLabel}</td>
              <td className="py-1.5 pr-3 whitespace-nowrap" title={schedule.raw}>
                {schedule.frequency}
              </td>
              <td className="py-1.5 pr-3 whitespace-nowrap text-muted-foreground" title={schedule.raw}>
                {schedule.when || '—'}
              </td>
              <td className="py-1.5 pr-3">
                <ScheduleStatus cron={cron} />
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">
                {cron.nextRunAt ? new Date(cron.nextRunAt).toLocaleTimeString() : '—'}
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">
                {cron.lastRunAt ? new Date(cron.lastRunAt).toLocaleTimeString() : '—'}
              </td>
              <td className="py-1.5 text-right tabular-nums text-muted-foreground">{lastSucceeded(cron)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SchedulesPhoneList({
  rows,
  saving,
  onSave,
}: {
  rows: readonly ScheduleRow[];
  saving: boolean;
  onSave: (patch: JobControlsPatch) => Promise<boolean>;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, ScheduleRow[]>();

    for (const row of rows) {
      const list = map.get(row.descriptor.category) ?? [];
      list.push(row);
      map.set(row.descriptor.category, list);
    }

    const order = Object.keys(CATEGORY_LABELS);

    return [...map.entries()].sort((left, right) => {
      const li = order.indexOf(left[0]);
      const ri = order.indexOf(right[0]);

      return (li === -1 ? 99 : li) - (ri === -1 ? 99 : ri);
    });
  }, [rows]);

  return (
    // Labelled group, so "the schedules list" is addressable — by a screen
    // reader, and by a test that wants THIS Maintenance row rather than any
    // element on the page whose name happens to contain the word.
    <div role="group" aria-label="Schedules by category">
      <Accordion type="multiple" className="w-full">
        {groups.map(([category, items]) => (
          <Accordion.Item key={category} value={category}>
            <Accordion.Trigger className="py-2.5 text-sm hover:no-underline">
              <span className="flex min-w-0 items-center gap-2">
                <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${categoryDot(category)}`} />
                <span className="truncate">{categoryLabel(category)}</span>
                <span className="text-xs font-normal text-muted-foreground tabular-nums">{items.length}</span>
              </span>
            </Accordion.Trigger>
            <Accordion.Content>
              <ul className="pb-1">
                {items.map(({ cron, descriptor, schedule, control }) => (
                  <li key={cron.name} className="border-t border-border/40 py-2">
                    <div className="flex items-start justify-between gap-2">
                      <span
                        className="flex min-w-0 flex-wrap items-center gap-1.5 font-medium"
                        title={cron.name}
                      >
                        {descriptor.label}
                        {descriptor.unnamed && <UnnamedCronWarning />}
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <ScheduleStatus cron={cron} />
                        <ScheduleSwitch cron={cron.name} control={control} saving={saving} onSave={onSave} />
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground" title={schedule.raw}>
                      {schedule.frequency}
                      {schedule.when ? ` · ${schedule.when}` : ''}
                      {' · next '}
                      {cron.nextRunAt ? new Date(cron.nextRunAt).toLocaleTimeString() : '—'}
                      {' · succeeded '}
                      {lastSucceeded(cron)}
                    </p>
                  </li>
                ))}
              </ul>
            </Accordion.Content>
          </Accordion.Item>
        ))}
      </Accordion>
    </div>
  );
}

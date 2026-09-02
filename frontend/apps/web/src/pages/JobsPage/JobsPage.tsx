import { useCallback, useMemo, useState } from 'react';

import { usePageTitle } from '@ci/common';
import { Accordion, Badge, Button, Card, Skeleton, cn } from '@ci/shadcn';
import { AlertTriangle, RefreshCcw } from '@ci/shadcn/icons';
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
import { useJobControls } from './useJobControls';
import { useHistoryWindow, useJobFilters } from './useJobFilters';
import { useJobHistory } from './useJobHistory';
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

  const onFilterChange = useCallback((next: Partial<JobFilters>) => setFilters(next), [setFilters]);

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
    <SchedulesCard crons={dashboard.data?.crons ?? []} loading={dashboard.loading} jobTypes={jobTypes} />
  );
  const controlsCard = (
    <JobControlsCard
      controls={controls.data}
      loading={controls.loading}
      saving={controls.saving}
      error={controls.error}
      errorStatus={controls.errorStatus}
      jobTypes={jobTypes}
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

          {/* The verdict first. The tiles that used to be here were accurate
              and mute — "Dead-lettered 8,431" carried the same weight as
              "Retrying 2", and on a real appliance the first number was 43% of
              every job on the box. The counts survive as the proportional bar
              inside this card; what is new is that the page now says what it
              thinks before showing its working. */}
          <JobHealthCard
            stateCounts={list.data?.stateCounts ?? {}}
            categoryCounts={list.data?.categoryCounts ?? {}}
            crons={dashboard.data?.crons ?? []}
            loading={list.loading || dashboard.loading}
            onSelect={(filter) => onFilterChange(filter)}
            onOpenSchedules={() => navigate('/jobs/schedules')}
          />

          <SummaryCard
            summary={dashboard.data?.summary}
            loading={dashboard.loading}
            refreshing={refreshing || dashboard.refreshing}
            error={dashboard.error}
            staleSince={dashboard.staleSince}
            updatedAt={dashboard.updatedAt}
            onRefresh={refreshAll}
            onSelectState={(state) => onFilterChange({ state, offset: 0 })}
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

type SummaryCardProps = {
  summary?: JobsDashboardResponse['summary'];
  loading: boolean;
  /** A refetch is running over figures that are still on screen. */
  refreshing: boolean;
  error: string | null;
  staleSince: Date | null;
  updatedAt: Date | null;
  onRefresh: () => void;
  onSelectState: (state: string) => void;
};

function SummaryCard({
  summary,
  loading,
  refreshing,
  error,
  staleSince,
  updatedAt,
  onRefresh,
  onSelectState,
}: SummaryCardProps) {
  const phone = usePhone();

  // Each tile is a shortcut into the table below it — a number an operator
  // cannot click is a number they have to go hunting for.
  const tiles = useMemo(
    () => [
      { label: 'Pending', value: summary?.pending ?? 0, state: 'created' },
      { label: 'Running', value: summary?.active ?? 0, state: 'active' },
      { label: 'Retrying', value: summary?.retry ?? 0, state: 'retry' },
      { label: 'Completed', value: summary?.completed ?? 0, state: 'completed' },
      { label: 'Failed', value: summary?.failed ?? 0, state: 'failed' },
      { label: 'Dead-lettered', value: summary?.deadLettered ?? 0, state: 'dead-letter' },
    ],
    [summary],
  );

  return (
    <FoldCard>
      <Card.Header
        className={cn(
          'flex gap-2',
          phone
            ? 'flex-row items-center justify-between'
            : 'flex-col md:flex-row md:items-center md:justify-between',
          cardPad(phone),
        )}
      >
        <div>
          <Card.Title className="text-lg">Queue Activity</Card.Title>
          <Card.Description>
            {updatedAt
              ? `Updated ${new Intl.DateTimeFormat(undefined, {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                }).format(updatedAt)}`
              : 'Current job workload'}
          </Card.Description>
        </div>
        {/* Spins in place. The figures below it stay exactly where they are —
            a refresh that blanked the card is what sent an operator to a page
            with nothing on it every time they asked it a question. */}
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          aria-busy={refreshing || undefined}
          className={phone ? 'shrink-0' : 'w-full md:w-auto'}
        >
          <RefreshCcw className={cn(phone ? 'h-4 w-4' : 'mr-2 h-4 w-4', refreshing && 'animate-spin')} />
          {phone ? (
            <span className="sr-only">{refreshing ? 'Refreshing' : 'Refresh'}</span>
          ) : refreshing ? (
            'Refreshing'
          ) : (
            'Refresh'
          )}
        </Button>
      </Card.Header>
      <Card.Content className={cn('space-y-3', cardPad(phone))}>
        {staleSince ? (
          <div
            role="status"
            className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400"
          >
            <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 break-words">
              Showing data from {staleSince.toLocaleTimeString()} — refreshes have been failing since then
              {error ? ` (${error})` : ''}.
            </span>
          </div>
        ) : error ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          >
            <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        ) : null}

        {loading && !summary ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <div className={phone ? 'grid grid-cols-2 gap-2' : 'grid gap-3 sm:grid-cols-3 lg:grid-cols-6'}>
            {tiles.map((tile) => (
              <button
                key={tile.label}
                type="button"
                onClick={() => onSelectState(tile.state)}
                className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-left transition-colors hover:border-border hover:bg-muted/60"
              >
                <p className="text-xs uppercase text-muted-foreground">{tile.label}</p>
                <p className="mt-0.5 text-xl font-semibold tabular-nums">{tile.value.toLocaleString()}</p>
              </button>
            ))}
          </div>
        )}
      </Card.Content>
    </FoldCard>
  );
}

/**
 * The recurring jobs, from Nest's live scheduler registry.
 *
 * The column this replaces rendered `pgboss.schedule`, which nothing in this
 * codebase writes — so it was empty on every appliance ever shipped while ~34
 * `@Cron` methods ran beside it, invisible.
 */
function SchedulesCard({
  crons,
  loading,
  jobTypes,
}: {
  crons: JobsDashboardResponse['crons'];
  loading: boolean;
  jobTypes: JobTypesResponse | null;
}) {
  const phone = usePhone();
  const rows = useMemo(
    () =>
      crons.map((cron) => ({
        cron,
        descriptor: describeCron(cron.name, jobTypes),
        schedule: describeCronExpression(cron.cron),
      })),
    [crons, jobTypes],
  );

  return (
    <FoldCard fold>
      <Card.Header className={cardPad(phone)}>
        <FoldTrigger>
          <Card.Title className="text-base">Schedules</Card.Title>
          <Card.Description>Recurring jobs registered in this process ({crons.length})</Card.Description>
        </FoldTrigger>
      </Card.Header>
      <FoldBody>
        <Card.Content className={cardPad(phone)}>
          {loading && !crons.length ? (
            <Skeleton className="h-32 w-full" />
          ) : !crons.length ? (
            <p className="text-sm text-muted-foreground">No recurring jobs are registered here.</p>
          ) : phone ? (
            <SchedulesPhoneList rows={rows} />
          ) : (
            // A table, like the Jobs list — same columns-and-rows shape, so the two
            // cards read as one system rather than two unrelated widgets. The grid
            // of cards it replaced could not be scanned down a column (every
            // schedule's cron sat at a different x-position).
            <SchedulesTable rows={rows} />
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

  if (!cron.running) {
    return (
      <Badge variant="secondary" className={badge}>
        stopped
      </Badge>
    );
  }

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

function SchedulesTable({ rows }: { rows: readonly ScheduleRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border/60 text-left text-xs uppercase text-muted-foreground">
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
          {rows.map(({ cron, descriptor, schedule }) => (
            <tr key={cron.name} className="border-b border-border/40 last:border-0">
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

function SchedulesPhoneList({ rows }: { rows: readonly ScheduleRow[] }) {
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
                {items.map(({ cron, descriptor, schedule }) => (
                  <li key={cron.name} className="border-t border-border/40 py-2">
                    <div className="flex items-start justify-between gap-2">
                      <span
                        className="flex min-w-0 flex-wrap items-center gap-1.5 font-medium"
                        title={cron.name}
                      >
                        {descriptor.label}
                        {descriptor.unnamed && <UnnamedCronWarning />}
                      </span>
                      <ScheduleStatus cron={cron} className="shrink-0" />
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

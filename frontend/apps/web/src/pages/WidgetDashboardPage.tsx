import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { gql } from '@apollo/client';
import { useQuery } from '@apollo/client/react';
import { buildWidgetSnapshot, fetchJson, usePageTitle } from '@ci/common';
import type { CompanionWidgetSnapshot } from '@ci/common';
import { ArrowUpRight, ChartNoAxesCombined, CircleHelp, Clock3, ListTodo, Workflow } from '@ci/shadcn/icons';
import type { LucideIcon } from '@ci/shadcn/icons';
import { Link } from 'react-router-dom';

import { useFeatures } from '@/common/feature';
import { PageContent } from '@/components/layout';
import { starterPromptsFor } from '@/pages/ChatPage/starterPrompts';

const WIDGET_TASKS = gql(
  'query WidgetBoardTasks { tasks(first: 100) { edges { node { id title status dueAt scheduledFor } } } }',
);
const WIDGET_FORECAST = gql(
  'query WidgetBoardForecast { forecast(horizon: "24h") { generatedAt systemStatus stillLearning buckets { startTime predictedL0 l0Probs { label probability } } } }',
);
const WIDGET_METRICS = gql(
  'query WidgetBoardMetrics($from: String!, $to: String!) { dailyMetrics(from: $from, to: $to) { nMessages nPlaces kmTraveled } }',
);

interface TaskData {
  tasks?: {
    edges?: Array<{
      node: {
        id?: string;
        title?: string;
        status?: string;
        dueAt?: string | null;
        scheduledFor?: string | null;
      };
    }>;
  };
}

interface ForecastData {
  forecast?: {
    generatedAt?: string;
    systemStatus?: string;
    stillLearning?: boolean;
    buckets?: Array<{
      startTime?: string;
      predictedL0?: string | null;
      l0Probs?: Array<{ label?: string; probability?: number }>;
    }>;
  } | null;
}

interface MetricsData {
  dailyMetrics?: Array<{ nMessages?: number | null; nPlaces?: number | null; kmTraveled?: number | null }>;
}

interface JobsData {
  summary?: { pending?: number; active?: number; failed?: number; deadLettered?: number; completed?: number };
}

function localDay(): string {
  const now = new Date();

  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

function timeLabel(value: string | null): string {
  if (!value) {
    return 'Waiting for sync';
  }

  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return 'Updated recently';
  }

  return `Updated ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

function taskDueLabel(value: string | null): string {
  if (!value) {
    return 'No due date';
  }

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return 'Date unavailable';
  }

  const today = new Date();
  const targetDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).valueOf();
  const currentDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).valueOf();
  const dayOffset = Math.round((targetDay - currentDay) / 86_400_000);
  if (dayOffset === 0) {
    return 'Today';
  }

  if (dayOffset === 1) {
    return 'Tomorrow';
  }

  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function WidgetCard({
  label,
  icon: Icon,
  freshness,
  children,
}: {
  label: string;
  icon: LucideIcon;
  freshness?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex min-h-52 flex-col rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
      <div className="mb-4 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-primary">
        <Icon aria-hidden className="h-4 w-4" />
        <span>{label}</span>
      </div>
      <div className="min-h-0 flex-1">{children}</div>
      {freshness ? <p className="mt-4 text-xs text-muted-foreground">{freshness}</p> : null}
    </section>
  );
}

function OpenLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium text-foreground hover:border-primary/50 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
      <ArrowUpRight aria-hidden className="h-4 w-4" />
    </Link>
  );
}

export interface WidgetDashboardViewProps {
  snapshot: CompanionWidgetSnapshot;
  prompts: string[];
  paths: { plan: string; chat: string; forecast: string; jobs: string };
}

/** The presentational board is shared by the live page and visual QA fixtures. */
export function WidgetDashboardView({ snapshot, prompts, paths }: WidgetDashboardViewProps) {
  const forecastAvailable = snapshot.insight.forecastGeneratedAt !== null;
  const metricsAvailable = snapshot.insight.metricsUpdatedAt !== null;
  const tasksAvailable = snapshot.plan.updatedAt !== null;
  const jobsAvailable = snapshot.jobs.updatedAt !== null;

  return (
    <>
      <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">
            Your data, at a glance
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">Widgets</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            A live overview of your plan, questions, predictions, activity and background work.
          </p>
        </div>
        <p className="text-xs text-muted-foreground">Refreshes every 15 minutes while this page is open.</p>
      </header>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <WidgetCard label="Plan" icon={ListTodo} freshness={timeLabel(snapshot.plan.updatedAt)}>
          {tasksAvailable ? (
            <>
              <div className="mb-3 text-3xl font-semibold tabular-nums">
                {snapshot.plan.openCount}
                <span className="ml-2 text-sm font-medium text-muted-foreground">open</span>
              </div>
              {snapshot.plan.tasks.length > 0 ? (
                <ul className="space-y-3">
                  {snapshot.plan.tasks.slice(0, 3).map((task) => (
                    <li key={task.id} className="flex items-start justify-between gap-3 text-sm">
                      <span className="line-clamp-2">{task.title}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {taskDueLabel(task.dueAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">Nothing is waiting on your plan.</p>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Open Memory to sync your plan.</p>
          )}
          <OpenLink to={paths.plan}>Open plan</OpenLink>
        </WidgetCard>

        <WidgetCard label="Questions" icon={CircleHelp}>
          <p className="mb-3 text-lg font-semibold">What do you want to understand?</p>
          {prompts.length > 0 ? (
            <ul className="space-y-2">
              {prompts.map((prompt) => (
                <li key={prompt} className="text-sm text-muted-foreground">
                  {prompt}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Search your saved records or open Memory chat.</p>
          )}
          <OpenLink to={paths.chat}>Ask Memory</OpenLink>
        </WidgetCard>

        <WidgetCard
          label="Prediction"
          icon={ChartNoAxesCombined}
          freshness={timeLabel(snapshot.insight.forecastGeneratedAt)}
        >
          {forecastAvailable ? (
            <>
              <p className="text-xl font-semibold leading-snug">
                {snapshot.insight.prediction ?? 'Forecast is updating'}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                {snapshot.insight.confidence === null
                  ? 'Confidence not available'
                  : `${Math.round(snapshot.insight.confidence * 100)}% likely`}
                {snapshot.insight.stillLearning ? ' · still learning' : ''}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                Forecast status: {snapshot.insight.systemStatus}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No current forecast is available.</p>
          )}
          <OpenLink to={paths.forecast}>Explore forecast</OpenLink>
        </WidgetCard>

        <WidgetCard label="Stats" icon={Clock3} freshness={timeLabel(snapshot.insight.metricsUpdatedAt)}>
          {metricsAvailable ? (
            <div className="grid grid-cols-3 gap-2 pt-2">
              <div>
                <p className="text-2xl font-semibold tabular-nums">{snapshot.insight.messages}</p>
                <p className="text-xs text-muted-foreground">messages</p>
              </div>
              <div>
                <p className="text-2xl font-semibold tabular-nums">{snapshot.insight.places}</p>
                <p className="text-xs text-muted-foreground">places</p>
              </div>
              <div>
                <p className="text-2xl font-semibold tabular-nums">
                  {snapshot.insight.kilometers.toFixed(1)}
                </p>
                <p className="text-xs text-muted-foreground">km</p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Today’s activity stats will appear after sync.</p>
          )}
          <OpenLink to="/memory">Browse Memory</OpenLink>
        </WidgetCard>

        <WidgetCard label="Jobs" icon={Workflow} freshness={timeLabel(snapshot.jobs.updatedAt)}>
          {jobsAvailable ? (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-2xl font-semibold tabular-nums">{snapshot.jobs.active}</p>
                <p className="text-xs text-muted-foreground">active</p>
              </div>
              <div>
                <p className="text-2xl font-semibold tabular-nums">{snapshot.jobs.pending}</p>
                <p className="text-xs text-muted-foreground">pending</p>
              </div>
              <div>
                <p className="text-2xl font-semibold tabular-nums text-destructive">
                  {snapshot.jobs.failed + snapshot.jobs.deadLettered}
                </p>
                <p className="text-xs text-muted-foreground">needs attention</p>
              </div>
              <div>
                <p className="text-2xl font-semibold tabular-nums">{snapshot.jobs.completed}</p>
                <p className="text-xs text-muted-foreground">completed</p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Queue health appears after a successful sync.</p>
          )}
          <OpenLink to={paths.jobs}>Open jobs</OpenLink>
        </WidgetCard>
      </div>
    </>
  );
}

/** Live, privacy-aware overview of the same plan, forecast, activity and queue data as the native widgets. */
export default function WidgetDashboardPage() {
  usePageTitle('Widgets - Companion Memory');
  const { isFeatureEnabled } = useFeatures();
  const day = useMemo(localDay, []);
  const tasks = useQuery<TaskData>(WIDGET_TASKS, { errorPolicy: 'all', pollInterval: 15 * 60_000 });
  const forecast = useQuery<ForecastData>(WIDGET_FORECAST, { errorPolicy: 'all', pollInterval: 15 * 60_000 });
  const metrics = useQuery<MetricsData>(WIDGET_METRICS, {
    variables: { from: day, to: day },
    errorPolicy: 'all',
    pollInterval: 15 * 60_000,
  });
  const [jobs, setJobs] = useState<JobsData | null>(null);
  const [jobsUpdatedAt, setJobsUpdatedAt] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const result = await fetchJson<JobsData>('/api/jobs/dashboard');
        if (active && result?.summary) {
          setJobs(result);
          setJobsUpdatedAt(new Date().toISOString());
        }
      } catch {
        // An unavailable queue is shown as unsynced, never as zero work.
      }
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), 15 * 60_000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const snapshot = useMemo(
    () =>
      buildWidgetSnapshot({
        tasks: tasks.data?.tasks?.edges?.map(({ node }) => node),
        forecast: forecast.data?.forecast,
        metrics: metrics.data?.dailyMetrics,
        jobs,
        tasksUpdatedAt: tasks.data?.tasks ? new Date().toISOString() : null,
        metricsUpdatedAt: metrics.data?.dailyMetrics ? new Date().toISOString() : null,
        jobsUpdatedAt,
      }),
    [forecast.data?.forecast, jobs, jobsUpdatedAt, metrics.data?.dailyMetrics, tasks.data?.tasks],
  );

  const promptList = starterPromptsFor(isFeatureEnabled).slice(0, 3);
  const chatPath = isFeatureEnabled('chat.page') ? '/memory/chat' : '/search';
  const planPath = isFeatureEnabled('planning.page') ? '/plan/tasks' : '/plan/calendar';
  const forecastPath = isFeatureEnabled('forecast.page') ? '/forecast' : '/memory';
  const jobsPath = isFeatureEnabled('jobs.page') ? '/jobs' : '/settings';

  return (
    <PageContent className="gap-5 pb-8 sm:gap-6">
      <WidgetDashboardView
        snapshot={snapshot}
        prompts={promptList}
        paths={{ plan: planPath, chat: chatPath, forecast: forecastPath, jobs: jobsPath }}
      />
    </PageContent>
  );
}

import { useCallback, useEffect, useRef } from 'react';

import { gql } from '@apollo/client';
import { useApolloClient } from '@apollo/client/react';
import {
  acknowledgeWidgetActions,
  addAppStateListener,
  buildWidgetSnapshot,
  clearWidgetSnapshot,
  fetchJson,
  isNativePlatform,
  publishWidgetSnapshot,
  readWidgetActions,
} from '@ci/common';

import { useAuth } from '@/hooks';

const WIDGET_TASKS = gql("query CompanionWidgetTasks { tasks(first: 100) { edges { node { id title status dueAt scheduledFor } } } }");
const WIDGET_FORECAST = gql("query CompanionWidgetForecast { forecast(horizon: \"24h\") { generatedAt systemStatus stillLearning buckets { startTime predictedL0 l0Probs { label probability } } } }");
const WIDGET_DAILY_METRICS = gql("query CompanionWidgetDailyMetrics($from: String!, $to: String!) { dailyMetrics(from: $from, to: $to) { date nMessages nPlaces kmTraveled } }");
const WIDGET_COMPLETE_TASK = gql("mutation CompanionWidgetCompleteTask($id: ID!) { completeTask(id: $id) { id status } }");

interface TaskQuery {
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

interface ForecastQuery {
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

interface MetricsQuery {
  dailyMetrics?: Array<{ nMessages?: number | null; nPlaces?: number | null; kmTraveled?: number | null }>;
}

interface JobsDashboard {
  summary?: {
    pending?: number;
    active?: number;
    failed?: number;
    deadLettered?: number;
    completed?: number;
  };
}

/**
 * Keeps a tiny, sanitized snapshot for native home widgets. It never runs on web or
 * while signed out. Task actions are queued by the native widget and completed here
 * through the same authenticated GraphQL client as the app.
 */
export function WidgetSnapshotSync() {
  const client = useApolloClient();
  const [{ authenticated, initializing }] = useAuth();
  const authStateRef = useRef({ authenticated, initializing });
  authStateRef.current = { authenticated, initializing };
  const sourceRef = useRef<{
    tasks?: Array<NonNullable<NonNullable<TaskQuery['tasks']>['edges']>[number]['node']>;
    forecast?: NonNullable<ForecastQuery['forecast']>;
    metrics?: NonNullable<MetricsQuery['dailyMetrics']>;
    jobs?: JobsDashboard;
    tasksUpdatedAt?: string;
    metricsUpdatedAt?: string;
    jobsUpdatedAt?: string;
  }>({});
  const hasSnapshotDataRef = useRef(false);
  const inFlightRef = useRef(false);

  const sync = useCallback(async () => {
    if (!isNativePlatform() || !authenticated || initializing || inFlightRef.current) return;
    inFlightRef.current = true;

    try {
      const hasActiveSession = () => authStateRef.current.authenticated && !authStateRef.current.initializing;
      const actions = await readWidgetActions().catch(() => []);
      const handledActionIds: string[] = [];

      for (const action of actions.slice(0, 10)) {
        if (!hasActiveSession()) return;
        if (action.type !== 'completeTask' || !action.id || !action.taskId) continue;

        try {
          await client.mutate({
            mutation: WIDGET_COMPLETE_TASK,
            variables: { id: action.taskId },
          });
          handledActionIds.push(action.id);
        } catch {
          // Keep failed actions queued. The next foreground refresh will retry them.
        }
      }

      if (handledActionIds.length > 0) {
        await acknowledgeWidgetActions(handledActionIds).catch(() => undefined);
      }
      if (!hasActiveSession()) return;

      const now = new Date();
      const today = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
      ].join('-');
      const results = await Promise.allSettled([
        client.query<TaskQuery>({ query: WIDGET_TASKS, fetchPolicy: 'network-only' }),
        client.query<ForecastQuery>({ query: WIDGET_FORECAST, fetchPolicy: 'network-only' }),
        client.query<MetricsQuery>({
          query: WIDGET_DAILY_METRICS,
          variables: { from: today, to: today },
          fetchPolicy: 'network-only',
        }),
        fetchJson<JobsDashboard>('/api/jobs/dashboard'),
      ]);
      let receivedFreshData = false;

      const tasksResult = results[0];
      const forecastResult = results[1];
      const metricsResult = results[2];
      const jobsResult = results[3];
      if (!hasActiveSession()) return;
      const tasksData = tasksResult?.status === 'fulfilled' ? tasksResult.value.data : undefined;
      const forecastData = forecastResult?.status === 'fulfilled' ? forecastResult.value.data : undefined;
      const metricsData = metricsResult?.status === 'fulfilled' ? metricsResult.value.data : undefined;
      if (tasksData?.tasks) {
        sourceRef.current.tasks = tasksData.tasks.edges?.map(({ node }) => node);
        sourceRef.current.tasksUpdatedAt = new Date().toISOString();
        hasSnapshotDataRef.current = true;
        receivedFreshData = true;
      }
      if (forecastData?.forecast) {
        sourceRef.current.forecast = forecastData.forecast;
        hasSnapshotDataRef.current = true;
        receivedFreshData = true;
      }
      if (metricsData?.dailyMetrics) {
        sourceRef.current.metrics = metricsData.dailyMetrics;
        sourceRef.current.metricsUpdatedAt = new Date().toISOString();
        hasSnapshotDataRef.current = true;
        receivedFreshData = true;
      }
      if (jobsResult && jobsResult.status === 'fulfilled' && jobsResult.value?.summary) {
        sourceRef.current.jobs = jobsResult.value;
        sourceRef.current.jobsUpdatedAt = new Date().toISOString();
        hasSnapshotDataRef.current = true;
        receivedFreshData = true;
      }

      if (hasSnapshotDataRef.current && receivedFreshData) {
        await publishWidgetSnapshot(buildWidgetSnapshot({ ...sourceRef.current, now: new Date() })).catch(
          () => undefined,
        );
        // A sign-out can race the native write. Clear again after it settles so an
        // older authenticated request cannot repopulate the app-group cache.
        if (!hasActiveSession()) await clearWidgetSnapshot().catch(() => undefined);
      }
    } finally {
      inFlightRef.current = false;
    }
  }, [authenticated, client, initializing]);

  useEffect(() => {
    if (!isNativePlatform() || initializing) return;

    if (!authenticated) {
      sourceRef.current = {};
      hasSnapshotDataRef.current = false;
      void clearWidgetSnapshot().catch(() => undefined);

      return;
    }

    const refresh = () => void sync();
    refresh();
    const interval = window.setInterval(refresh, 15 * 60_000);
    let removeAppStateListener: (() => void) | undefined;
    void addAppStateListener((active) => {
      if (active) refresh();
    }).then((remove) => {
      removeAppStateListener = remove;
    });

    const onVisibilityChange = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      removeAppStateListener?.();
    };
  }, [authenticated, initializing, sync]);

  return null;
}

import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  auth: { authenticated: false as boolean, initializing: false as boolean },
  client: { query: vi.fn(), mutate: vi.fn() },
  addAppStateListener: vi.fn(async () => () => undefined),
  acknowledgeWidgetActions: vi.fn(async () => undefined),
  buildWidgetSnapshot: vi.fn(() => ({ version: 1 }) as never),
  clearWidgetSnapshot: vi.fn(async () => undefined),
  fetchJson: vi.fn(),
  isNativePlatform: vi.fn(() => true),
  publishWidgetSnapshot: vi.fn(async () => undefined),
  readWidgetActions: vi.fn(async () => []),
}));

vi.mock('@apollo/client/react', () => ({ useApolloClient: () => harness.client }));
vi.mock('@/hooks', () => ({ useAuth: () => [harness.auth, {}] }));
vi.mock('@ci/common', () => ({
  acknowledgeWidgetActions: harness.acknowledgeWidgetActions,
  addAppStateListener: harness.addAppStateListener,
  buildWidgetSnapshot: harness.buildWidgetSnapshot,
  clearWidgetSnapshot: harness.clearWidgetSnapshot,
  fetchJson: harness.fetchJson,
  isNativePlatform: harness.isNativePlatform,
  publishWidgetSnapshot: harness.publishWidgetSnapshot,
  readWidgetActions: harness.readWidgetActions,
}));

import { classTitle } from '@/lib/activityPalette';

import { WidgetSnapshotSync } from './WidgetSnapshotSync';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });

  return { promise, resolve };
}

describe('WidgetSnapshotSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks keeps implementations, so drop the previous test's query queue.
    harness.client.query.mockReset();
    harness.fetchJson.mockReset();
    harness.auth = { authenticated: true, initializing: false };
  });

  it('does not publish a stale response after sign-out clears the native cache', async () => {
    const taskQuery = deferred<unknown>();
    const forecastQuery = deferred<unknown>();
    const metricsQuery = deferred<unknown>();
    const jobsQuery = deferred<unknown>();
    const queries = [taskQuery, forecastQuery, metricsQuery];
    harness.client.query.mockImplementation(() => queries.shift()?.promise);
    harness.fetchJson.mockReturnValue(jobsQuery.promise);

    const { rerender } = render(<WidgetSnapshotSync />);
    await waitFor(() => {
      expect(harness.client.query).toHaveBeenCalledTimes(3);
      expect(harness.fetchJson).toHaveBeenCalledTimes(1);
    });

    harness.auth = { authenticated: false, initializing: false };
    rerender(<WidgetSnapshotSync />);

    await act(async () => {
      taskQuery.resolve({ data: { tasks: { edges: [] } } });
      forecastQuery.resolve({ data: { forecast: { systemStatus: 'READY', buckets: [] } } });
      metricsQuery.resolve({ data: { dailyMetrics: [] } });
      jobsQuery.resolve({ summary: { pending: 0, active: 0, failed: 0, deadLettered: 0, completed: 0 } });
      await Promise.all([taskQuery.promise, forecastQuery.promise, metricsQuery.promise, jobsQuery.promise]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(harness.clearWidgetSnapshot).toHaveBeenCalledTimes(1);
    expect(harness.publishWidgetSnapshot).not.toHaveBeenCalled();
  });

  // The home-screen widgets print `insight.prediction` as it is; they showed
  // the forecast's own "WORK" or "UNKNOWN".
  it('publishes the prediction in the calendar legend words', async () => {
    harness.client.query
      .mockResolvedValueOnce({ data: { tasks: { edges: [] } } })
      .mockResolvedValueOnce({ data: { forecast: { systemStatus: 'READY', buckets: [] } } })
      .mockResolvedValueOnce({ data: { dailyMetrics: [] } });
    harness.fetchJson.mockResolvedValue({
      summary: { pending: 0, active: 0, failed: 0, deadLettered: 0, completed: 0 },
    });

    render(<WidgetSnapshotSync />);

    await waitFor(() => expect(harness.publishWidgetSnapshot).toHaveBeenCalledTimes(1));
    expect(harness.buildWidgetSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ predictionLabel: classTitle }),
    );
  });
});

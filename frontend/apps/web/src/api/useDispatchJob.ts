import { useCallback, useEffect, useState } from 'react';

import { fetchJson } from '@ci/common';

import { useAuth } from '@/hooks';

export interface DispatchJob {
  id: string;
  threadId: string;
  taskId: string | null;
  status: 'queued' | 'running' | 'blocked' | 'completed' | 'failed';
  result: Record<string, unknown> | null;
  packet?: { source?: { title?: string } };
}

export async function createDispatchJob(
  authToken: string,
  input: {
    sourceKind: string;
    sourceId: string;
    title: string;
    body?: string | null;
    taskId?: string | null;
    ask?: string | null;
  },
): Promise<DispatchJob> {
  const job = await fetchJson<DispatchJob>('/api/v1/agent/jobs', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });

  if (!job?.threadId) {
    throw new Error('Dispatch did not return a thread');
  }

  return job;
}

export async function steerDispatchJob(
  authToken: string,
  jobId: string,
  input: { action: 'continue' | 'redirect' | 'halt'; message?: string },
): Promise<DispatchJob> {
  const job = await fetchJson<DispatchJob>(`/api/v1/agent/jobs/${jobId}/steer`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });

  if (!job?.id) {
    throw new Error('Steer did not return a job');
  }

  return job;
}

export function useDispatchJob(threadId: string | null, enabled: boolean) {
  const [{ authToken }] = useAuth();
  const [job, setJob] = useState<DispatchJob | null>(null);

  const reload = useCallback(async () => {
    if (!authToken || !threadId || !enabled) {
      setJob(null);

      return null;
    }

    const result = await fetchJson<{ job: DispatchJob | null }>(
      `/api/v1/agent/jobs?threadId=${encodeURIComponent(threadId)}`,
      { headers: { Authorization: `Bearer ${authToken}` } },
    );
    setJob(result?.job ?? null);

    return result?.job ?? null;
  }, [authToken, enabled, threadId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!enabled || !threadId) {
      return;
    }

    const timer = window.setInterval(() => {
      void reload();
    }, 4000);

    return () => window.clearInterval(timer);
  }, [enabled, reload, threadId]);

  return { job, reload };
}

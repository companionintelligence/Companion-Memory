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

/**
 * `authToken` is the web JWT — null in the native app, whose credential is a keystore API key that
 * `fetchJson` attaches as `x-api-key` on its own. Send the bearer only when there is one; an empty
 * one is a malformed header on a request that would otherwise authenticate with the key.
 */
function bearer(authToken: string | null): Record<string, string> {
  return authToken ? { Authorization: `Bearer ${authToken}` } : {};
}

export async function createDispatchJob(
  authToken: string | null,
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
      ...bearer(authToken),
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
  authToken: string | null,
  jobId: string,
  input: { action: 'continue' | 'redirect' | 'halt'; message?: string },
): Promise<DispatchJob> {
  const job = await fetchJson<DispatchJob>(`/api/v1/agent/jobs/${jobId}/steer`, {
    method: 'POST',
    headers: {
      ...bearer(authToken),
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
  // `authenticated`, not `authToken`: the token is the web JWT, which the native shell never has.
  const [{ authToken, authenticated }] = useAuth();
  const [job, setJob] = useState<DispatchJob | null>(null);

  const reload = useCallback(async () => {
    if (!authenticated || !threadId || !enabled) {
      setJob(null);

      return null;
    }

    const result = await fetchJson<{ job: DispatchJob | null }>(
      `/api/v1/agent/jobs?threadId=${encodeURIComponent(threadId)}`,
      { headers: bearer(authToken ?? null) },
    );
    setJob(result?.job ?? null);

    return result?.job ?? null;
  }, [authToken, authenticated, enabled, threadId]);

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

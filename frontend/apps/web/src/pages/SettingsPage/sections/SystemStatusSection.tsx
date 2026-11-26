import { useCallback, useEffect, useState } from 'react';

import { fetchJson } from '@ci/common';
import { Button } from '@ci/shadcn';
import { AlertCircle, Check } from '@ci/shadcn/icons';
import { Link, useLocation } from 'react-router-dom';

import { useFeatures } from '@/common/feature';
import { useSessionAuth } from '@/hooks/useSessionAuth';

interface Operations {
  at: string;
  ok: boolean;
  syncEnabled: boolean;
  dependencies: Array<{ name: string; ok: boolean; detail?: string }>;
  connections: {
    connected: number;
    needsSignIn: number;
    syncing: number;
    lastSyncedAt: string | null;
  } | null;
  /** Present for administrators only. */
  backup?: { state: string; lastSuccessAt?: string; bytes?: number; coverage?: string } | null;
  processing: {
    waiting?: number;
    active?: number;
    failed?: number;
    delayed?: number;
    lastCompletedAt?: string | null;
  };
}

const LABELS: Record<string, string> = {
  postgres: 'Your database',
  llm: 'Chat model',
  files: 'Photos and attachments',
  summaries: 'Summaries',
  documents: 'Document reading',
  predictions: 'Behavior predictions',
  processing: 'Background processing',
  connections: 'Connected sources',
};

const REFRESH_EVERY_MS = 30_000;

/** A check that never answers must end as a failed refresh, not leave the page on "Checking…". */
const REFRESH_TIMEOUT_MS = 10_000;

function readableDetail(detail: string): string {
  if (detail.startsWith('probe failed')) {
    return 'This service could not be reached. Check that it is running.';
  }

  if (detail.startsWith('timed out')) {
    return 'This service took too long to answer. Try checking again.';
  }

  return detail;
}

export function SystemStatusSection() {
  const { ready, headers } = useSessionAuth();
  const { isFeatureEnabled } = useFeatures();
  const location = useLocation();
  const [status, setStatus] = useState<Operations | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!ready) {
      return;
    }

    setBusy(true);

    try {
      const value = await fetchJson<Operations>('/api/health/operations', {
        headers,
        timeout: REFRESH_TIMEOUT_MS,
      });

      if (!value) {
        throw new Error('No status returned');
      }

      // Only a good answer replaces the last one: a failed refresh leaves it on screen, marked stale.
      setStatus(value);
      setRefreshFailed(false);
    } catch {
      setRefreshFailed(true);
    } finally {
      setBusy(false);
    }
  }, [ready, headers]);

  useEffect(() => {
    void refresh();

    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') {
        void refresh();
      }
    }, REFRESH_EVERY_MS);

    return () => window.clearInterval(timer);
  }, [refresh]);

  const syncNow = async () => {
    setSyncing(true);
    setNotice(null);

    try {
      const result = await fetchJson<{ disabledReason?: string; enqueued: number; skipped: number }>(
        '/api/connections/sync-now',
        { method: 'POST', headers },
      );

      if (!result) {
        throw new Error('No response');
      }

      setNotice(
        result.disabledReason
          ? 'Automatic syncing is paused on this Memory. Ask its administrator to enable scheduled connection sync.'
          : result.enqueued > 0
            ? 'Sync started. Progress will appear here as records arrive.'
            : result.skipped > 0
              ? 'A sync is already in progress.'
              : 'No sources are ready to sync. Connect a source or sign in again.',
      );
      await refresh();
    } catch {
      setNotice('Sync could not start. Check your connection and retry.');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">System status</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            See what is ready, what is still processing, and what needs your attention.
          </p>
        </div>
        <Button variant="outline" className="min-h-11" onClick={() => void refresh()} disabled={busy}>
          {busy ? 'Checking…' : 'Check again'}
        </Button>
      </div>
      {refreshFailed && (
        <p role="alert" className="text-sm text-destructive">
          Could not reach your Memory. Check your connection, then try again.
          {status ? ' The results below are from the last successful check and may be out of date.' : ''}
        </p>
      )}
      {status && (
        <>
          <p role="status" className="text-sm text-muted-foreground">
            {refreshFailed ? 'Last successful check' : 'Checked'} {new Date(status.at).toLocaleString()}
          </p>
          <ul className="divide-y divide-border">
            {status.dependencies.map((part) => (
              <li key={part.name} className="flex items-start gap-3 py-3">
                {part.ok ? (
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                ) : (
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
                )}
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {LABELS[part.name] ?? part.name} · {part.ok ? 'Ready' : 'Needs attention'}
                  </p>
                  {part.detail && (
                    <p className="mt-1 text-sm text-muted-foreground">{readableDetail(part.detail)}</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {status.backup && (
            <div className="space-y-2 border-t border-border pt-4 text-sm">
              <p className="font-medium">
                Appliance backup ·{' '}
                {status.backup.state === 'complete'
                  ? 'Up to date'
                  : status.backup.state === 'not_configured'
                    ? 'Not configured'
                    : 'Needs attention'}
              </p>
              <p className="text-muted-foreground">
                {status.backup.lastSuccessAt
                  ? `Last complete backup: ${new Date(status.backup.lastSuccessAt).toLocaleString()}`
                  : 'No verified complete backup reported.'}
              </p>
              {status.backup.bytes != null && (
                <p className="text-muted-foreground">
                  {(status.backup.bytes / (1024 * 1024)).toFixed(1)} MB in the last snapshot
                </p>
              )}
              <p className="text-muted-foreground">
                {status.backup.coverage ??
                  'Configure the complete appliance backup schedule and mount its status file to monitor recovery readiness.'}
              </p>
            </div>
          )}
          <div className="space-y-2 border-t border-border pt-4 text-sm">
            <p>
              {status.processing.waiting ?? 'Unknown'} waiting · {status.processing.active ?? 'Unknown'}{' '}
              processing · {status.processing.failed ?? 'Unknown'} failed jobs
            </p>
            <p className="text-muted-foreground">
              {status.connections?.lastSyncedAt
                ? `Last source sync: ${new Date(status.connections.lastSyncedAt).toLocaleString()}`
                : 'No completed source sync recorded yet.'}
            </p>
            {status.processing.delayed ? (
              <p role="alert">
                Processing is taking longer than expected. Check that this Memory’s worker is running.
              </p>
            ) : null}
          </div>
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <Button className="min-h-11" onClick={() => void syncNow()} disabled={syncing}>
          {syncing ? 'Starting…' : 'Sync now'}
        </Button>
        <Button asChild variant="outline" className="min-h-11">
          <Link to="/sources/connect">Manage sources</Link>
        </Button>
        {/* Carries the page this dialog opened over, so closing Settings still returns there. */}
        <Button asChild variant="outline" className="min-h-11">
          <Link to="/settings/model" state={location.state}>
            Check model
          </Link>
        </Button>
        {/* The Jobs routes exist only while `jobs.page` is on; without it this would be a 404. */}
        {isFeatureEnabled('jobs.page') && (
          <Button asChild variant="outline" className="min-h-11">
            <Link to="/jobs">View jobs</Link>
          </Button>
        )}
      </div>
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Ready means the component answered this check. Processing counts are scoped to your account; they do
        not prove that every source or answer is complete.
      </p>
    </div>
  );
}

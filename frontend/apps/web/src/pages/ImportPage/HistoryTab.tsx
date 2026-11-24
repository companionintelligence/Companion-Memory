import { useCallback, useEffect, useState } from 'react';

/**
 * Runs fetched per page. One Google Takeout session produced ~150 runs
 * (oversized media exports as loose files, one run each), so history pages by
 * keyset cursor instead of hoping one fetch covers a lifetime of imports.
 */
const RUNS_PAGE = 100;

import { Alert, Button, Card, cn } from '@ci/shadcn';
import { AlertTriangle } from '@ci/shadcn/icons';

import { useDateTimeFormat } from '@/hooks/useDateTimeFormat';

import { runStatusLabel, serviceLabels } from './runFormat';
import { RunPipeline } from './RunPipeline';
import { ServiceBadges } from './ServiceBadges';
import { useImportApi, useRunProgress, type ImportRun, type ImportSource } from './useImportApi';

/**
 * Every import this appliance has run, newest first.
 *
 * A run started anywhere — a wizard card, the Sync step, the API — lands here,
 * and a reload mid-import reattaches to whatever is still going so a 40GB
 * Takeout does not look abandoned. Opening a run shows its live pipeline with
 * cancel and per-stage retry; closing it collapses it back into the grid.
 */
export function HistoryTab() {
  const api = useImportApi();
  const fmt = useDateTimeFormat();
  const [sources, setSources] = useState<readonly ImportSource[]>([]);
  const [runs, setRuns] = useState<readonly ImportRun[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [showAllRuns, setShowAllRuns] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { run, refresh } = useRunProgress(activeRunId);

  useEffect(() => {
    if (!api.ready) {
      return;
    }

    void api
      .listSources()
      .then(setSources)
      .catch(() => setSources([]));
    void api
      .listRuns(RUNS_PAGE)
      .then((loaded) => {
        setRuns(loaded);
        setExhausted(loaded.length < RUNS_PAGE);

        // Reattach to whatever is still going, so a reload mid-import does not
        // look like nothing is happening.
        const live = loaded.find((entry) => entry.finishedAt == null);

        if (live) {
          setActiveRunId((current) => current ?? live.id);
        }
      })
      .catch(() => setRuns([]));
  }, [api]);

  const handleCancel = useCallback(async () => {
    if (activeRunId == null) {
      return;
    }

    try {
      await api.cancelRun(activeRunId);
      await refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [activeRunId, api, refresh]);

  const handleRetryStage = useCallback(
    async (stageId: string) => {
      if (activeRunId == null) {
        return;
      }

      try {
        await api.retryStage(activeRunId, stageId);
        await refresh();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [activeRunId, api, refresh],
  );

  /**
   * Re-queue the rows a completed push could not write.
   *
   * A separate handler from `handleRetryStage` because it is a separate kind of
   * failure: that one re-runs a stage that failed, this one revives individual
   * rows a stage that SUCCEEDED left behind.
   */
  const handleRetryFailedPush = useCallback(async () => {
    if (activeRunId == null) {
      return;
    }

    try {
      await api.retryFailedPush(activeRunId);
      await refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [activeRunId, api, refresh]);

  return (
    <div className="space-y-6">
      {error ? (
        <Alert variant="destructive" className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </Alert>
      ) : null}

      {run ? (
        <RunPipeline
          run={run}
          onCancel={() => void handleCancel()}
          onRetryStage={(stageId) => void handleRetryStage(stageId)}
          onRetryFailedPush={() => void handleRetryFailedPush()}
          onClose={() => setActiveRunId(null)}
          services={serviceLabels(run.dataSources, sources)}
          sources={sources}
        />
      ) : null}

      {runs.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-lg font-medium">Earlier imports</h2>
          {/* A grid rather than full-width rows: one import's label and date
              need a column, not a screen. The server returns newest first and
              the grid flows by row, so the most recent sits top-left and the
              oldest bottom-right without any sorting here. */}
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {runs
              .filter((entry) => entry.id !== activeRunId)
              .slice(0, showAllRuns ? undefined : 10)
              .map((entry) => (
                <li key={entry.id}>
                  <Card className="flex h-full flex-row items-center justify-between gap-2 p-3">
                    <div className="min-w-0 space-y-1">
                      <p className="truncate font-medium">{entry.label ?? 'Import'}</p>
                      <p className="truncate text-sm text-muted-foreground">
                        {fmt.dateTime(entry.createdAt)}
                        {/* What the run actually yielded. This is the one place
                            the number is true of the thing it is next to: a run
                            has one record count, where a per-SOURCE figure could
                            only be the archive's total misattributed to each
                            service inside it. */}
                        {entry.records != null && entry.records > 0 && (
                          <> · {entry.records.toLocaleString()} records</>
                        )}
                      </p>
                      {/* Whether it worked. The card carried a label, a date
                          and its services, so a run that FAILED looked exactly
                          like one that imported — on a surface whose whole job
                          is telling you what happened to your archives. The
                          status was on every entry the API returns and simply
                          was not rendered. Only non-success is coloured: a list
                          where every row shouts is a list you stop reading. */}
                      <p
                        className={cn(
                          'truncate text-sm',
                          entry.status === 'failed' || entry.status === 'cancelled'
                            ? 'text-destructive'
                            : 'text-muted-foreground',
                        )}
                      >
                        {runStatusLabel(entry.status)}
                      </p>
                      <ServiceBadges services={serviceLabels(entry.dataSources, sources)} />
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => setActiveRunId(entry.id)}>
                      View
                    </Button>
                  </Card>
                </li>
              ))}
          </ul>

          <div className="flex gap-2">
            {!showAllRuns && runs.filter((entry) => entry.id !== activeRunId).length > 10 && (
              <Button variant="outline" size="sm" onClick={() => setShowAllRuns(true)}>
                Show all {runs.filter((entry) => entry.id !== activeRunId).length} loaded imports
              </Button>
            )}
            {showAllRuns && !exhausted && (
              <Button
                variant="outline"
                size="sm"
                disabled={loadingMore}
                onClick={() => {
                  const last = runs[runs.length - 1];

                  if (last == null) {
                    return;
                  }

                  setLoadingMore(true);
                  void api
                    .listRuns(RUNS_PAGE, { createdAt: last.createdAt, id: last.id })
                    .then((page) => {
                      setRuns((current) => [...current, ...page]);
                      setExhausted(page.length < RUNS_PAGE);
                    })
                    .catch(() => {
                      // Leave exhausted false so the button stays for a retry.
                    })
                    .finally(() => setLoadingMore(false));
                }}
              >
                {loadingMore ? 'Loading…' : `Load ${RUNS_PAGE} more`}
              </Button>
            )}
          </div>
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">
          Nothing imported yet — Pick, Export and Sync above walk you through it.
        </p>
      )}
    </div>
  );
}

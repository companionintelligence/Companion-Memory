import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchJson } from '@ci/common';

import { useSessionAuth } from '@/hooks/useSessionAuth';
import { useImportApi } from '@/pages/ImportPage/useImportApi';

import type { MemoryTotals } from './firstSync';

/** The slice of `GET /v1/ingest/status` the banner reads. */
interface IngestStatus {
  readonly tables: MemoryTotals & Record<string, number>;
  readonly searchIndex: {
    readonly queue: { readonly created: number; readonly active: number; readonly failed: number };
  };
}

export interface FirstSyncStatus {
  /** Why the latest refresh failed, if it did. The numbers below are then the last good ones. */
  readonly error: string | null;
  /** When the ingest status last answered in full; `null` until it has. */
  readonly lastCheckedAt: Date | null;
  /** Search-index jobs that failed rather than waiting. `null` until the index status has answered. */
  readonly failedIndexingItems: number | null;
  readonly totals: MemoryTotals | null;
  /** Items still waiting on the search index. */
  readonly indexingItems: number | null;
  /** Imports parsed but never saved. */
  readonly unpushedRuns: number | null;
  /** Re-ask right now (after Save, say) rather than at the next tick. */
  readonly refresh: () => void;
}

const POLL_MS = 8_000;

/** Longer than this and the request is given up as failed, so the banner can say so. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Live "what has actually reached my memory" for the first minutes after
 * onboarding.
 *
 * One timer for the two things the ingest status and the import API each know
 * that the other does not. Pauses on a hidden tab (a banner nobody is looking at
 * is not worth a query every eight seconds) and resumes the moment the tab comes
 * back. A failed poll keeps the last good numbers on screen: a blip mid-import
 * must not blank a counter someone is watching.
 *
 * `enabled` gates everything, so the banner's whole cost is one boolean once it
 * has been dismissed. `importsEnabled` is the `import.page` flag — with
 * importing off there is no `/import` API to ask, and asking would only log
 * 404s.
 */
export function useFirstSyncStatus(enabled: boolean, importsEnabled: boolean): FirstSyncStatus {
  const { ready, headers } = useSessionAuth();
  const { listUnpushed } = useImportApi();

  const [totals, setTotals] = useState<MemoryTotals | null>(null);
  const [indexingItems, setIndexingItems] = useState<number | null>(null);
  const [unpushedRuns, setUnpushedRuns] = useState<number | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);
  const [failedIndexingItems, setFailedIndexingItems] = useState<number | null>(null);
  const kick = useRef<() => void>(() => {});

  useEffect(() => {
    if (!enabled || !ready) {
      return;
    }

    let cancelled = false;
    let timer: number | undefined;
    let loaded = false;
    let sequence = 0;

    const isHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

    const tick = async () => {
      // Repeats pause on a hidden tab; the first read never does, or a banner
      // opened in a background tab would never populate.
      if (isHidden() && loaded) {
        return;
      }

      const current = ++sequence;
      const results = await Promise.allSettled([
        // `timeout`, not `AbortSignal.timeout`: the iPhone app still supports iOS 15, which has no such function.
        fetchJson<IngestStatus>('/api/v1/ingest/status', {
          headers,
          timeout: REQUEST_TIMEOUT_MS,
        }).then((status) => {
          if (cancelled || current !== sequence) {
            return;
          }

          // An answer with nothing in it is a failed refresh. It must not read as an empty queue.
          if (!status) {
            throw new Error('The sync status came back empty.');
          }

          // Read first: an answer without the index section throws here, before any state changes.
          const queue = status.searchIndex.queue;
          const t = status.tables;

          setTotals({
            communications: t.communications,
            events: t.events,
            content: t.content,
            objects: t.objects,
            browser_activity: t.browser_activity,
            position: t.position,
          });
          setLastCheckedAt(new Date());
          setFailedIndexingItems(queue.failed);
          setIndexingItems(queue.created + queue.active);
        }),
        importsEnabled
          ? listUnpushed().then((runs) => {
              if (!cancelled) {
                setUnpushedRuns(runs.length);
              }
            })
          : Promise.resolve(),
      ]);

      if (cancelled || current !== sequence) {
        return;
      }

      setError(
        results.some((result) => result.status === 'rejected')
          ? 'Could not refresh your sync status. Any counts shown are from the last successful check.'
          : null,
      );
      loaded = true;

      if (!isHidden()) {
        timer = window.setTimeout(() => void tick(), POLL_MS);
      }
    };

    kick.current = () => {
      window.clearTimeout(timer);
      void tick();
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        kick.current();
      }
    };

    document.addEventListener('visibilitychange', onVisible);
    void tick();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, headers, importsEnabled, listUnpushed, ready]);

  // With importing off there is nothing to be waiting on; report 0 rather than
  // an eternal `null`, which the checklist reads as "still asking".
  const refresh = useCallback(() => kick.current(), []);

  return {
    error,
    lastCheckedAt,
    failedIndexingItems,
    totals,
    indexingItems,
    unpushedRuns: importsEnabled ? unpushedRuns : 0,
    refresh,
  };
}

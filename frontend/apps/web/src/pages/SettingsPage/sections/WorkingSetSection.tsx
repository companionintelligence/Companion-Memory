import { useEffect, useState, useSyncExternalStore } from 'react';

import { formatBytes, isNativePlatform } from '@ci/common';
import { Button, Card, Dialog, Switch } from '@ci/shadcn';
import { usePowerSync } from '@powersync/react';
import type { AbstractPowerSyncDatabase } from '@powersync/web';

import {
  deleteAllPreviews,
  isPreviewSyncEnabled,
  measurePreviews,
  setPreviewSyncEnabled,
  subscribePreviewSync,
  type PreviewStoreStatus,
} from '@/api/powersync/previews';
import {
  clearPowerSyncWorkingSet,
  getReplicaOpenState,
  measurePowerSyncSizeBytes,
  subscribeReplicaOpenState,
} from '@/api/powersync/session';
import {
  POWER_SYNC_CACHE_BUDGET_BYTES,
  formatCacheBudget,
  getLookbackDays,
} from '@/api/powersync/workingSet';

export function WorkingSetSection() {
  // A browser keeps no copy at all (PowerSyncProvider opens no database there),
  // so there is no working set to show or clear — only the fact that nothing is
  // stored.
  if (!isNativePlatform()) {
    return (
      <Card>
        <Card.Content className="space-y-1 pt-6">
          <h3 className="text-sm font-medium">On-device working set</h3>
          <p className="text-sm text-muted-foreground">
            This browser keeps no copy of your data. Only the mobile apps store a working set, in encrypted
            SQLite on the phone; here, everything comes from your Memory Server as you use it.
          </p>
        </Card.Content>
      </Card>
    );
  }

  return <NativeWorkingSetSection />;
}

/**
 * The context holds the encrypted replica once it is open and nothing before:
 * while the file is still opening, and on a phone whose native adapter failed,
 * there is no working set to measure or clear yet.
 */
function NativeWorkingSetSection() {
  const database = usePowerSync() as AbstractPowerSyncDatabase | null;
  const openState = useSyncExternalStore(subscribeReplicaOpenState, getReplicaOpenState, getReplicaOpenState);

  if (!database) {
    return (
      <Card>
        <Card.Content className="space-y-1 pt-6">
          <h3 className="text-sm font-medium">On-device working set</h3>
          <p className="text-sm text-muted-foreground">
            {openState.phase === 'failed'
              ? 'This phone’s copy could not be opened, so nothing is stored here; everything comes from your Memory Server.'
              : 'Opening this phone’s copy…'}
          </p>
        </Card.Content>
      </Card>
    );
  }

  return <OpenWorkingSetSection database={database} />;
}

function OpenWorkingSetSection({ database }: { database: AbstractPowerSyncDatabase }) {
  const [usedBytes, setUsedBytes] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);
  const lookbackDays = getLookbackDays();

  useEffect(() => {
    let cancelled = false;

    // The replica's one connection is also the sync client's: during a bulk
    // download a read waits behind its write batches, and after a dev hot
    // reload it answers "database is locked" until the next cold start. Keep
    // asking rather than show "Measuring…" for good.
    const measure = () =>
      void measurePowerSyncSizeBytes(database).then((size) => {
        if (!cancelled && size != null) {
          setUsedBytes(size);
        }
      });

    measure();
    const timer = setInterval(() => {
      if (usedBytes == null) {
        measure();
      }
    }, 5_000);

    return () => {
      clearInterval(timer);
      cancelled = true;
    };
  }, [database, clearing, usedBytes]);

  const handleClear = async () => {
    setClearing(true);

    try {
      await clearPowerSyncWorkingSet();
      setUsedBytes(0);
    } finally {
      setClearing(false);
    }
  };

  const usedLabel = usedBytes == null ? 'Measuring…' : formatCacheBudget(usedBytes);
  const budgetLabel = formatCacheBudget(POWER_SYNC_CACHE_BUDGET_BYTES);

  return (
    <Card>
      <Card.Content className="space-y-4 pt-6">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">On-device working set</h3>
          <p className="text-sm text-muted-foreground">
            This phone keeps a rolling window of notes, messages, threads and recent events in encrypted
            SQLite — currently the last {lookbackDays} days, capped at {budgetLabel} — plus a searchable index
            of everything (names, subjects and snippets), so search keeps working when your Memory Server is
            unreachable. It is not a copy of the whole server: full-size media, the graph and embeddings stay
            online; photo previews are the one exception, below.
          </p>
          <p className="text-sm text-muted-foreground">
            Used: {usedLabel} / {budgetLabel}
          </p>
        </div>
        <Button variant="outline" onClick={() => void handleClear()} disabled={clearing}>
          {clearing ? 'Clearing…' : 'Clear cache'}
        </Button>

        <PreviewStoreSettings database={database} />
      </Card.Content>
    </Card>
  );
}

/**
 * The photo-preview store's switch and size. Turning it off asks what to do
 * with the previews already here: keep them (and fetch no more) or delete them
 * too — or cancel. Turning it on resumes fetching.
 */
function PreviewStoreSettings({ database }: { database: AbstractPowerSyncDatabase }) {
  const [enabled, setEnabled] = useState(() => isPreviewSyncEnabled());
  const [status, setStatus] = useState<PreviewStoreStatus | null>(null);
  const [measureFailed, setMeasureFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => subscribePreviewSync(() => setEnabled(isPreviewSyncEnabled())), []);

  useEffect(() => {
    let cancelled = false;

    const measure = () =>
      void measurePreviews(database)
        .then((next) => {
          if (!cancelled) {
            setStatus(next);
            setMeasureFailed(false);
          }
        })
        .catch(() => {
          // Same reasons as above; the next tick asks again.
          if (!cancelled) {
            setMeasureFailed(true);
          }
        });

    measure();
    // The store fills in the background; keep the number honest while the page is open.
    const timer = setInterval(measure, 5_000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [database, enabled, deleting]);

  const keepSynced = () => {
    setPreviewSyncEnabled(false);
    setConfirming(false);
  };

  const deleteSynced = async () => {
    setDeleting(true);

    try {
      setPreviewSyncEnabled(false);
      await deleteAllPreviews(database);
      setStatus({ synced: 0, bytes: 0, pending: status?.pending ?? 0 });
    } finally {
      setDeleting(false);
      setConfirming(false);
    }
  };

  const summary =
    status == null
      ? measureFailed
        ? 'Could not measure just now — the phone’s database is busy; trying again.'
        : 'Measuring…'
      : `${status.synced.toLocaleString()} previews, ${formatBytes(status.bytes)}` +
        // Say what the switch is doing to the number. Off with work left, this read as
        // a finished store that had quietly stopped growing (Kyle, 2026-10-23).
        (status.pending > 0
          ? enabled
            ? ` · ${status.pending.toLocaleString()} still to fetch`
            : ` · ${status.pending.toLocaleString()} not fetched while this is off`
          : '');

  return (
    <div className="space-y-2 border-t pt-4" data-testid="preview-store">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-0.5">
          <label htmlFor="preview-sync" className="text-sm font-medium">
            Keep photo previews on this phone
          </label>
          <p className="text-sm text-muted-foreground">
            A small copy of every photo and video, so the gallery and saved records show pictures when your
            Memory Server is unreachable. About 16 kB each.
          </p>
          <p className="text-sm text-muted-foreground" data-testid="preview-store-summary">
            {summary}
          </p>
        </div>
        <Switch
          id="preview-sync"
          checked={enabled}
          onCheckedChange={(next) => {
            if (next) {
              setPreviewSyncEnabled(true);
            } else {
              setConfirming(true);
            }
          }}
        />
      </div>

      {confirming && (
        <Dialog open onOpenChange={(open) => !open && !deleting && setConfirming(false)}>
          <Dialog.Content className="sm:max-w-[425px]">
            <Dialog.Header>
              <Dialog.Title>Stop keeping photo previews?</Dialog.Title>
              <Dialog.Description>
                {status != null && status.synced > 0
                  ? `This phone holds ${status.synced.toLocaleString()} previews (${formatBytes(status.bytes)}). You can keep them and stop fetching new ones, or delete them as well.`
                  : 'No more previews will be fetched. You can turn this back on at any time.'}
              </Dialog.Description>
            </Dialog.Header>
            <Dialog.Footer className="flex-col gap-2 sm:flex-row">
              {/* Three choices of rising consequence, coloured as a traffic light so a glance
                  tells them apart: green keeps everything as it is, amber stops fetching but
                  keeps the files, red deletes. The system has no green or amber variant, so
                  these are class overrides on the plain secondary surface (Kyle, 2026-10-23). */}
              <Button
                variant="secondary"
                className="bg-emerald-600 text-white hover:bg-emerald-700 dark:bg-emerald-700 dark:hover:bg-emerald-600"
                onClick={() => setConfirming(false)}
                disabled={deleting}
              >
                Cancel
              </Button>
              <Button
                variant="secondary"
                className="bg-amber-400 text-black hover:bg-amber-500 dark:bg-amber-500 dark:hover:bg-amber-400"
                onClick={keepSynced}
                disabled={deleting}
              >
                Keep what's here, stop fetching
              </Button>
              <Button variant="destructive" onClick={() => void deleteSynced()} disabled={deleting}>
                {deleting ? 'Deleting…' : 'Delete previews and stop'}
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog>
      )}
    </div>
  );
}

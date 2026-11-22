import { useEffect, useState, useSyncExternalStore } from 'react';

import { formatModelBytes, getApiBaseUrl, isNativePlatform, subscribeApiBaseUrl } from '@ci/common';
import { Button, Dialog, Switch } from '@ci/shadcn';
import { usePowerSync } from '@powersync/react';
import type { AbstractPowerSyncDatabase, SyncStatus } from '@powersync/web';

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
  getSyncUnavailableFor,
  measurePowerSyncSizeBytes,
  subscribeReplicaOpenState,
  subscribeSyncUnavailableFor,
} from '@/api/powersync/session';
import {
  POWER_SYNC_CACHE_BUDGET_BYTES,
  formatCacheBudget,
  getLookbackDays,
} from '@/api/powersync/workingSet';
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat';

import { SettingsGroup, SettingsLoading, SettingsRow } from '../kit';

export function WorkingSetSection() {
  // A browser keeps no copy at all (PowerSyncProvider opens no database there),
  // so there is no working set to show or clear — only the fact that nothing is
  // stored.
  if (!isNativePlatform()) {
    return (
      <SettingsGroup title="On-device working set">
        <SettingsRow
          label="Nothing is stored in this browser"
          hint="Only the mobile apps keep a working set, in encrypted SQLite on the phone. Here, everything comes from your Memory Server as you use it."
        />
      </SettingsGroup>
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
      <SettingsGroup title="On-device working set">
        {openState.phase === 'failed' ? (
          <SettingsRow
            label="This phone’s copy could not be opened"
            hint="Nothing is stored here; everything comes from your Memory Server."
          />
        ) : (
          <SettingsLoading>Opening this phone’s copy…</SettingsLoading>
        )}
      </SettingsGroup>
    );
  }

  return <OpenWorkingSetSection database={database} />;
}

/** Until the first size comes back (a read can wait behind a bulk download). */
const MEASURE_RETRY_MS = 5_000;
/** After that: the copy grows slowly, so a minute is plenty. */
const MEASURE_REFRESH_MS = 60_000;

/** The replica's sync status, kept current. */
function useReplicaSyncStatus(database: AbstractPowerSyncDatabase): SyncStatus | undefined {
  const [status, setStatus] = useState<SyncStatus | undefined>(() => database.currentStatus);

  useEffect(() => {
    setStatus(database.currentStatus);

    return database.registerListener({ statusChanged: setStatus });
  }, [database]);

  return status;
}

/**
 * One line on whether this copy has ever been filled. Without it, a phone that never
 * synced showed "Used: 0.0 GB" under a description of a working set it does not have.
 */
function SyncStatusLine({ database }: { database: AbstractPowerSyncDatabase }) {
  const fmt = useDateTimeFormat();
  const status = useReplicaSyncStatus(database);
  const lastSyncedAt = status?.lastSyncedAt;
  const downloading = status?.dataFlowStatus?.downloading === true;

  let text: string;

  // Once a copy exists, live sync is a short download every few seconds; a line that said so
  // each time flickered between one and two lines. The time moving on says it is current.
  if (lastSyncedAt) {
    text = `Last synced ${fmt.dateTime(lastSyncedAt)}.`;
  } else if (status?.connected || status?.connecting || downloading) {
    text = 'Syncing for the first time…';
  } else {
    text =
      'Not synced yet: this phone has not reached your Memory Server’s sync service, so nothing is stored here.';
  }

  return (
    <span className="block" data-testid="working-set-sync-status">
      {text}
    </span>
  );
}

function OpenWorkingSetSection({ database }: { database: AbstractPowerSyncDatabase }) {
  const apiBaseUrl = useSyncExternalStore(subscribeApiBaseUrl, getApiBaseUrl, getApiBaseUrl);
  const unavailableFor = useSyncExternalStore(
    subscribeSyncUnavailableFor,
    getSyncUnavailableFor,
    getSyncUnavailableFor,
  );
  const [usedBytes, setUsedBytes] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);
  const lookbackDays = getLookbackDays();

  useEffect(() => {
    let cancelled = false;

    let timer: ReturnType<typeof setTimeout> | undefined;

    // The replica's one connection is also the sync client's: during a bulk
    // download a read waits behind its write batches, and after a dev hot
    // reload it answers "database is locked" until the next cold start. So an
    // unanswered read is retried soon rather than leaving "Measuring…" up for
    // good. Once there is a size it is re-read now and then, not once: a first
    // sync can grow the copy by tens of MB while this screen is open.
    const measure = () =>
      void measurePowerSyncSizeBytes(database).then((size) => {
        if (cancelled) {
          return;
        }

        if (size != null) {
          setUsedBytes(size);
        }

        timer = setTimeout(measure, size == null ? MEASURE_RETRY_MS : MEASURE_REFRESH_MS);
      });

    measure();

    return () => {
      clearTimeout(timer);
      cancelled = true;
    };
  }, [database, clearing]);

  const handleClear = async () => {
    setClearing(true);

    try {
      await clearPowerSyncWorkingSet();
      setUsedBytes(0);
    } finally {
      setClearing(false);
    }
  };

  // Only the answer from the server the app points at now counts; a server it has since
  // left says nothing about this one.
  const syncUnavailable = unavailableFor !== null && unavailableFor === apiBaseUrl;
  // MB below a gigabyte: a working set is usually tens of MB, which the budget's
  // GB format rounded to "0.0 GB".
  const usedLabel = usedBytes == null ? 'Measuring…' : formatModelBytes(usedBytes);
  const budgetLabel = formatCacheBudget(POWER_SYNC_CACHE_BUDGET_BYTES);

  return (
    <SettingsGroup
      title="On-device working set"
      help={
        syncUnavailable ? (
          'Everything comes from the server as you use it, so nothing here works while it is unreachable.'
        ) : (
          <p>
            This phone keeps a rolling window of notes, messages, threads and recent events in encrypted
            SQLite (currently the last {lookbackDays} days, capped at {budgetLabel}) plus a searchable index
            of everything (names, subjects and snippets), so search keeps working when your Memory Server is
            unreachable. It is not a copy of the whole server: full-size media, the graph and embeddings stay
            online; photo previews are the one exception.
          </p>
        )
      }
    >
      <SettingsRow
        label="Cache on this phone"
        hint={
          <>
            {syncUnavailable ? (
              <span className="block" data-testid="working-set-sync-status">
                Your Memory Server does not run the sync service, so this phone keeps no copy of your data and
                no photo previews.
              </span>
            ) : (
              <SyncStatusLine database={database} />
            )}
            <span className="block">
              Used: {usedLabel} / {budgetLabel}
            </span>
          </>
        }
        control={
          <Button variant="outline" onClick={() => void handleClear()} disabled={clearing}>
            {clearing ? 'Clearing…' : 'Clear cache'}
          </Button>
        }
      />

      {!syncUnavailable && <PreviewStoreSettings database={database} />}
    </SettingsGroup>
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
      : `${status.synced.toLocaleString()} previews, ${formatModelBytes(status.bytes)}` +
        // Say what the switch is doing to the number. Off with work left, this read as
        // a finished store that had quietly stopped growing (Kyle, 2026-10-23).
        (status.pending > 0
          ? enabled
            ? ` · ${status.pending.toLocaleString()} still to fetch`
            : ` · ${status.pending.toLocaleString()} not fetched while this is off`
          : '');

  return (
    <>
      <SettingsRow
        testId="preview-store"
        label="Keep photo previews on this phone"
        htmlFor="preview-sync"
        align="start"
        hint={
          <>
            A small copy of every photo and video, so the gallery and saved records show pictures when your
            Memory Server is unreachable. About 16 kB each.
            <span className="mt-1 block" data-testid="preview-store-summary">
              {summary}
            </span>
          </>
        }
        control={
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
        }
      />

      {confirming && (
        <Dialog open onOpenChange={(open) => !open && !deleting && setConfirming(false)}>
          <Dialog.Content className="sm:max-w-[425px]">
            <Dialog.Header>
              <Dialog.Title>Stop keeping photo previews?</Dialog.Title>
              <Dialog.Description>
                {status != null && status.synced > 0
                  ? `This phone holds ${status.synced.toLocaleString()} previews (${formatModelBytes(status.bytes)}). You can keep them and stop fetching new ones, or delete them as well.`
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
    </>
  );
}

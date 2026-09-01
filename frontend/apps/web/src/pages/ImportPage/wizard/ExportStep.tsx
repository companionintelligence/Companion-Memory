import { useEffect, useState } from 'react';

import { Badge, Button } from '@ci/shadcn';

import { DropZone } from '../DropZone';
import { groupImportFiles } from '../groupImportFiles';
import { formatBytes } from '../InboxPanel';
import { SourceGuide } from '../SourceGuide';
import { useImportApi, type InboxScan } from '../useImportApi';
import { zipFilesStore } from '../zipStore';

import { LiveRunList } from './LiveRunList';
import { bundleToGuide, serviceLogoUrl, shortTitle, sourceToGuide, type ExportEntry } from './sources';

/**
 * One dropped file's place in the upload queue. Files upload ONE AT A TIME (a
 * Takeout export is often 50 GB × N parts — parallel uploads would just split
 * the same wire N ways), so at any moment at most one row is `uploading`; the
 * rest are `waiting` behind it or already settled.
 *
 * `uploaded` means the bytes are on the appliance AND the file's unpack+parse
 * run has started — the LiveRun cards below the card carry progress from there.
 */
interface UploadItem {
  readonly name: string;
  readonly sizeBytes: number;
  readonly status: 'waiting' | 'packing' | 'uploading' | 'uploaded' | 'failed';
  readonly loadedBytes: number;
  readonly error?: string;
  /**
   * The File this row will upload — kept so a failed row can be retried
   * without re-dropping. For a folder row this is the packed zip, so it is
   * absent until packing succeeds (and a row whose PACKING failed cannot be
   * retried from here; re-drop the folder).
   */
  readonly file?: File;
  /** Free-text progress for non-byte phases, e.g. "packing 132 of 400 files". */
  readonly phase?: string;
}

export interface ExportStepProps {
  entries: readonly ExportEntry[];
  index: number;
  /** Run ids already started per entry key, so revisiting a card keeps its pipelines. */
  runsByEntry: ReadonlyMap<string, readonly string[]>;
  onRunsStarted: (entryKey: string, runIds: readonly string[]) => void;
  onIndex: (index: number) => void;
  onBackToPick: () => void;
  onFinish: () => void;
}

/**
 * Step 2: one card per picked service, walked in order.
 *
 * The card is the authored export instructions with the upload INSIDE them —
 * the steps end at "upload it here", and here is where that is. An upload
 * starts an unpack+parse run immediately (one run per file: a drop is one
 * archive), so extraction happens while the person works through their other
 * services; the final Sync step only pushes. The live pipeline renders on the
 * card, and its parse counts are the "your drop landed" feedback.
 */
export function ExportStep({
  entries,
  index,
  runsByEntry,
  onRunsStarted,
  onIndex,
  onBackToPick,
  onFinish,
}: ExportStepProps) {
  const api = useImportApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploads, setUploads] = useState<readonly UploadItem[]>([]);
  /** A big drop parked for confirmation — see MANY_FILES_SUGGEST_INBOX. */
  const [pendingFiles, setPendingFiles] = useState<File[] | null>(null);
  /** Fetched when a drop parks, so the suggestion can name the actual folder. */
  const [inboxScan, setInboxScan] = useState<InboxScan | null>(null);

  // While files are on the wire, closing or reloading the tab kills the
  // transfer mid-file — hours of a large export, gone silently. The browser's
  // own leave-confirmation is the only thing that can interpose there, so arm
  // it for exactly the busy window. (In-app navigation is safe: the upload
  // loop is a closure and keeps running across wizard steps.)
  useEffect(() => {
    if (!busy) {
      return;
    }

    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };

    window.addEventListener('beforeunload', warn);

    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  if (entries.length === 0) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">No services selected yet.</p>
        <Button onClick={onBackToPick}>← Pick services</Button>
      </div>
    );
  }

  const clamped = Math.min(index, entries.length - 1);
  const entry = entries[clamped];
  const guide = entry.kind === 'bundle' ? bundleToGuide(entry.bundle) : sourceToGuide(entry.source);
  const startedRuns = runsByEntry.get(entry.key) ?? [];
  const notReady = entry.kind === 'service' && !entry.source.importerReady;

  /**
   * Above this many files in one drop, park the batch and suggest the inbox
   * before uploading. Takeout is the canonical trigger: any file bigger than
   * the chosen part size (a long video) is exported LOOSE beside the zip
   * parts, so a large Photos library arrives as hundreds of bare files — each
   * of which would become its own upload and its own run. The inbox imports
   * the whole folder as ONE unit with no HTTP at all. A confirmation, not a
   * wall: fifty legitimate archives is unusual but allowed.
   */
  const MANY_FILES_SUGGEST_INBOX = 50;

  function handleDrop(files: File[]) {
    if (files.length > MANY_FILES_SUGGEST_INBOX) {
      setPendingFiles(files);
      // Name the actual folder in the suggestion — the server resolves it
      // (CI_IMPORT_INBOX_DIR, or the shipped default under the compose mount),
      // so hardcoding a path here would be wrong on someone's appliance.
      void api
        .scanInbox()
        .then(setInboxScan)
        .catch(() => setInboxScan(null));

      return;
    }

    void handleFiles(files);
  }

  /** Patch one row of the upload list by index, immutably. */
  function patchUpload(index: number, patch: Partial<UploadItem>) {
    setUploads((current) => current.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  async function handleFiles(files: File[]) {
    setBusy(true);
    setError(null);

    // A folder becomes ONE unit: packed into a single zip client-side, then
    // uploaded as one archive — one drop, one run, exactly the unit the inbox
    // uses for a directory. Shipping a tree as per-file uploads is what turned
    // one Takeout folder into 150 runs; shipping it as one multipart request
    // is what hung the tab on a ChatGPT export. Loose files stay one unit
    // each, with per-file byte progress.
    interface UploadUnit {
      name: string;
      sizeBytes: number;
      /** The folder's files, when this unit still needs packing into a zip. */
      pack: File[] | null;
      file: File | undefined;
    }

    const units: UploadUnit[] = groupImportFiles(files).flatMap((batch): UploadUnit[] =>
      batch.kind === 'directory'
        ? [
            {
              name: `${batch.name}.zip`,
              sizeBytes: batch.files.reduce((sum, file) => sum + file.size, 0),
              pack: batch.files,
              file: undefined,
            },
          ]
        : batch.files.map((file) => ({ name: file.name, sizeBytes: file.size, pack: null, file })),
    );

    setUploads(
      units.map((unit) => ({
        name: unit.name,
        sizeBytes: unit.sizeBytes,
        status: 'waiting' as const,
        loadedBytes: 0,
        file: unit.file,
      })),
    );

    // One at a time: a Takeout export is often dozens of multi-GB parts, and
    // sequential uploads keep progress attributable to one visible row (and
    // the wire undivided). Each finished unit starts its unpack+parse run
    // IMMEDIATELY, so extraction of part 1 overlaps the upload of part 2 —
    // and a unit that fails costs only itself; the rest keep going.
    const runIds: string[] = [];

    for (const [index, unit] of units.entries()) {
      let file = unit.file;

      if (unit.pack != null) {
        patchUpload(index, { status: 'packing', phase: `packing 0 of ${unit.pack.length} files` });

        try {
          file = await zipFilesStore(unit.pack, (done, total) => {
            patchUpload(index, { phase: `packing ${done} of ${total} files` });
          });
          patchUpload(index, { sizeBytes: file.size, file, phase: undefined });
        } catch (err: unknown) {
          patchUpload(index, {
            status: 'failed',
            phase: undefined,
            error: err instanceof Error ? err.message : String(err),
          });

          continue;
        }
      }

      if (file == null) {
        continue;
      }

      const toSend = file;

      patchUpload(index, { status: 'uploading' });

      // XHR progress events arrive many times a second for hours on a big
      // file; re-render only when the visible number would change.
      let lastShownPercent = -1;

      try {
        const drop = await api.uploadFile(toSend, (loadedBytes, totalBytes) => {
          const percent = Math.floor((loadedBytes / Math.max(totalBytes, 1)) * 100);

          if (percent !== lastShownPercent) {
            lastShownPercent = percent;
            patchUpload(index, { loadedBytes });
          }
        });

        const run = await api.startRun(drop.dropId, {
          // `media` belongs with `parse`, not with the deferred push: it reads
          // the bytes out of the run's scratch tree, and that tree is reclaimed
          // when the run's last stage finishes. Leaving it to the Sync step
          // meant every wizard import — the default view of this page — parsed
          // its photos and then deleted them, producing content rows pointing
          // at files that were never stored.
          label: drop.originalFilename ?? shortTitle(guide.title),
          stages: ['unpack', 'parse', 'media'],
          // What this card stands for — the run records it, and the picker's
          // "imported ✓" trusts declaration over stray recognition.
          declaredSources: entry.importers,
        });

        runIds.push(run.id);
        patchUpload(index, { status: 'uploaded', loadedBytes: toSend.size });
        // Report incrementally — ONLY the run this unit just started, so the
        // live pipeline for part 1 renders while part 2 is still on the wire.
        // The host APPENDS reports; sending the cumulative list here re-added
        // every earlier run per unit (triangular duplication: file 1's run
        // rendered once per remaining file).
        onRunsStarted(entry.key, [run.id]);
      } catch (err: unknown) {
        patchUpload(index, {
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (runIds.length === 0 && files.length > 0) {
      setError('Nothing was uploaded');
    }

    setBusy(false);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <span className="whitespace-nowrap">
          {entry.kind === 'bundle' ? 'Bundle' : 'Service'} {clamped + 1} of {entries.length}
        </span>
        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <span
            className="block h-full rounded-full bg-primary transition-all"
            style={{ width: `${((clamped + 1) / entries.length) * 100}%` }}
          />
        </span>
      </div>

      <SourceGuide
        guide={guide}
        logo={
          entry.kind === 'bundle' ? `/import-logos/${entry.bundle.logo}` : serviceLogoUrl(entry.source.id)
        }
        badges={
          startedRuns.length > 0 ? (
            <Badge variant="outline" className="border-primary text-primary">
              upload started ✓
            </Badge>
          ) : null
        }
      >
        {notReady ? (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            This importer is not finished yet — the export instructions above still work, and an archive
            uploaded once it ships will import without re-exporting.
          </p>
        ) : (
          <DropZone
            compact
            label={`Drop your ${shortTitle(guide.title)} export here`}
            hint={
              entry.kind === 'bundle'
                ? 'Drop the whole export — every product inside it gets imported.'
                : 'It uploads straight to this appliance and starts processing below.'
            }
            disabled={busy || !api.ready}
            onFiles={handleDrop}
          />
        )}

        {pendingFiles != null && (
          <div className="space-y-2 rounded-md border border-amber-500/50 bg-amber-500/5 p-3 text-sm">
            <p className="font-medium">
              That drop is {pendingFiles.length} separate files — the import inbox handles big folders better.
            </p>
            <p className="text-muted-foreground">
              Each dropped file uploads on its own and becomes its own import run; at this count that is slow
              and noisy. Instead, copy the whole folder into the import inbox directory
              {/* The scan is fetched when the drop parks — render the path only
                  once it has arrived AND the folder is real; a null deref here
                  took the whole card down. */}
              {inboxScan?.available === true && (
                <>
                  {' '}
                  (<code className="rounded bg-muted px-1 py-0.5">{inboxScan.displayDir}</code>)
                </>
              )}{' '}
              and import it from the Inbox panel as a single unit — no upload needed.
            </p>
            {inboxScan != null && !inboxScan.available && (
              <p className="text-muted-foreground">
                Heads up: the inbox folder isn&apos;t reachable on this appliance right now
                {inboxScan.reason != null ? ` — ${inboxScan.reason}` : ''}. Uploading here still works.
              </p>
            )}
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const files = pendingFiles;

                  setPendingFiles(null);
                  void handleFiles(files);
                }}
              >
                Upload {pendingFiles.length} files anyway
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setPendingFiles(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {uploads.length > 0 && <UploadList items={uploads} />}
        {!busy && uploads.some((item) => item.status === 'failed' && item.file != null) && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              // The retried batch becomes the new list — the settled rows above
              // it already said what landed; what matters now is the remainder.
              // Rows without a File (a folder whose PACKING failed) are not
              // retryable from here and need a re-drop.
              void handleFiles(
                uploads.flatMap((item) => (item.status === 'failed' && item.file != null ? [item.file] : [])),
              );
            }}
          >
            Retry {uploads.filter((item) => item.status === 'failed' && item.file != null).length} failed
            upload
            {uploads.filter((item) => item.status === 'failed' && item.file != null).length === 1 ? '' : 's'}
          </Button>
        )}
        {error != null && <p className="text-sm text-destructive">{error}</p>}
      </SourceGuide>

      <LiveRunList runIds={startedRuns} />

      <div className="flex items-center justify-between gap-2">
        <Button variant="outline" onClick={() => (clamped === 0 ? onBackToPick() : onIndex(clamped - 1))}>
          ← {clamped === 0 ? 'Services' : 'Previous'}
        </Button>

        {clamped < entries.length - 1 ? (
          <Button onClick={() => onIndex(clamped + 1)}>Next →</Button>
        ) : (
          <Button onClick={onFinish}>Finish → Sync</Button>
        )}
      </div>
    </div>
  );
}

/**
 * The upload queue, one row per dropped file: done ✓, the file currently on
 * the wire with its live percentage, and everything still waiting its turn.
 *
 * This replaced a bare "Uploading…" line, which for a several-hundred-GB
 * Takeout read as a hang: nothing on screen moved for hours, and there was no
 * way to tell part 3-of-12 from part 11-of-12. The overall byte bar is the
 * at-a-glance answer; the per-file rows say exactly what has landed and what
 * has not, which is also what makes a mid-batch failure legible — the failed
 * part is named, everything after it keeps uploading, and only that file needs
 * re-dropping.
 */
function UploadList({ items }: { items: readonly UploadItem[] }) {
  const totalBytes = items.reduce((sum, item) => sum + item.sizeBytes, 0);
  const loadedBytes = items.reduce(
    (sum, item) => sum + (item.status === 'uploaded' ? item.sizeBytes : item.loadedBytes),
    0,
  );
  const settled = items.filter((item) => item.status === 'uploaded' || item.status === 'failed').length;
  const failedCount = items.filter((item) => item.status === 'failed').length;
  const allSettled = settled === items.length;

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="font-medium">
          {allSettled
            ? failedCount > 0
              ? `Uploaded ${items.length - failedCount} of ${items.length} files (${failedCount} failed)`
              : items.length === 1
                ? 'File uploaded'
                : `All ${items.length} files uploaded`
            : `Uploading file ${Math.min(settled + 1, items.length)} of ${items.length}…`}
        </span>
        <span className="whitespace-nowrap text-muted-foreground">
          {formatBytes(loadedBytes)} of {formatBytes(totalBytes)}
        </span>
      </div>

      <span className="block h-1.5 overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full rounded-full bg-primary transition-all"
          style={{ width: `${totalBytes > 0 ? (loadedBytes / totalBytes) * 100 : 0}%` }}
        />
      </span>

      {!allSettled && (
        <p className="text-xs text-muted-foreground">
          Keep this tab open until every file has uploaded — closing it or reloading cancels the file
          currently transferring. (Moving around inside the app is fine.)
        </p>
      )}

      <ul className="max-h-48 space-y-1 overflow-y-auto text-sm">
        {items.map((item, index) => (
          <li key={`${item.name}-${index}`} className="flex items-center justify-between gap-3">
            <span className="min-w-0 flex-1 truncate" title={item.name}>
              {item.name}
            </span>
            {item.status === 'waiting' && (
              <span className="whitespace-nowrap text-muted-foreground">waiting</span>
            )}
            {item.status === 'packing' && (
              <span className="whitespace-nowrap text-primary">{item.phase ?? 'packing…'}</span>
            )}
            {item.status === 'uploading' && (
              <span className="whitespace-nowrap tabular-nums text-primary">
                {Math.floor((item.loadedBytes / Math.max(item.sizeBytes, 1)) * 100)}% ·{' '}
                {formatBytes(item.loadedBytes)}
              </span>
            )}
            {item.status === 'uploaded' && <span className="whitespace-nowrap text-primary">uploaded ✓</span>}
            {item.status === 'failed' && (
              <span
                className="max-w-[50%] truncate whitespace-nowrap text-destructive"
                title={item.error ?? 'failed'}
              >
                failed{item.error != null ? ` — ${item.error}` : ''}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The phone's preview store: one 300 px JPEG per photo or video the synced
 * search documents name (`preview_id`, the original file's id), downloaded
 * from the appliance and kept as a file under the app's data directory, with
 * a ledger row in the local-only `attachments` table (schema.ts).
 *
 * Built on PowerSync's attachments pattern (`@powersync/attachments`): the
 * queue watches which ids the replica names, keeps a ledger row per id, and
 * downloads what is missing. The bytes stay OUT of the SQLite replica on
 * purpose — a synced column would be copied again into PowerSync's oplog and
 * re-sent on every sync-rules change; a file on disk is fetched once and the
 * phone's own storage encryption covers it. Nothing is ever uploaded.
 *
 * Decision (2026-10-22): the appliance's existing 300 px previews, unchanged
 * — ~16 kB each, ~400 MB for a 25k-photo library — rather than a smaller
 * phone rendition, which looked too soft at the gallery's tile size. The
 * switch in Settings → Your data turns the store off: keeping what is there,
 * or deleting it too.
 */
import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { apiKeyHeaders, buildApiUrl } from '@ci/common';
import {
  AbstractAttachmentQueue,
  AttachmentState,
  EncodingType,
  type AttachmentRecord,
  type StorageAdapter,
} from '@powersync/attachments';
import type { AbstractPowerSyncDatabase } from '@powersync/web';

import { DOCUMENTS_TABLE } from './searchIndex';

// ── The setting ─────────────────────────────────────────────────────────────

/** Per phone, in localStorage: the store is on unless this says `off`. */
export const PREVIEW_SYNC_STORAGE_KEY = 'ci.previewSync';

const settingListeners = new Set<() => void>();

export function isPreviewSyncEnabled(): boolean {
  try {
    return localStorage.getItem(PREVIEW_SYNC_STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setPreviewSyncEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(PREVIEW_SYNC_STORAGE_KEY, enabled ? 'on' : 'off');
  } catch {
    // Storage blocked: the running queue still follows the call below.
  }

  settingListeners.forEach((listener) => listener());
}

export function subscribePreviewSync(listener: () => void): () => void {
  settingListeners.add(listener);

  return () => settingListeners.delete(listener);
}

// ── Where the files live ────────────────────────────────────────────────────

/** The directory under the app's data directory. */
export const PREVIEWS_DIRECTORY = 'previews';

/** The file for one preview, as the ledger's `local_uri`. */
export function previewPath(fileId: string): string {
  return `${PREVIEWS_DIRECTORY}/${fileId}.jpg`;
}

/** The API route that streams the file's preview (FilesController.preview). */
export function previewApiPath(fileId: string): string {
  return `/api/files/${encodeURIComponent(fileId)}/preview`;
}

let dataDirectoryUri: Promise<string> | null = null;

/** The app's data directory as a `file://` URI, once. */
function dataDirectory(): Promise<string> {
  dataDirectoryUri ??= Filesystem.getUri({ path: '', directory: Directory.Data }).then((result) =>
    result.uri.replace(/\/$/, ''),
  );

  return dataDirectoryUri;
}

/**
 * A URL an `<img>` in the WebView can load for a ledger row's file: the data
 * directory joined to `local_uri`, through Capacitor's file-serving scheme.
 */
export async function previewSrc(localUri: string): Promise<string> {
  return Capacitor.convertFileSrc(`${await dataDirectory()}/${localUri}`);
}

// ── Storage adapter ─────────────────────────────────────────────────────────

/**
 * The bound on one preview download, headers and body. A preview is ~16 kB, so a
 * healthy appliance answers in well under a second even over a tunnel; what this
 * guards against is a request that never settles. `downloadRecord` runs inside the
 * base class's loop under a `downloading` flag that only clears when the loop
 * ends, so one hung request would stop every later download until the app
 * restarts — a failure, by contrast, pauses the queue for a minute and recovers.
 */
export const PREVIEW_DOWNLOAD_TIMEOUT_MS = 15_000;

/** Every URI the queue hands this is a path under the app's data directory. */
export class CapacitorPreviewStorage implements StorageAdapter {
  uploadFile(): Promise<void> {
    return Promise.reject(new Error('Previews are read-only on the phone'));
  }

  async downloadFile(filePath: string): Promise<Blob> {
    const fileId =
      filePath
        .split('/')
        .pop()
        ?.replace(/\.jpg$/, '') ?? filePath;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PREVIEW_DOWNLOAD_TIMEOUT_MS);

    try {
      const response = await fetch(buildApiUrl(previewApiPath(fileId)), {
        headers: apiKeyHeaders(),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new PreviewDownloadError(response.status);
      }

      // Inside the bound: the signal covers the body read too, and a server that
      // answers its headers and then stalls is the hang this exists for.
      return await response.blob();
    } finally {
      clearTimeout(timer);
    }
  }

  async writeFile(fileUri: string, data: string, options?: { encoding?: EncodingType }): Promise<void> {
    await Filesystem.writeFile({
      path: fileUri,
      data,
      directory: Directory.Data,
      recursive: true,
      ...(options?.encoding === EncodingType.UTF8 ? { encoding: Encoding.UTF8 } : {}),
    });
  }

  async readFile(fileUri: string): Promise<ArrayBuffer> {
    const { data } = await Filesystem.readFile({ path: fileUri, directory: Directory.Data });

    return typeof data === 'string' ? base64ToArrayBuffer(data) : data.arrayBuffer();
  }

  async deleteFile(uri: string): Promise<void> {
    try {
      await Filesystem.deleteFile({ path: uri, directory: Directory.Data });
    } catch {
      // Already gone.
    }
  }

  async fileExists(fileUri: string): Promise<boolean> {
    try {
      await Filesystem.stat({ path: fileUri, directory: Directory.Data });

      return true;
    } catch {
      return false;
    }
  }

  async makeDir(uri: string): Promise<void> {
    try {
      await Filesystem.mkdir({ path: uri, directory: Directory.Data, recursive: true });
    } catch {
      // Exists.
    }
  }

  async copyFile(sourceUri: string, targetUri: string): Promise<void> {
    await Filesystem.copy({ from: sourceUri, to: targetUri, directory: Directory.Data });
  }

  getUserStorageDirectory(): string {
    return '';
  }
}

export class PreviewDownloadError extends Error {
  constructor(readonly status: number) {
    super(`Preview download failed with status ${status}`);
  }
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '');
    reader.readAsDataURL(blob);
  });
}

// ── The queue ───────────────────────────────────────────────────────────────

/** How long to leave the queue alone after the appliance stopped answering. */
export const PREVIEW_OFFLINE_BACKOFF_MS = 60_000;

/** A ledger write per row would be 25k round trips; rows go in batches of this. */
const LEDGER_BATCH = 500;

/** `(id, timestamp, filename, local_uri, media_type, size, state)` for one id, as a ledger insert. */
export function ledgerRow(id: string, now: number): unknown[] {
  return [id, now, `${id}.jpg`, null, 'image/jpeg', null, AttachmentState.QUEUED_DOWNLOAD];
}

/**
 * Which ledger rows the ids the replica names call for. Exported for the test:
 * this is the reconciliation the base class does one row at a time, with a
 * linear scan per id (25k × 25k on a phone), done with sets.
 */
export function reconcileIds(
  wanted: readonly string[],
  known: readonly string[],
): { missing: string[]; orphaned: string[] } {
  const wantedSet = new Set(wanted);
  const knownSet = new Set(known);

  return {
    missing: wanted.filter((id) => !knownSet.has(id)),
    orphaned: known.filter((id) => !wantedSet.has(id)),
  };
}

export class PreviewQueue extends AbstractAttachmentQueue {
  private idsListener: ((ids: string[]) => void) | null = null;

  private disposeStatusListener: (() => void) | null = null;

  private lastSyncedAt: number | null = null;

  private interval: ReturnType<typeof setInterval> | null = null;

  private pausedUntil = 0;

  private stopped = false;

  constructor(db: AbstractPowerSyncDatabase) {
    super({
      powersync: db,
      storage: new CapacitorPreviewStorage(),
      attachmentDirectoryName: PREVIEWS_DIRECTORY,
      downloadAttachments: true,
      // The base class evicts synced files beyond this many; the store is the whole library.
      cacheLimit: 1_000_000_000,
      syncInterval: 60_000,
      performInitialSync: true,
    });
  }

  /** The base class's `init`, minus uploads (there are none) and with an interval this can clear. */
  override async init(): Promise<void> {
    await this.storage.makeDir(this.storageDirectory);
    void this.watchAttachmentIds();
    this.watchDownloads();
    this.interval = setInterval(() => this.trigger(), this.options.syncInterval);
  }

  /** The base class's trigger also runs uploads and cache expiry; neither applies here. */
  override trigger(): void {
    if (this.stopped) {
      return;
    }

    // `downloadRecords` is private to the base class; the watch on the ledger
    // is what runs it, and a changed row is what wakes that watch.
    void this.powersync.execute(
      `UPDATE ${this.table} SET timestamp = timestamp
        WHERE id = (SELECT id FROM ${this.table} WHERE state = ${AttachmentState.QUEUED_DOWNLOAD} LIMIT 1)`,
    );
  }

  dispose(): void {
    this.stopped = true;

    if (this.interval != null) {
      clearInterval(this.interval);
      this.interval = null;
    }

    this.disposeStatusListener?.();
    this.disposeStatusListener = null;
    this.idsListener = null;
  }

  /**
   * The ids the replica names: read once now, and again after each
   * checkpoint the sync client lands (a `watch` on the raw documents table
   * would fire on every one of the 589k row writes of a download).
   */
  onAttachmentIdsChange(onUpdate: (ids: string[]) => void): void {
    this.idsListener = onUpdate;
    void this.refreshIds();

    this.disposeStatusListener = this.powersync.registerListener({
      statusChanged: (status) => {
        const syncedAt = status.lastSyncedAt?.getTime() ?? null;

        if (syncedAt != null && syncedAt !== this.lastSyncedAt) {
          this.lastSyncedAt = syncedAt;
          void this.refreshIds();
        }
      },
    });
  }

  async refreshIds(): Promise<void> {
    if (this.stopped) {
      return;
    }

    // Newest first: the ledger keeps insertion order and the download loop
    // takes the ledger in that order, so the gallery's first pages fill first.
    const rows = await this.powersync.getAll<{ id: string }>(
      `SELECT preview_id AS id
         FROM ${DOCUMENTS_TABLE}
        WHERE preview_id IS NOT NULL
        GROUP BY preview_id
        ORDER BY max(occurred_at) DESC NULLS LAST`,
    );

    this.idsListener?.(rows.map((row) => row.id));
  }

  async newAttachmentRecord(record?: Partial<AttachmentRecord>): Promise<AttachmentRecord> {
    const id = record?.id ?? '';

    return {
      id,
      filename: `${id}.jpg`,
      media_type: 'image/jpeg',
      state: AttachmentState.QUEUED_DOWNLOAD,
      ...record,
    };
  }

  /** The base class's reconciliation, in batches and with sets (see `reconcileIds`). */
  override async watchAttachmentIds(): Promise<void> {
    this.onAttachmentIdsChange(async (ids) => {
      if (this.stopped) {
        return;
      }

      const known = await this.powersync.getAll<{ id: string }>(
        `SELECT id FROM ${this.table} WHERE state < ${AttachmentState.ARCHIVED}`,
      );
      const { missing, orphaned } = reconcileIds(
        ids,
        known.map((row) => row.id),
      );
      const now = Date.now();

      await this.powersync.writeTransaction(async (tx) => {
        for (let start = 0; start < missing.length; start += LEDGER_BATCH) {
          const batch = missing.slice(start, start + LEDGER_BATCH);

          await tx.execute(
            `INSERT OR REPLACE INTO ${this.table} (id, timestamp, filename, local_uri, media_type, size, state)
             VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
            batch.flatMap((id) => ledgerRow(id, now)),
          );
        }

        for (let start = 0; start < orphaned.length; start += LEDGER_BATCH) {
          const batch = orphaned.slice(start, start + LEDGER_BATCH);

          await tx.execute(
            `UPDATE ${this.table} SET state = ${AttachmentState.ARCHIVED} WHERE id IN (${batch.map(() => '?').join(', ')})`,
            batch,
          );
        }
      });

      if (missing.length > 0) {
        this.logger.info(`[previews] ${missing.length} to fetch, ${orphaned.length} no longer named`);
        this.trigger();
      }
    });
  }

  /**
   * One download: the bytes through the API, into the file, then the ledger
   * row. A 404 (no preview after all) archives the row; any other failure
   * leaves it queued and rests the whole queue for a minute, since one
   * failure while the appliance is away would otherwise be followed by
   * thousands more.
   */
  override async downloadRecord(record: AttachmentRecord): Promise<boolean> {
    if (this.stopped || Date.now() < this.pausedUntil) {
      return false;
    }

    const path = previewPath(record.id);

    try {
      const blob = await this.storage.downloadFile(record.filename);

      await this.storage.writeFile(path, await blobToBase64(blob));
      await this.update({
        ...record,
        local_uri: path,
        size: blob.size,
        media_type: blob.type || 'image/jpeg',
        state: AttachmentState.SYNCED,
      });

      return true;
    } catch (error) {
      if (error instanceof PreviewDownloadError && error.status === 404) {
        await this.update({ ...record, state: AttachmentState.ARCHIVED });

        return false;
      }

      this.logger.warn('[previews] download failed; pausing the queue', error);
      this.pausedUntil = Date.now() + PREVIEW_OFFLINE_BACKOFF_MS;

      return false;
    }
  }

  override getLocalUri(filePath: string): string {
    return filePath;
  }

  override get storageDirectory(): string {
    return PREVIEWS_DIRECTORY;
  }
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

let running: PreviewQueue | null = null;

/** Starts the store against the replica, if the setting allows and it is not already running. */
export async function startPreviewSync(db: AbstractPowerSyncDatabase): Promise<void> {
  if (running != null || !isPreviewSyncEnabled()) {
    return;
  }

  const queue = new PreviewQueue(db);

  running = queue;

  try {
    await queue.init();
  } catch (error) {
    console.warn('[previews] store failed to start', error);
    queue.dispose();

    if (running === queue) {
      running = null;
    }
  }
}

/** Stops fetching; what is on disk stays. */
export function stopPreviewSync(): void {
  running?.dispose();
  running = null;
}

export function isPreviewSyncRunning(): boolean {
  return running != null;
}

/** Stops fetching and removes every preview file and ledger row. */
export async function deleteAllPreviews(db: AbstractPowerSyncDatabase): Promise<void> {
  stopPreviewSync();

  try {
    await Filesystem.rmdir({ path: PREVIEWS_DIRECTORY, directory: Directory.Data, recursive: true });
  } catch {
    // Nothing on disk.
  }

  await db.execute('DELETE FROM attachments');
}

export interface PreviewStoreStatus {
  /** Previews on disk. */
  synced: number;
  /** Their bytes, as downloaded. */
  bytes: number;
  /** Named by the replica and not fetched yet. */
  pending: number;
}

export async function measurePreviews(db: AbstractPowerSyncDatabase): Promise<PreviewStoreStatus> {
  const row = await db.get<{ synced: number; bytes: number; pending: number }>(
    `SELECT count(*) FILTER (WHERE state = ${AttachmentState.SYNCED}) AS synced,
            coalesce(sum(size) FILTER (WHERE state = ${AttachmentState.SYNCED}), 0) AS bytes,
            count(*) FILTER (WHERE state < ${AttachmentState.SYNCED}) AS pending
       FROM attachments`,
  );

  return { synced: row?.synced ?? 0, bytes: row?.bytes ?? 0, pending: row?.pending ?? 0 };
}

/** The on-disk files for a page of preview ids, as `<img>` URLs; ids with no file yet are absent. */
export async function previewSources(
  db: AbstractPowerSyncDatabase,
  fileIds: readonly string[],
): Promise<Map<string, string>> {
  const sources = new Map<string, string>();

  if (fileIds.length === 0) {
    return sources;
  }

  const rows = await db.getAll<{ id: string; local_uri: string }>(
    `SELECT id, local_uri FROM attachments WHERE state = ${AttachmentState.SYNCED} AND local_uri IS NOT NULL AND id IN (${fileIds.map(() => '?').join(', ')})`,
    [...fileIds],
  );

  for (const row of rows) {
    sources.set(row.id, await previewSrc(row.local_uri));
  }

  return sources;
}

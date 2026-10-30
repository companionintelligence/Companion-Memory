import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';
import { DropboxClient, GoogleClient, type Connection } from '@ci/domains/connections';
import {
  ImportRunService,
  listRemoteZipEntries,
  recognizeArchiveListing,
  sanitizeFilename,
  StagedSourceService,
  uploadsRoot,
} from '@ci/domains/import';

import { CloudFileIngestLedgerService } from './CloudFileIngestLedgerService';

/** Ledger `provider` values; see CloudFileIngestEntity's docstring. */
export const GOOGLE_DRIVE_PROVIDER = 'google_drive';
export const DROPBOX_PROVIDER = 'dropbox';

/**
 * Attempts per sync tick before a file is logged as failed rather than
 * retried further this tick. Deliberately small and unconfigurable — real
 * backoff/rate-limiting is out of scope for this pass (see the audit this
 * service implements); this is just enough to not treat one dropped
 * connection as a permanent failure. A 'failed' ledger row still gets picked
 * back up on the NEXT sync tick regardless, which is the retry that matters
 * for a background sync more than an in-request loop does.
 */
export const MAX_DOWNLOAD_ATTEMPTS = 2;

/** Photos and videos of one sync page fetched at once. */
const MEDIA_DOWNLOAD_CONCURRENCY = 4;

export interface DriveDocumentToIngest {
  /** Drive's own file id — what the download and export endpoints key on. */
  id: string;
  name: string;
  mimeType: string;
  /**
   * Drive's `modifiedTime`, already requested by SyncDrive.ts's `fields`
   * list. Used as the ledger's revision signal; a file with no
   * `modifiedTime` cannot be skip-checked and is downloaded every tick.
   */
  modifiedTime?: string | null;
}

/**
 * A Dropbox file. `rev` is Dropbox's own revision id — it changes whenever the
 * content does, which is exactly the ledger's skip signal.
 */
export interface DropboxDocumentToIngest {
  /** Dropbox's stable file id (`id:…`), which the download endpoint accepts as a path. */
  id: string;
  name: string;
  mimeType: string;
  rev?: string | null;
}

export interface DropboxArchiveToIngest extends DropboxDocumentToIngest {
  size: number | null;
}

/** A cloud file as the provider-neutral ingest sees it. */
interface CloudFileToIngest {
  id: string;
  name: string;
  mimeType: string;
  /** The provider's change signal; without one the file cannot be skip-checked. */
  revision?: string | null;
}

/**
 * The one provider-specific piece of an ingest: how to fetch this file's
 * bytes, whole or as a byte range (which must answer 206).
 */
interface CloudFileSource {
  /** Ledger `provider` value. */
  provider: string;
  /** For log lines and error messages: "Drive", "Dropbox". */
  label: string;
  fetch(range?: { offset: number; length: number }): Promise<Response>;
}

export interface DriveArchiveToIngest extends DriveDocumentToIngest {
  /** Byte size from the Drive listing; the listing check cannot run without it. */
  size: number | null;
}

export type CloudArchiveIngestOutcome =
  | { outcome: 'downloaded'; dropId: string; importRunId: string; byteSize: number; importers: string[] }
  | { outcome: 'skipped_unchanged'; revision: string }
  /** No importer recognises it (or it could not be checked): leave it as an ordinary cloud file. */
  | { outcome: 'not_an_export' }
  | { outcome: 'failed'; reason: string; attempts: number };

/** One photo or video of a sync page, to be downloaded with the rest of that page's media. */
export interface CloudMediaFile {
  id: string;
  name: string;
  mimeType: string;
  /** The provider's change signal (Drive `modifiedTime`, Dropbox `rev`). */
  revision?: string | null;
  size: number | null;
  /**
   * Where to put the file inside the batch, POSIX, no leading slash. Must be
   * unique within the batch — two photos named IMG_0001.jpg in different
   * folders are different photos.
   */
  relativePath: string;
}

export interface CloudMediaBatchOutcome {
  /** Ids fetched and handed to the import run. */
  downloaded: string[];
  /** Ids the ledger already has at this revision. */
  unchanged: string[];
  failed: Array<{ id: string; reason: string }>;
  byteSize: number;
  /** The one run started for everything in `downloaded`; absent when that is empty. */
  importRunId?: string;
}

export type CloudFileIngestOutcome =
  | { outcome: 'downloaded'; dropId: string; importRunId: string; byteSize: number }
  | { outcome: 'skipped_unchanged'; revision: string }
  | { outcome: 'failed'; reason: string; attempts: number };

/**
 * Downloads a cloud file's actual bytes and hands them to the EXISTING
 * import pipeline, instead of the pointer-only `ci.files` row / placeholder
 * `ci.content` text GoogleDriveTransformService wrote before this. This is
 * the "hand bytes to the existing pipeline" precedent from ImportPathTool.ts,
 * reused rather than reinvented: stage a copy under `uploadsRoot()`,
 * `registerUpload()` it, `startRun()` it, and let unpack → parse → push do
 * what it already does for an uploaded file.
 *
 * Named generically (not `DriveFileIngestService`) because every piece below
 * — the retry loop, the staging call, the ledger row shape — is provider-
 * agnostic; only the HTTP call that fetches the bytes differs per provider
 * (see CloudFileSource). Drive and Dropbox are the two thin entry points; a
 * OneDrive equivalent adds a third rather than a parallel service.
 *
 * Scope this pass deliberately does NOT cover (see the audit's notDone):
 * native Google Docs/Sheets/Slides (`/export?mimeType=` needs an export-mime
 * mapping table that does not exist yet — GoogleDriveTransformService keeps
 * today's placeholder behavior for those three types and never calls this),
 * concurrency limits across many files in one sync, and real backoff.
 */
@Injectable()
export class CloudFileIngestService {
  constructor(
    private readonly googleClient: GoogleClient,
    private readonly dropboxClient: DropboxClient,
    private readonly stagedSources: StagedSourceService,
    private readonly importRuns: ImportRunService,
    private readonly ledger: CloudFileIngestLedgerService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(CloudFileIngestService.name);
  }

  /**
   * Download one Drive file's content via `alt=media` and start an import
   * run for it — or skip if the ledger already has this exact revision.
   *
   * Callers must already have excluded native Google Docs/Sheets/Slides
   * (`application/vnd.google-apps.{document,spreadsheet,presentation,form,
   * drawing}`): `alt=media` 403s on those — they need `/export?mimeType=`,
   * which this pass does not implement.
   */
  async ingestDriveDocument({
    connection,
    userId,
    file,
  }: {
    connection: Connection;
    userId: string;
    file: DriveDocumentToIngest;
  }): Promise<CloudFileIngestOutcome> {
    return this.ingestDocument(this.driveSource(connection, file.id), {
      connection,
      userId,
      file: { ...file, revision: file.modifiedTime },
    });
  }

  /** {@link ingestDriveDocument} for a Dropbox file. */
  async ingestDropboxDocument({
    connection,
    userId,
    file,
  }: {
    connection: Connection;
    userId: string;
    file: DropboxDocumentToIngest;
  }): Promise<CloudFileIngestOutcome> {
    return this.ingestDocument(this.dropboxSource(connection, file.id), {
      connection,
      userId,
      file: { ...file, revision: file.rev },
    });
  }

  /** {@link ingestDriveArchive} for a Dropbox file. */
  async ingestDropboxArchive({
    connection,
    userId,
    file,
  }: {
    connection: Connection;
    userId: string;
    file: DropboxArchiveToIngest;
  }): Promise<CloudArchiveIngestOutcome> {
    return this.ingestArchive(this.dropboxSource(connection, file.id), {
      connection,
      userId,
      file: { ...file, revision: file.rev },
    });
  }

  /**
   * Download a sync page's photos and videos from Drive and import them as
   * real media — bytes stored here, EXIF read, thumbnails and descriptions
   * made — instead of leaving each as a name and a link.
   */
  async ingestDriveMedia(input: {
    connection: Connection;
    userId: string;
    files: CloudMediaFile[];
  }): Promise<CloudMediaBatchOutcome> {
    return this.ingestMediaBatch(
      (fileId) => this.driveSource(input.connection, fileId),
      'Google Drive',
      input,
    );
  }

  /** {@link ingestDriveMedia} for Dropbox. */
  async ingestDropboxMedia(input: {
    connection: Connection;
    userId: string;
    files: CloudMediaFile[];
  }): Promise<CloudMediaBatchOutcome> {
    return this.ingestMediaBatch((fileId) => this.dropboxSource(input.connection, fileId), 'Dropbox', input);
  }

  /**
   * One import run for a whole page of media, not one per file: a drive
   * holds thousands of photos, and a run each would bury the run list and
   * queue four pipeline stages per photo. The files are streamed into one
   * drop folder and imported together, exactly as if that folder had been
   * dropped on the import page.
   *
   * Each file is still its own ledger entry, so an unchanged photo is skipped
   * on a later sync and a failed one is retried the next time it is listed. A
   * file that fails does not hold back the rest of its page.
   */
  private async ingestMediaBatch(
    sourceFor: (fileId: string) => CloudFileSource,
    label: string,
    { connection, userId, files }: { connection: Connection; userId: string; files: CloudMediaFile[] },
  ): Promise<CloudMediaBatchOutcome> {
    const outcome: CloudMediaBatchOutcome = { downloaded: [], unchanged: [], failed: [], byteSize: 0 };

    if (files.length === 0) {
      return outcome;
    }

    const provider = sourceFor(files[0].id).provider;
    const keyFor = (file: CloudMediaFile) => ({
      connectionId: connection.id,
      provider,
      externalFileId: file.id,
    });
    const pending: CloudMediaFile[] = [];

    for (const file of files) {
      const current = file.revision ? await this.ledger.findCurrent({ userId }, keyFor(file)) : null;

      if (current && current.status === 'downloaded' && current.revision === file.revision) {
        outcome.unchanged.push(file.id);
      } else {
        pending.push(file);
      }
    }

    if (pending.length === 0) {
      return outcome;
    }

    const dropId = uuidv7();
    const dropDir = path.join(uploadsRoot(), dropId);
    const folderName = sanitizeFilename(label);
    const batchDir = path.join(dropDir, folderName);
    const fetched: Array<{
      file: CloudMediaFile;
      byteSize: number;
      contentSha256: string;
      attempts: number;
    }> = [];
    const queue = [...pending];

    const worker = async (): Promise<void> => {
      for (let file = queue.shift(); file; file = queue.shift()) {
        const source = sourceFor(file.id);
        let lastError = 'Unknown error';
        let done = false;

        for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS && !done; attempt++) {
          try {
            const result = await this.streamToFile(source, batchDir, file);

            fetched.push({ file, ...result, attempts: attempt });
            done = true;
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
          }
        }

        if (!done) {
          outcome.failed.push({ id: file.id, reason: lastError });
          await this.ledger.recordFailure(
            { userId },
            {
              ...keyFor(file),
              revision: file.revision ?? 'unknown',
              attemptCount: MAX_DOWNLOAD_ATTEMPTS,
              lastError,
            },
          );
        }
      }
    };

    await mkdir(batchDir, { recursive: true });
    await Promise.all(Array.from({ length: MEDIA_DOWNLOAD_CONCURRENCY }, worker));

    if (fetched.length === 0) {
      await rm(dropDir, { recursive: true, force: true }).catch(() => undefined);

      return outcome;
    }

    const byteSize = fetched.reduce((sum, entry) => sum + entry.byteSize, 0);

    try {
      await this.stagedSources.registerUpload(
        { userId },
        {
          dropId,
          sourcePath: batchDir,
          originalFilename: folderName,
          contentType: 'application/x-directory',
          sizeBytes: byteSize,
          kind: 'directory',
        },
      );

      const { run } = await this.importRuns.startRun(
        { userId },
        {
          dropId,
          label: `${label} photos and videos (${fetched.length})`,
          source: 'connections',
          originPlatform: provider,
          originConnectionId: connection.id,
        },
      );

      for (const entry of fetched) {
        await this.ledger.recordSuccess(
          { userId },
          {
            ...keyFor(entry.file),
            revision: entry.file.revision ?? 'unknown',
            contentSha256: entry.contentSha256,
            byteSize: entry.byteSize,
            dropId,
            importRunId: run.id,
            attemptCount: entry.attempts,
          },
        );
        outcome.downloaded.push(entry.file.id);
      }

      outcome.byteSize = byteSize;
      outcome.importRunId = run.id;

      this.logger.log(`Downloaded ${label} media and started an import run for it`, {
        connectionId: connection.id,
        files: fetched.length,
        failed: outcome.failed.length,
        unchanged: outcome.unchanged.length,
        byteSize,
        dropId,
        runId: run.id,
      });
    } catch (error) {
      // The bytes arrived but could not be handed over. Nothing was imported,
      // so every file is a failure the next listing retries.
      const reason = error instanceof Error ? error.message : String(error);

      await rm(dropDir, { recursive: true, force: true }).catch(() => undefined);

      for (const entry of fetched) {
        outcome.failed.push({ id: entry.file.id, reason });
        await this.ledger
          .recordFailure(
            { userId },
            {
              ...keyFor(entry.file),
              revision: entry.file.revision ?? 'unknown',
              attemptCount: entry.attempts,
              lastError: reason,
            },
          )
          .catch(() => undefined);
      }

      this.logger.warn(`Could not start an import run for downloaded ${label} media`, {
        connectionId: connection.id,
        error: reason,
      });
    }

    return outcome;
  }

  /** Stream one file to `dir/<relativePath>`, hashing as it goes. Throws on any shortfall. */
  private async streamToFile(
    source: CloudFileSource,
    dir: string,
    file: CloudMediaFile,
  ): Promise<{ byteSize: number; contentSha256: string }> {
    // Names are kept exactly as the provider has them — "2012-07-15 14.50.57.jpg"
    // is the photo's name, and rewriting it would both mislabel the import and
    // let two differently-named photos land on one file. Safety comes from
    // refusing anything that is not a plain name, and from the containment
    // check below, not from rewriting.
    const parts = file.relativePath.split('/').filter((part) => part.length > 0);

    if (parts.length === 0 || parts.some((part) => part === '.' || part === '..' || /[\\\0]/.test(part))) {
      throw new Error(`refusing an unsafe path: ${file.relativePath}`);
    }

    const target = path.resolve(dir, ...parts);

    if (!target.startsWith(dir + path.sep)) {
      throw new Error(`refusing to write outside the batch folder: ${file.relativePath}`);
    }

    const response = await source.fetch();

    if (!response.ok || response.body == null) {
      throw new Error(`${source.label} content download failed: ${response.status} ${response.statusText}`);
    }

    const hash = createHash('sha256');
    let byteSize = 0;

    await mkdir(path.dirname(target), { recursive: true });

    try {
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            hash.update(chunk);
            byteSize += chunk.length;
            callback(null, chunk);
          },
        }),
        createWriteStream(target),
      );

      if (file.size != null && byteSize !== file.size) {
        throw new Error(`${source.label} download ended at ${byteSize} of ${file.size} bytes`);
      }
    } catch (error) {
      // A partial file must not be imported as if it were the photo.
      await rm(target, { force: true }).catch(() => undefined);
      throw error;
    }

    return { byteSize, contentSha256: hash.digest('hex') };
  }

  private driveSource(connection: Connection, fileId: string): CloudFileSource {
    const endpoint = `/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;

    return {
      provider: GOOGLE_DRIVE_PROVIDER,
      label: 'Drive',
      fetch: (range) =>
        range
          ? this.googleClient.requestRaw(connection, endpoint, {
              headers: { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` },
            })
          : this.googleClient.requestRaw(connection, endpoint),
    };
  }

  private dropboxSource(connection: Connection, fileId: string): CloudFileSource {
    return {
      provider: DROPBOX_PROVIDER,
      label: 'Dropbox',
      fetch: (range) => this.dropboxClient.download(connection, fileId, range),
    };
  }

  private async ingestDocument(
    source: CloudFileSource,
    {
      connection,
      userId,
      file,
    }: {
      connection: Connection;
      userId: string;
      file: CloudFileToIngest;
    },
  ): Promise<CloudFileIngestOutcome> {
    const key = { connectionId: connection.id, provider: source.provider, externalFileId: file.id };

    // Without a real revision signal we cannot safely claim "unchanged" —
    // Drive always returns modifiedTime for a listed file in practice, but a
    // missing one falls through to "always download" rather than risk
    // silently skipping a file that did change.
    if (file.revision) {
      const current = await this.ledger.findCurrent({ userId }, key);

      if (current && current.status === 'downloaded' && current.revision === file.revision) {
        this.logger.debug(`${source.label} file unchanged since last download; skipping`, {
          fileId: file.id,
          revision: file.revision,
        });

        return { outcome: 'skipped_unchanged', revision: file.revision };
      }
    }

    const revision = file.revision ?? 'unknown';
    let lastError = 'Unknown error';

    for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt++) {
      try {
        const response = await source.fetch();

        if (!response.ok) {
          throw new Error(
            `${source.label} content download failed: ${response.status} ${response.statusText}`,
          );
        }

        const bytes = Buffer.from(await response.arrayBuffer());
        const dropId = uuidv7();
        const dropDir = path.join(uploadsRoot(), dropId);
        const sourcePath = path.join(dropDir, sanitizeFilename(file.name));

        // Same order ImportPathTool uses: bytes on disk BEFORE the registry
        // hears about them, so a crash between the two leaves an orphaned
        // staged copy (the upload TTL sweep's job) rather than a registry row
        // whose bytes were never actually written.
        await mkdir(dropDir, { recursive: true });
        await writeFile(sourcePath, bytes);

        await this.stagedSources.registerUpload(
          { userId },
          {
            dropId,
            sourcePath,
            originalFilename: file.name,
            contentType: file.mimeType,
            sizeBytes: bytes.length,
          },
        );

        const { run } = await this.importRuns.startRun(
          { userId },
          {
            dropId,
            label: file.name,
            source: 'connections',
            originPlatform: source.provider,
            originConnectionId: connection.id,
          },
        );

        const contentSha256 = createHash('sha256').update(bytes).digest('hex');

        await this.ledger.recordSuccess(
          { userId },
          {
            ...key,
            revision,
            contentSha256,
            byteSize: bytes.length,
            dropId,
            importRunId: run.id,
            attemptCount: attempt,
          },
        );

        this.logger.log(`Downloaded a ${source.label} document and started an import run for it`, {
          fileId: file.id,
          dropId,
          runId: run.id,
          byteSize: bytes.length,
          attempt,
        });

        return { outcome: 'downloaded', dropId, importRunId: run.id, byteSize: bytes.length };
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Unknown error';

        this.logger.warn(`${source.label} content download attempt failed`, {
          fileId: file.id,
          attempt,
          maxAttempts: MAX_DOWNLOAD_ATTEMPTS,
          error: lastError,
        });
      }
    }

    // Every attempt failed. Logged above per-attempt and recorded here — the
    // "don't throw, continue processing other files" contract
    // processDriveFile already has for the rest of the file loop — but
    // unlike today's silent catch, this leaves a 'failed' row a person or the
    // next sync tick can actually see and act on.
    await this.ledger.recordFailure(
      { userId },
      { ...key, revision, attemptCount: MAX_DOWNLOAD_ATTEMPTS, lastError },
    );

    return { outcome: 'failed', reason: lastError, attempts: MAX_DOWNLOAD_ATTEMPTS };
  }

  /**
   * A zip in Drive that turns out to be an EXPORT some importer reads (a
   * Facebook "Download your information" archive, a Takeout, …) is downloaded
   * and handed to the import pipeline, exactly as if the person had uploaded
   * it. Any other zip is left alone.
   *
   * The decision is made before the download, from the archive's file listing
   * (a few small ranged reads of its tail — see listRemoteZipEntries) run past
   * the importers' own recognisers (recognizeArchiveListing). Only a zip a
   * specific importer claims is fetched in full, streamed to disk rather than
   * buffered: these run to several gigabytes each.
   *
   * One zip, one run, for now. A multi-part export (Facebook splits media
   * across several zips) therefore imports each part on its own, and a part
   * holding only media has nothing to attach it to — grouping the parts of one
   * export into one run is the next piece, and waits on seeing what Meta
   * actually writes to Drive.
   */
  async ingestDriveArchive({
    connection,
    userId,
    file,
  }: {
    connection: Connection;
    userId: string;
    file: DriveArchiveToIngest;
  }): Promise<CloudArchiveIngestOutcome> {
    return this.ingestArchive(this.driveSource(connection, file.id), {
      connection,
      userId,
      file: { ...file, revision: file.modifiedTime },
    });
  }

  private async ingestArchive(
    source: CloudFileSource,
    {
      connection,
      userId,
      file,
    }: {
      connection: Connection;
      userId: string;
      file: CloudFileToIngest & { size: number | null };
    },
  ): Promise<CloudArchiveIngestOutcome> {
    const key = { connectionId: connection.id, provider: source.provider, externalFileId: file.id };

    if (file.revision) {
      const current = await this.ledger.findCurrent({ userId }, key);

      if (current && current.revision === file.revision) {
        if (current.status === 'downloaded') {
          return { outcome: 'skipped_unchanged', revision: file.revision };
        }

        if (current.status === 'not_export') {
          return { outcome: 'not_an_export' };
        }
      }
    }

    const revision = file.revision ?? 'unknown';

    if (file.size == null || !Number.isSafeInteger(file.size) || file.size <= 0) {
      // Nothing to range over. Not recorded: a listing that gains a size later
      // should be checked then.
      return { outcome: 'not_an_export' };
    }

    let importers: string[];
    try {
      const entries = await listRemoteZipEntries(file.size, async (offset, length) => {
        const response = await source.fetch({ offset, length });

        if (response.status !== 206) {
          throw new Error(`${source.label} range read failed: ${response.status} ${response.statusText}`);
        }

        const bytes = Buffer.from(await response.arrayBuffer());

        if (bytes.length !== length) {
          throw new Error(`${source.label} range read returned ${bytes.length} bytes, expected ${length}`);
        }

        return bytes;
      });

      importers = entries ? await recognizeArchiveListing(entries) : [];
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown error';

      this.logger.warn(`Could not read a ${source.label} archive listing`, {
        fileId: file.id,
        error: reason,
      });
      await this.ledger.recordFailure({ userId }, { ...key, revision, attemptCount: 1, lastError: reason });

      return { outcome: 'failed', reason, attempts: 1 };
    }

    if (importers.length === 0) {
      await this.ledger.recordNotExport({ userId }, { ...key, revision });

      return { outcome: 'not_an_export' };
    }

    let lastError = 'Unknown error';

    for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt++) {
      const dropId = uuidv7();
      const dropDir = path.join(uploadsRoot(), dropId);
      const sourcePath = path.join(dropDir, sanitizeFilename(file.name));

      try {
        const response = await source.fetch();

        if (!response.ok || response.body == null) {
          throw new Error(
            `${source.label} content download failed: ${response.status} ${response.statusText}`,
          );
        }

        const hash = createHash('sha256');
        let byteSize = 0;

        await mkdir(dropDir, { recursive: true });
        await pipeline(
          Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
          new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              hash.update(chunk);
              byteSize += chunk.length;
              callback(null, chunk);
            },
          }),
          createWriteStream(sourcePath),
        );

        if (byteSize !== file.size) {
          throw new Error(`${source.label} download ended at ${byteSize} of ${file.size} bytes`);
        }

        await this.stagedSources.registerUpload(
          { userId },
          {
            dropId,
            sourcePath,
            originalFilename: file.name,
            contentType: file.mimeType,
            sizeBytes: byteSize,
          },
        );

        // The importers that claimed the listing are this run's declared
        // intent — what a wizard card or an inbox service folder would have
        // said — so the run is credited to Facebook, not to "a Drive file".
        const { run } = await this.importRuns.startRun(
          { userId },
          {
            dropId,
            label: file.name,
            source: 'connections',
            declaredSources: importers,
            originPlatform: source.provider,
            originConnectionId: connection.id,
          },
        );

        await this.ledger.recordSuccess(
          { userId },
          {
            ...key,
            revision,
            contentSha256: hash.digest('hex'),
            byteSize,
            dropId,
            importRunId: run.id,
            attemptCount: attempt,
          },
        );

        this.logger.log(`Downloaded a ${source.label} export archive and started an import run for it`, {
          fileId: file.id,
          dropId,
          runId: run.id,
          byteSize,
          importers,
          attempt,
        });

        return { outcome: 'downloaded', dropId, importRunId: run.id, byteSize, importers };
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Unknown error';

        // A partial multi-gigabyte file must not sit in uploads until the TTL
        // sweep; the retry writes to a fresh drop.
        await rm(dropDir, { recursive: true, force: true }).catch(() => undefined);

        this.logger.warn(`${source.label} archive download attempt failed`, {
          fileId: file.id,
          attempt,
          maxAttempts: MAX_DOWNLOAD_ATTEMPTS,
          error: lastError,
        });
      }
    }

    await this.ledger.recordFailure(
      { userId },
      { ...key, revision, attemptCount: MAX_DOWNLOAD_ATTEMPTS, lastError },
    );

    return { outcome: 'failed', reason: lastError, attempts: MAX_DOWNLOAD_ATTEMPTS };
  }
}

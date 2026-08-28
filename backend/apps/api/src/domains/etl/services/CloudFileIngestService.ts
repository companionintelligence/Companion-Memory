import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';
import { GoogleClient, type Connection } from '@ci/domains/connections';
import { ImportRunService, sanitizeFilename, StagedSourceService, uploadsRoot } from '@ci/domains/import';

import { CloudFileIngestLedgerService } from './CloudFileIngestLedgerService';

/** The only provider this pass wires up; see CloudFileIngestEntity's docstring. */
export const GOOGLE_DRIVE_PROVIDER = 'google_drive';

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
 * agnostic; only `ingestDriveDocument`'s HTTP call is Drive-specific. A
 * Dropbox/OneDrive equivalent should be able to add a sibling method here
 * rather than a parallel service.
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
    const key = { connectionId: connection.id, provider: GOOGLE_DRIVE_PROVIDER, externalFileId: file.id };

    // Without a real revision signal we cannot safely claim "unchanged" —
    // Drive always returns modifiedTime for a listed file in practice, but a
    // missing one falls through to "always download" rather than risk
    // silently skipping a file that did change.
    if (file.modifiedTime) {
      const current = await this.ledger.findCurrent({ userId }, key);

      if (current && current.status === 'downloaded' && current.revision === file.modifiedTime) {
        this.logger.debug('Drive file unchanged since last download; skipping', {
          fileId: file.id,
          revision: file.modifiedTime,
        });

        return { outcome: 'skipped_unchanged', revision: file.modifiedTime };
      }
    }

    const revision = file.modifiedTime ?? 'unknown';
    const endpoint = `/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`;
    let lastError = 'Unknown error';

    for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt++) {
      try {
        const response = await this.googleClient.requestRaw(connection, endpoint);

        if (!response.ok) {
          throw new Error(`Drive content download failed: ${response.status} ${response.statusText}`);
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
          { dropId, label: file.name, source: 'connections' },
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

        this.logger.log('Downloaded a Drive document and started an import run for it', {
          fileId: file.id,
          dropId,
          runId: run.id,
          byteSize: bytes.length,
          attempt,
        });

        return { outcome: 'downloaded', dropId, importRunId: run.id, byteSize: bytes.length };
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Unknown error';

        this.logger.warn('Drive content download attempt failed', {
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
}

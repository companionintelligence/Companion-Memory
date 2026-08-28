import { GoogleDriveTransformService } from '../TransformGoogleDrive';

/**
 * Every constructor dependency mocked, matching the convention used
 * elsewhere for transform services (see TransformGoogleCalendar.test.ts).
 * `transformGoogleDrive` is the real public entry point — unlike the
 * calendar test, nothing private needs to be reached here — so these tests
 * drive it directly with a single-file sync-job payload, the shape
 * SyncOrchestrator's `serviceFunction({ syncJob, connection })` call
 * actually produces.
 *
 * The point of this file: prove the DOCUMENT branch now calls
 * CloudFileIngestService instead of writing the
 * `Google Drive document: ${fileName}` placeholder — for a downloadable type
 * (PDF). If TransformGoogleDrive.ts is reverted to its pre-fix body, every
 * test below that asserts `cloudFileIngestService.ingestDriveDocument` was
 * called (and `contentService.create` was NOT, with the placeholder text)
 * fails, because the reverted code calls neither: it always builds the
 * placeholder to `contentService.create` and never touches
 * cloudFileIngestService at all.
 */

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
}

function build() {
  const contentService = {
    create: jest.fn(async (_ctx: unknown, _input: Record<string, unknown>) => ({ id: 'content-1' })),
  };
  const fileService = {
    create: jest.fn(async (_ctx: unknown, _input: Record<string, unknown>) => ({ id: 'file-1' })),
  };
  const cloudFileIngestService = { ingestDriveDocument: jest.fn() };

  const service = new GoogleDriveTransformService(
    contentService as never,
    fileService as never,
    {} as never, // ConnectionService — unused by processDriveFile
    cloudFileIngestService as never,
    makeLogger() as never,
  );

  return { service, contentService, fileService, cloudFileIngestService };
}

const connection = { id: 'conn-1', accessToken: 'token' } as never;

function syncJobWithFile(file: Record<string, unknown>) {
  return {
    id: 'job-1',
    userId: 'user-1',
    connectionId: 'conn-1',
    data: { files: [file] },
  } as never;
}

describe('GoogleDriveTransformService.transformGoogleDrive — document branch', () => {
  it('routes a downloadable document (PDF) through CloudFileIngestService, not the placeholder', async () => {
    const { service, contentService, fileService, cloudFileIngestService } = build();

    cloudFileIngestService.ingestDriveDocument.mockResolvedValue({
      outcome: 'downloaded',
      dropId: 'drop-1',
      importRunId: 'run-1',
      byteSize: 1234,
    });

    await service.transformGoogleDrive({
      connection,
      syncJob: syncJobWithFile({
        id: 'drive-1',
        name: 'report.pdf',
        mimeType: 'application/pdf',
        modifiedTime: '2026-08-01T00:00:00Z',
        webViewLink: 'https://drive.google.com/file/d/drive-1/view',
      }),
    });

    expect(cloudFileIngestService.ingestDriveDocument).toHaveBeenCalledWith({
      connection,
      userId: 'user-1',
      file: {
        id: 'drive-1',
        name: 'report.pdf',
        mimeType: 'application/pdf',
        modifiedTime: '2026-08-01T00:00:00Z',
      },
    });

    // No pointer row and no placeholder content — the import pipeline the
    // download handed off to owns creating the real ci.files/ci.content rows.
    expect(fileService.create).not.toHaveBeenCalled();
    expect(contentService.create).not.toHaveBeenCalled();
  });

  it('never writes the "Google Drive document: <name>" placeholder for a successful download', async () => {
    const { service, contentService, cloudFileIngestService } = build();

    cloudFileIngestService.ingestDriveDocument.mockResolvedValue({
      outcome: 'downloaded',
      dropId: 'drop-1',
      importRunId: 'run-1',
      byteSize: 1234,
    });

    await service.transformGoogleDrive({
      connection,
      syncJob: syncJobWithFile({
        id: 'drive-1',
        name: 'report.pdf',
        mimeType: 'application/pdf',
        modifiedTime: '2026-08-01T00:00:00Z',
      }),
    });

    const placeholderCalls = contentService.create.mock.calls.filter((call) => {
      const input = call[1] as { text?: string } | undefined;

      return typeof input?.text === 'string' && input.text.startsWith('Google Drive document:');
    });

    expect(placeholderCalls).toHaveLength(0);
  });

  it('skips re-work for a document CloudFileIngestService reports unchanged, without writing a placeholder', async () => {
    const { service, contentService, fileService, cloudFileIngestService } = build();

    cloudFileIngestService.ingestDriveDocument.mockResolvedValue({
      outcome: 'skipped_unchanged',
      revision: '2026-08-01T00:00:00Z',
    });

    await service.transformGoogleDrive({
      connection,
      syncJob: syncJobWithFile({
        id: 'drive-1',
        name: 'report.pdf',
        mimeType: 'application/pdf',
        modifiedTime: '2026-08-01T00:00:00Z',
      }),
    });

    expect(fileService.create).not.toHaveBeenCalled();
    expect(contentService.create).not.toHaveBeenCalled();
  });

  it('falls back to the pointer + placeholder when the download fails, but still retried first', async () => {
    const { service, contentService, fileService, cloudFileIngestService } = build();

    cloudFileIngestService.ingestDriveDocument.mockResolvedValue({
      outcome: 'failed',
      reason: 'Drive content download failed: 500 Internal Server Error',
      attempts: 2,
    });

    await service.transformGoogleDrive({
      connection,
      syncJob: syncJobWithFile({
        id: 'drive-1',
        name: 'report.pdf',
        mimeType: 'application/pdf',
        modifiedTime: '2026-08-01T00:00:00Z',
        webViewLink: 'https://drive.google.com/file/d/drive-1/view',
      }),
    });

    // The download was actually attempted (and, inside CloudFileIngestService,
    // retried) before this fallback — this branch only runs on 'failed'.
    expect(cloudFileIngestService.ingestDriveDocument).toHaveBeenCalled();

    expect(fileService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ externalId: 'https://drive.google.com/file/d/drive-1/view' }),
    );
    expect(contentService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ text: 'Google Drive document: report.pdf' }),
    );
  });

  it('keeps the pointer + placeholder path for native Google types (Docs) — no export mapping yet', async () => {
    const { service, contentService, fileService, cloudFileIngestService } = build();

    await service.transformGoogleDrive({
      connection,
      syncJob: syncJobWithFile({
        id: 'drive-2',
        name: 'Meeting Notes',
        mimeType: 'application/vnd.google-apps.document',
        modifiedTime: '2026-08-01T00:00:00Z',
        webViewLink: 'https://docs.google.com/document/d/drive-2/edit',
      }),
    });

    // alt=media 403s on native Google types — this pass never attempts it.
    expect(cloudFileIngestService.ingestDriveDocument).not.toHaveBeenCalled();

    expect(fileService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ externalId: 'https://docs.google.com/document/d/drive-2/edit' }),
    );
    expect(contentService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ text: 'Google Drive document: Meeting Notes' }),
    );
  });

  it('keeps the pointer-only path for non-document types (images/video)', async () => {
    const { service, contentService, fileService, cloudFileIngestService } = build();

    await service.transformGoogleDrive({
      connection,
      syncJob: syncJobWithFile({
        id: 'drive-3',
        name: 'photo.jpg',
        mimeType: 'image/jpeg',
        webViewLink: 'https://drive.google.com/file/d/drive-3/view',
      }),
    });

    expect(cloudFileIngestService.ingestDriveDocument).not.toHaveBeenCalled();
    expect(fileService.create).toHaveBeenCalledTimes(1);
    expect(contentService.create).not.toHaveBeenCalled();
  });

  it('still skips folders without calling any of the file/content/ingest paths', async () => {
    const { service, contentService, fileService, cloudFileIngestService } = build();

    await service.transformGoogleDrive({
      connection,
      syncJob: syncJobWithFile({
        id: 'drive-4',
        name: 'My Folder',
        mimeType: 'application/vnd.google-apps.folder',
      }),
    });

    expect(fileService.create).not.toHaveBeenCalled();
    expect(contentService.create).not.toHaveBeenCalled();
    expect(cloudFileIngestService.ingestDriveDocument).not.toHaveBeenCalled();
  });
});

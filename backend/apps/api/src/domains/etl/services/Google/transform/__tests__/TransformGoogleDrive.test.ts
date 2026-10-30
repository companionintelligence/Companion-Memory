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
    findBySource: jest.fn(async () => null as { id: string } | null),
  };
  const fileService = {
    create: jest.fn(async (_ctx: unknown, _input: Record<string, unknown>) => ({ id: 'file-1' })),
    removePointersByExternalIds: jest.fn(async (_ctx: unknown, _ids: string[]) => 0),
  };
  const cloudFileIngestService = {
    ingestDriveDocument: jest.fn(),
    ingestDriveArchive: jest.fn(),
    ingestDriveMedia: jest.fn(async ({ files }: { files: Array<{ id: string }> }) => ({
      downloaded: files.map((f) => f.id),
      unchanged: [] as string[],
      failed: [] as Array<{ id: string; reason: string }>,
      byteSize: 0,
    })),
  };

  const cloudFolderIngestService = {
    claimDriveFiles: jest.fn(async (_input: { files: unknown[] }) => new Set<unknown>()),
    ingestSettledDriveFolders: jest.fn(async () => undefined),
  };

  const service = new GoogleDriveTransformService(
    contentService as never,
    fileService as never,
    {} as never, // ConnectionService — unused by processDriveFile
    cloudFileIngestService as never,
    cloudFolderIngestService as never,
    makeLogger() as never,
  );

  return { service, contentService, fileService, cloudFileIngestService, cloudFolderIngestService };
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

  it('keeps the pointer-only path for files that are neither documents nor media', async () => {
    const { service, contentService, fileService, cloudFileIngestService } = build();

    await service.transformGoogleDrive({
      connection,
      syncJob: syncJobWithFile({
        id: 'drive-3',
        name: 'passwords.kdbx',
        mimeType: 'application/octet-stream',
        webViewLink: 'https://drive.google.com/file/d/drive-3/view',
      }),
    });

    expect(cloudFileIngestService.ingestDriveDocument).not.toHaveBeenCalled();
    expect(fileService.create).toHaveBeenCalledTimes(1);
    expect(contentService.create).not.toHaveBeenCalled();
  });

  it('stamps the provenance triple on the placeholder so a re-sync dedupes', async () => {
    const { service, contentService } = build();

    await service.transformGoogleDrive({
      connection,
      syncJob: syncJobWithFile({
        id: 'drive-2',
        name: 'Meeting Notes',
        mimeType: 'application/vnd.google-apps.document',
        webViewLink: 'https://docs.google.com/document/d/drive-2/edit',
      }),
    });

    expect(contentService.findBySource).toHaveBeenCalledWith(
      { userId: 'user-1' },
      { source_type: 'ETL', source_system: 'google_drive', source_id: 'drive-2' },
    );
    expect(contentService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({
        source_type: 'ETL',
        source_system: 'google_drive',
        source_id: 'drive-2',
      }),
    );
  });

  it('skips the placeholder when the triple already resolves to a content row', async () => {
    const { service, contentService, fileService } = build();
    contentService.findBySource.mockResolvedValue({ id: 'content-9' });

    await service.transformGoogleDrive({
      connection,
      syncJob: syncJobWithFile({
        id: 'drive-2',
        name: 'Meeting Notes',
        mimeType: 'application/vnd.google-apps.document',
        webViewLink: 'https://docs.google.com/document/d/drive-2/edit',
      }),
    });

    expect(contentService.create).not.toHaveBeenCalled();
    // The pointer row still goes through FileService, which dedupes internally.
    expect(fileService.create).toHaveBeenCalledTimes(1);
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

describe('GoogleDriveTransformService.transformGoogleDrive — zip archive branch', () => {
  const zipFile = {
    id: 'drive-zip-1',
    name: 'facebook-export.zip',
    mimeType: 'application/zip',
    modifiedTime: '2026-10-01T00:00:00Z',
    size: '2048',
    webViewLink: 'https://drive.google.com/file/d/drive-zip-1/view',
  };

  it('offers a zip to the archive ingest, with its size as a number', async () => {
    const { service, cloudFileIngestService } = build();
    cloudFileIngestService.ingestDriveArchive.mockResolvedValue({ outcome: 'not_an_export' });

    await service.transformGoogleDrive({ connection, syncJob: syncJobWithFile(zipFile) });

    expect(cloudFileIngestService.ingestDriveArchive).toHaveBeenCalledWith({
      connection,
      userId: 'user-1',
      file: {
        id: 'drive-zip-1',
        name: 'facebook-export.zip',
        mimeType: 'application/zip',
        modifiedTime: '2026-10-01T00:00:00Z',
        size: 2048,
      },
    });
    expect(cloudFileIngestService.ingestDriveDocument).not.toHaveBeenCalled();
  });

  it('recognises a zip by name when Drive reports a generic type', async () => {
    const { service, cloudFileIngestService } = build();
    cloudFileIngestService.ingestDriveArchive.mockResolvedValue({ outcome: 'not_an_export' });

    await service.transformGoogleDrive({
      connection,
      syncJob: syncJobWithFile({ ...zipFile, mimeType: 'application/octet-stream' }),
    });

    expect(cloudFileIngestService.ingestDriveArchive).toHaveBeenCalled();
  });

  it.each(['downloaded', 'skipped_unchanged'])(
    'writes no pointer row for an export that was %s',
    async (outcome) => {
      const { service, fileService, cloudFileIngestService } = build();
      cloudFileIngestService.ingestDriveArchive.mockResolvedValue({
        outcome,
        importers: ['facebook'],
        importRunId: 'run-1',
        byteSize: 2048,
      });

      await service.transformGoogleDrive({ connection, syncJob: syncJobWithFile(zipFile) });

      expect(fileService.create).not.toHaveBeenCalled();
    },
  );

  it.each([{ outcome: 'not_an_export' }, { outcome: 'failed', reason: 'x', attempts: 2 }])(
    'keeps the ordinary pointer row when the zip is $outcome',
    async (result) => {
      const { service, fileService, contentService, cloudFileIngestService } = build();
      cloudFileIngestService.ingestDriveArchive.mockResolvedValue(result);

      await service.transformGoogleDrive({ connection, syncJob: syncJobWithFile(zipFile) });

      expect(fileService.create).toHaveBeenCalledWith(
        { userId: 'user-1' },
        expect.objectContaining({ externalId: 'https://drive.google.com/file/d/drive-zip-1/view' }),
      );
      expect(contentService.create).not.toHaveBeenCalled();
    },
  );
});

describe('GoogleDriveTransformService.transformGoogleDrive — photos and videos', () => {
  const photo = {
    id: 'drive-photo-1',
    name: 'IMG_0001.jpg',
    mimeType: 'image/jpeg',
    modifiedTime: '2026-10-01T00:00:00Z',
    size: '2048',
    webViewLink: 'https://drive.google.com/file/d/drive-photo-1/view',
  };
  const video = {
    ...photo,
    id: 'drive-video-1',
    name: 'clip.mp4',
    mimeType: 'video/mp4',
    webViewLink: 'https://drive.google.com/file/d/drive-video-1/view',
  };
  const job = (files: Array<Record<string, unknown>>) =>
    ({ id: 'job-1', userId: 'user-1', connectionId: 'conn-1', data: { files } }) as never;

  it('downloads a page of photos and videos as ONE batch, and writes no pointer rows for them', async () => {
    const { service, fileService, cloudFileIngestService } = build();

    await service.transformGoogleDrive({ connection, syncJob: job([photo, video]) });

    expect(cloudFileIngestService.ingestDriveMedia).toHaveBeenCalledTimes(1);
    expect(cloudFileIngestService.ingestDriveMedia).toHaveBeenCalledWith({
      connection,
      userId: 'user-1',
      files: [
        {
          id: 'drive-photo-1',
          name: 'IMG_0001.jpg',
          mimeType: 'image/jpeg',
          revision: '2026-10-01T00:00:00Z',
          size: 2048,
          // Names repeat in Drive; the id keeps two IMG_0001.jpg apart.
          relativePath: 'drive-photo-1/IMG_0001.jpg',
        },
        expect.objectContaining({ id: 'drive-video-1', relativePath: 'drive-video-1/clip.mp4' }),
      ],
    });
    expect(fileService.create).not.toHaveBeenCalled();
    // Pointer rows an earlier sync wrote for them are cleared.
    expect(fileService.removePointersByExternalIds).toHaveBeenCalledWith({ userId: 'user-1' }, [
      'https://drive.google.com/file/d/drive-photo-1/view',
      'https://drive.google.com/file/d/drive-video-1/view',
    ]);
  });

  it('keeps a pointer row for a photo that could not be downloaded', async () => {
    const { service, fileService, cloudFileIngestService } = build();
    cloudFileIngestService.ingestDriveMedia.mockResolvedValue({
      downloaded: ['drive-video-1'],
      unchanged: [],
      failed: [{ id: 'drive-photo-1', reason: 'Drive content download failed: 500' }],
      byteSize: 2048,
    });

    await service.transformGoogleDrive({ connection, syncJob: job([photo, video]) });

    expect(fileService.create).toHaveBeenCalledTimes(1);
    expect(fileService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ filename: 'IMG_0001.jpg', connectionId: 'conn-1' }),
    );
    expect(fileService.removePointersByExternalIds).toHaveBeenCalledWith({ userId: 'user-1' }, [
      'https://drive.google.com/file/d/drive-video-1/view',
    ]);
  });
});

describe('GoogleDriveTransformService — files inside an export folder', () => {
  const inExport = {
    id: 'fb-photo-1',
    name: '1028555342084726.jpg',
    mimeType: 'image/jpeg',
    parents: ['thread-photos'],
    webViewLink: 'https://drive.google.com/file/d/fb-photo-1/view',
  };
  const exportJson = {
    id: 'fb-json-1',
    name: 'message_1.json',
    mimeType: 'application/json',
    parents: ['thread'],
  };
  const ordinary = {
    id: 'drive-photo-9',
    name: 'beach.jpg',
    mimeType: 'image/jpeg',
    parents: ['holiday'],
    webViewLink: 'https://drive.google.com/file/d/drive-photo-9/view',
  };
  const folderEntry = {
    id: 'thread',
    name: 'Friends_1',
    mimeType: 'application/vnd.google-apps.folder',
    parents: ['inbox'],
  };
  const job = (files: Array<Record<string, unknown>>) =>
    ({ id: 'job-1', userId: 'user-1', connectionId: 'conn-1', data: { files } }) as never;

  it('leaves them to the folder import: no media download, no pointer row', async () => {
    const { service, fileService, cloudFileIngestService, cloudFolderIngestService } = build();
    cloudFolderIngestService.claimDriveFiles.mockImplementation(
      async ({ files }: { files: unknown[] }) =>
        new Set(files.filter((entry) => (entry as { id: string }).id.startsWith('fb-'))),
    );

    await service.transformGoogleDrive({
      connection,
      syncJob: job([inExport, exportJson, ordinary, folderEntry]),
    });

    // Files are offered with the folder each sits in; folder entries ride along as hints.
    expect(cloudFolderIngestService.claimDriveFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [
          expect.objectContaining({ id: 'fb-photo-1', parents: ['thread-photos'] }),
          expect.objectContaining({ id: 'fb-json-1' }),
          expect.objectContaining({ id: 'drive-photo-9' }),
        ],
        folders: [expect.objectContaining({ id: 'thread', name: 'Friends_1', parents: ['inbox'] })],
      }),
    );
    // Only the ordinary photo is handled as an ordinary photo.
    expect(cloudFileIngestService.ingestDriveMedia).toHaveBeenCalledTimes(1);
    expect(cloudFileIngestService.ingestDriveMedia.mock.calls[0][0].files.map((f) => f.id)).toEqual([
      'drive-photo-9',
    ]);
    expect(fileService.create).not.toHaveBeenCalled();
  });

  it('checks for settled export folders even when the listing is empty', async () => {
    const { service, cloudFolderIngestService } = build();

    await service.transformGoogleDrive({ connection, syncJob: job([]) });

    expect(cloudFolderIngestService.ingestSettledDriveFolders).toHaveBeenCalledWith({
      connection,
      userId: 'user-1',
    });
  });
});

import { dropboxWebLink } from '../../dropboxWebLink';
import { DropboxFilesTransformService } from '../TransformDropboxFiles';

function build() {
  const fileService = {
    create: jest.fn(async () => ({ id: 'file-1' })),
    removePointersByExternalIds: jest.fn(async () => 0),
  };
  const cloudFileIngestService = {
    ingestDropboxDocument: jest.fn(),
    ingestDropboxArchive: jest.fn(),
    // By default every photo/video in the page downloads.
    ingestDropboxMedia: jest.fn(async ({ files }: { files: Array<{ id: string }> }) => ({
      downloaded: files.map((f) => f.id),
      unchanged: [] as string[],
      failed: [] as Array<{ id: string; reason: string }>,
      byteSize: 0,
    })),
  };
  // By default no file belongs to an export folder.
  const cloudFolderIngestService = {
    claimDropboxFiles: jest.fn(async (_input: { files: Array<{ path: string }> }) => new Set<unknown>()),
    ingestSettledDropboxFolders: jest.fn(async () => undefined),
  };
  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  };
  const service = new DropboxFilesTransformService(
    fileService as never,
    cloudFileIngestService as never,
    cloudFolderIngestService as never,
    logger as never,
  );

  return { service, fileService, cloudFileIngestService, cloudFolderIngestService };
}

const connection = { id: 'conn-1' } as never;
const job = (file: Record<string, unknown>) =>
  ({ id: 'job-1', userId: 'user-1', connectionId: 'conn-1', data: { files: [file] } }) as never;
const entry = (name: string, extra: Record<string, unknown> = {}) => ({
  '.tag': 'file',
  id: `id:${name}`,
  name,
  path_display: `/Exports/${name}`,
  path_lower: `/exports/${name.toLowerCase()}`,
  rev: 'rev-1',
  size: 2048,
  server_modified: '2026-10-01T00:00:00Z',
  ...extra,
});

describe('dropboxWebLink', () => {
  it('points at the folder view with the file previewed, encoded', () => {
    expect(dropboxWebLink({ path_display: '/My Stuff/tax 2025.pdf', name: 'tax 2025.pdf' })).toBe(
      'https://www.dropbox.com/home/My%20Stuff?preview=tax%202025.pdf',
    );
    expect(dropboxWebLink({ path_display: '/top.zip', name: 'top.zip' })).toBe(
      'https://www.dropbox.com/home?preview=top.zip',
    );
    expect(dropboxWebLink({ name: 'no-path.txt' })).toBeNull();
  });
});

describe('DropboxFilesTransformService', () => {
  it('offers a zip to the archive ingest with its rev and size', async () => {
    const { service, fileService, cloudFileIngestService } = build();
    cloudFileIngestService.ingestDropboxArchive.mockResolvedValue({
      outcome: 'downloaded',
      importers: ['facebook'],
      importRunId: 'run-1',
      byteSize: 2048,
    });

    await service.transform({ connection, syncJob: job(entry('facebook-export.zip')) });

    expect(cloudFileIngestService.ingestDropboxArchive).toHaveBeenCalledWith({
      connection,
      userId: 'user-1',
      file: {
        id: 'id:facebook-export.zip',
        name: 'facebook-export.zip',
        mimeType: 'application/zip',
        rev: 'rev-1',
        size: 2048,
      },
    });
    // The import run owns this file now; no pointer beside it.
    expect(fileService.create).not.toHaveBeenCalled();
  });

  it('keeps a pointer row for a zip that is not an export', async () => {
    const { service, fileService, cloudFileIngestService } = build();
    cloudFileIngestService.ingestDropboxArchive.mockResolvedValue({ outcome: 'not_an_export' });

    await service.transform({ connection, syncJob: job(entry('backup.zip')) });

    expect(fileService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({
        // So disconnecting Dropbox can find and delete the row.
        connectionId: 'conn-1',
        filename: 'backup.zip',
        externalId: 'https://www.dropbox.com/home/Exports?preview=backup.zip',
        size: 2048,
        externalUpdatedAt: new Date('2026-10-01T00:00:00Z'),
      }),
    );
  });

  it('downloads a document, typed from its name, and writes no pointer on success', async () => {
    const { service, fileService, cloudFileIngestService } = build();
    cloudFileIngestService.ingestDropboxDocument.mockResolvedValue({
      outcome: 'downloaded',
      dropId: 'd',
      importRunId: 'r',
      byteSize: 2048,
    });

    await service.transform({ connection, syncJob: job(entry('report.pdf')) });

    expect(cloudFileIngestService.ingestDropboxDocument).toHaveBeenCalledWith({
      connection,
      userId: 'user-1',
      file: { id: 'id:report.pdf', name: 'report.pdf', mimeType: 'application/pdf', rev: 'rev-1' },
    });
    expect(fileService.create).not.toHaveBeenCalled();
  });

  it('falls back to a pointer when a document download fails', async () => {
    const { service, fileService, cloudFileIngestService } = build();
    cloudFileIngestService.ingestDropboxDocument.mockResolvedValue({
      outcome: 'failed',
      reason: 'boom',
      attempts: 2,
    });

    await service.transform({ connection, syncJob: job(entry('report.pdf')) });

    expect(fileService.create).toHaveBeenCalledTimes(1);
  });

  it('gives every other file a pointer row and downloads nothing', async () => {
    const { service, fileService, cloudFileIngestService } = build();

    await service.transform({ connection, syncJob: job(entry('accounts.kdbx')) });

    expect(cloudFileIngestService.ingestDropboxArchive).not.toHaveBeenCalled();
    expect(cloudFileIngestService.ingestDropboxDocument).not.toHaveBeenCalled();
    expect(cloudFileIngestService.ingestDropboxMedia).not.toHaveBeenCalled();
    expect(fileService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ filename: 'accounts.kdbx' }),
    );
  });

  it('downloads a page of photos and videos as ONE batch, keyed by their Dropbox paths', async () => {
    const { service, fileService, cloudFileIngestService } = build();

    await service.transform({
      connection,
      syncJob: {
        id: 'job-1',
        userId: 'user-1',
        connectionId: 'conn-1',
        data: {
          files: [
            entry('a.jpg', { path_display: '/Camera Uploads/a.jpg' }),
            entry('clip.mp4', { path_display: '/Camera Uploads/clip.mp4' }),
          ],
        },
      } as never,
    });

    expect(cloudFileIngestService.ingestDropboxMedia).toHaveBeenCalledTimes(1);
    expect(cloudFileIngestService.ingestDropboxMedia).toHaveBeenCalledWith({
      connection,
      userId: 'user-1',
      files: [
        {
          id: 'id:a.jpg',
          name: 'a.jpg',
          mimeType: 'image/jpeg',
          revision: 'rev-1',
          size: 2048,
          relativePath: 'Camera Uploads/a.jpg',
        },
        expect.objectContaining({ id: 'id:clip.mp4', mimeType: 'video/mp4' }),
      ],
    });
    expect(fileService.create).not.toHaveBeenCalled();
    // The pointer rows an earlier sync wrote for these are cleared.
    expect(fileService.removePointersByExternalIds).toHaveBeenCalledWith({ userId: 'user-1' }, [
      'https://www.dropbox.com/home/Camera%20Uploads?preview=a.jpg',
      'https://www.dropbox.com/home/Camera%20Uploads?preview=clip.mp4',
    ]);
  });

  it('keeps a pointer row for a photo that could not be downloaded', async () => {
    const { service, fileService, cloudFileIngestService } = build();
    cloudFileIngestService.ingestDropboxMedia.mockResolvedValue({
      downloaded: [],
      unchanged: [],
      failed: [{ id: 'id:a.jpg', reason: 'Dropbox content download failed: 500' }],
      byteSize: 0,
    });

    await service.transform({ connection, syncJob: job(entry('a.jpg')) });

    expect(fileService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ filename: 'a.jpg', contentType: 'image/jpeg', connectionId: 'conn-1' }),
    );
  });

  it('one bad file does not stop the rest', async () => {
    const { service, fileService, cloudFileIngestService } = build();
    cloudFileIngestService.ingestDropboxArchive.mockRejectedValue(new Error('boom'));

    await service.transform({
      connection,
      syncJob: {
        id: 'job-1',
        userId: 'user-1',
        connectionId: 'conn-1',
        data: { files: [entry('bad.zip'), entry('accounts.kdbx')] },
      } as never,
    });

    expect(fileService.create).toHaveBeenCalledTimes(1);
  });
});

describe('DropboxFilesTransformService — export folders', () => {
  it('leaves files inside an export folder alone: no pointer rows, no downloads', async () => {
    const { service, fileService, cloudFileIngestService, cloudFolderIngestService } = build();
    cloudFolderIngestService.claimDropboxFiles.mockImplementation(
      async ({ files }: { files: Array<{ path: string }> }) =>
        new Set<unknown>(files.filter((f) => f.path.startsWith('/apps/meta/'))),
    );

    await service.transform({
      connection,
      syncJob: {
        id: 'job-1',
        userId: 'user-1',
        connectionId: 'conn-1',
        data: {
          files: [
            entry('message_1.json', {
              path_lower: '/apps/meta/x/facebook-y/your_facebook_activity/message_1.json',
            }),
            entry('report.pdf', { path_lower: '/apps/meta/x/facebook-y/report.pdf' }),
            entry('accounts.kdbx'),
            entry('holiday.jpg', {
              path_lower: '/apps/meta/x/facebook-y/your_facebook_activity/holiday.jpg',
            }),
          ],
        },
      } as never,
    });

    // Only the ordinary file was handled as a file.
    expect(fileService.create).toHaveBeenCalledTimes(1);
    expect(fileService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ filename: 'accounts.kdbx' }),
    );
    expect(cloudFileIngestService.ingestDropboxDocument).not.toHaveBeenCalled();
    // The export's own photos belong to its import run, not the media batch.
    expect(cloudFileIngestService.ingestDropboxMedia).not.toHaveBeenCalled();
  });

  it('checks for settled folders on every tick, including one that lists nothing', async () => {
    const { service, cloudFolderIngestService } = build();

    await service.transform({
      connection,
      syncJob: { id: 'job-1', userId: 'user-1', connectionId: 'conn-1', data: { files: [] } } as never,
    });

    expect(cloudFolderIngestService.ingestSettledDropboxFolders).toHaveBeenCalledWith({
      connection,
      userId: 'user-1',
    });
  });
});

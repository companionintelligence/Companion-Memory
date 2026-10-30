import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import AdmZip from 'adm-zip';

import config from '@ci/configuration';

import type { CloudFileIngest } from '../../entities/CloudFileIngestEntity';
import {
  CloudFileIngestService,
  DROPBOX_PROVIDER,
  GOOGLE_DRIVE_PROVIDER,
  MAX_DOWNLOAD_ATTEMPTS,
} from '../CloudFileIngestService';

/**
 * Every constructor dependency mocked — GoogleClient (the Drive API),
 * StagedSourceService/ImportRunService (the existing import pipeline's
 * staging contract), and the ledger — matching the convention used elsewhere
 * for services with real DB/network collaborators (see
 * TransformGoogleCalendar.test.ts, ImportPathTool.test.ts). Only the
 * filesystem write is real, into a temp uploads dir, because "a file lands
 * under the uploads dir with real bytes" is exactly what this test needs to
 * prove and a temp dir costs nothing to clean up.
 */

let uploadsDir: string;
let previousUploadsDir: string;

beforeEach(async () => {
  uploadsDir = await mkdtemp(path.join(os.tmpdir(), 'ci-drive-ingest-'));
  previousUploadsDir = config.import.uploadsDir;
  (config.import as { uploadsDir: string }).uploadsDir = uploadsDir;
});

afterEach(() => {
  (config.import as { uploadsDir: string }).uploadsDir = previousUploadsDir;
});

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
}

/**
 * A `Response`-shaped stub good enough for `requestRaw`'s two call sites:
 * `.ok` and `.arrayBuffer()`.
 *
 * `Buffer.from(body, 'utf8').buffer` is NOT this string's bytes alone —
 * Node allocates small buffers out of a shared internal pool, so the
 * `ArrayBuffer` backing a short `Buffer` is the whole (much larger) pool,
 * with `byteOffset`/`byteLength` marking where this string actually sits
 * inside it. Slicing with those bounds (rather than a bare `.slice(0)`) is
 * what makes this behave like a real fetch `Response`, whose `arrayBuffer()`
 * always returns exactly the body's own bytes.
 */
function okResponse(body: string) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    arrayBuffer: async () => {
      const buf = Buffer.from(body, 'utf8');

      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
  };
}

function failResponse(status: number, statusText: string) {
  return { ok: false, status, statusText, arrayBuffer: async () => new ArrayBuffer(0) };
}

function build() {
  const calls: string[] = [];

  const googleClient = { requestRaw: jest.fn() };

  const stagedSources = {
    registerUpload: jest.fn(
      async (_ctx: unknown, input: { dropId: string; sourcePath: string; sizeBytes: number }) => {
        calls.push('registerUpload');

        return { dropId: input.dropId, sourcePath: input.sourcePath };
      },
    ),
  };

  const importRuns = {
    startRun: jest.fn(async (_ctx: unknown, input: { dropId: string; label: string; source: string }) => {
      calls.push('startRun');

      return { run: { id: 'run-1', label: input.label }, stages: [] };
    }),
  };

  const ledger = {
    findCurrent: jest.fn(async (): Promise<CloudFileIngest | null> => null),
    recordSuccess: jest.fn(async () => undefined),
    recordFailure: jest.fn(async () => undefined),
    recordNotExport: jest.fn(async () => undefined),
  };

  const dropboxClient = { download: jest.fn() };

  const service = new CloudFileIngestService(
    googleClient as never,
    dropboxClient as never,
    stagedSources as never,
    importRuns as never,
    ledger as never,
    makeLogger() as never,
  );

  const connection = { id: 'conn-1', accessToken: 'token' } as never;

  return { service, googleClient, dropboxClient, stagedSources, importRuns, ledger, connection, calls };
}

describe('CloudFileIngestService.ingestDriveDocument', () => {
  it('downloads real bytes, stages them under the uploads dir, and starts a real import run', async () => {
    const { service, googleClient, stagedSources, importRuns, ledger, connection, calls } = build();

    googleClient.requestRaw.mockResolvedValue(okResponse('%PDF-1.4 pretend this is a real PDF'));

    const result = await service.ingestDriveDocument({
      connection,
      userId: 'user-1',
      file: {
        id: 'drive-file-1',
        name: 'notes.pdf',
        mimeType: 'application/pdf',
        modifiedTime: '2026-08-01T00:00:00Z',
      },
    });

    expect(result.outcome).toBe('downloaded');
    expect(calls).toEqual(['registerUpload', 'startRun']);

    // The Drive endpoint hit is the content-download endpoint, not a metadata list.
    expect(googleClient.requestRaw).toHaveBeenCalledWith(
      connection,
      '/drive/v3/files/drive-file-1?alt=media',
    );

    // registerUpload/startRun were called with a REAL dropId — not a metadata
    // stand-in — and that same dropId is what a file landed on disk under.
    const registerInput = stagedSources.registerUpload.mock.calls[0][1] as {
      dropId: string;
      sourcePath: string;
    };
    const startRunInput = importRuns.startRun.mock.calls[0][1] as { dropId: string; source: string };

    expect(registerInput.dropId).toBeTruthy();
    expect(startRunInput.dropId).toBe(registerInput.dropId);
    expect(startRunInput.source).toBe('connections');

    // Real bytes landed under <uploadsDir>/<dropId>/, not the placeholder string.
    const [dropDir] = await readdir(uploadsDir);
    expect(dropDir).toBe(registerInput.dropId);

    const [staged] = await readdir(path.join(uploadsDir, dropDir));
    const contents = await readFile(path.join(uploadsDir, dropDir, staged), 'utf8');

    expect(contents).toBe('%PDF-1.4 pretend this is a real PDF');
    expect(contents).not.toContain('Google Drive document:');

    // The ledger recorded the success against the file's own revision.
    expect(ledger.recordSuccess).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({
        connectionId: 'conn-1',
        provider: GOOGLE_DRIVE_PROVIDER,
        externalFileId: 'drive-file-1',
        revision: '2026-08-01T00:00:00Z',
        dropId: registerInput.dropId,
        importRunId: 'run-1',
      }),
    );
  });

  it('skips a file whose revision matches the ledger — no download, no new run', async () => {
    const { service, googleClient, stagedSources, importRuns, ledger, connection } = build();

    ledger.findCurrent.mockResolvedValue({
      id: 'ledger-1',
      userId: 'user-1',
      connectionId: 'conn-1',
      provider: GOOGLE_DRIVE_PROVIDER,
      externalFileId: 'drive-file-1',
      revision: '2026-08-01T00:00:00Z',
      contentSha256: 'deadbeef',
      byteSize: 42,
      status: 'downloaded',
      dropId: 'old-drop',
      importRunId: 'old-run',
      attemptCount: 1,
      lastError: null,
      downloadedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.ingestDriveDocument({
      connection,
      userId: 'user-1',
      file: {
        id: 'drive-file-1',
        name: 'notes.pdf',
        mimeType: 'application/pdf',
        modifiedTime: '2026-08-01T00:00:00Z',
      },
    });

    expect(result).toEqual({ outcome: 'skipped_unchanged', revision: '2026-08-01T00:00:00Z' });
    expect(googleClient.requestRaw).not.toHaveBeenCalled();
    expect(stagedSources.registerUpload).not.toHaveBeenCalled();
    expect(importRuns.startRun).not.toHaveBeenCalled();
  });

  it('re-downloads when the revision changed, even though a ledger row already exists', async () => {
    const { service, googleClient, ledger, connection } = build();

    ledger.findCurrent.mockResolvedValue({
      id: 'ledger-1',
      userId: 'user-1',
      connectionId: 'conn-1',
      provider: GOOGLE_DRIVE_PROVIDER,
      externalFileId: 'drive-file-1',
      revision: '2026-08-01T00:00:00Z', // stale — the file changed since
      contentSha256: 'deadbeef',
      byteSize: 42,
      status: 'downloaded',
      dropId: 'old-drop',
      importRunId: 'old-run',
      attemptCount: 1,
      lastError: null,
      downloadedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    googleClient.requestRaw.mockResolvedValue(okResponse('new bytes'));

    const result = await service.ingestDriveDocument({
      connection,
      userId: 'user-1',
      file: {
        id: 'drive-file-1',
        name: 'notes.pdf',
        mimeType: 'application/pdf',
        modifiedTime: '2026-08-15T00:00:00Z', // newer than the ledger row
      },
    });

    expect(result.outcome).toBe('downloaded');
    expect(googleClient.requestRaw).toHaveBeenCalled();
  });

  it('retries a failing download before giving up, and records — not silently drops — the failure', async () => {
    const { service, googleClient, stagedSources, importRuns, ledger, connection } = build();

    googleClient.requestRaw.mockResolvedValue(failResponse(500, 'Internal Server Error'));

    const result = await service.ingestDriveDocument({
      connection,
      userId: 'user-1',
      file: {
        id: 'drive-file-2',
        name: 'broken.pdf',
        mimeType: 'application/pdf',
        modifiedTime: '2026-08-01T00:00:00Z',
      },
    });

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.reason).toContain('500');
      expect(result.attempts).toBe(MAX_DOWNLOAD_ATTEMPTS);
    }

    // It actually retried — more than one attempt — not a single silent fall-through.
    expect(googleClient.requestRaw).toHaveBeenCalledTimes(MAX_DOWNLOAD_ATTEMPTS);

    // Nothing was staged or run for bytes that never arrived.
    expect(stagedSources.registerUpload).not.toHaveBeenCalled();
    expect(importRuns.startRun).not.toHaveBeenCalled();

    // The failure is LOGGED and RECORDED, not silently dropped.
    expect(ledger.recordFailure).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({
        connectionId: 'conn-1',
        externalFileId: 'drive-file-2',
        attemptCount: MAX_DOWNLOAD_ATTEMPTS,
        lastError: expect.stringContaining('500'),
      }),
    );
  });

  it('does not throw when every attempt fails — callers keep processing other files', async () => {
    const { service, googleClient, connection } = build();

    googleClient.requestRaw.mockRejectedValue(new Error('ECONNRESET'));

    await expect(
      service.ingestDriveDocument({
        connection,
        userId: 'user-1',
        file: { id: 'drive-file-3', name: 'flaky.pdf', mimeType: 'application/pdf', modifiedTime: null },
      }),
    ).resolves.toEqual(expect.objectContaining({ outcome: 'failed' }));
  });
});

describe('CloudFileIngestService.ingestDriveArchive', () => {
  function zipOf(names: string[]): Buffer {
    const zip = new AdmZip();
    for (const name of names) {
      zip.addFile(name, Buffer.from(`contents of ${name}`));
    }

    return zip.toBuffer();
  }

  /**
   * A Drive stand-in serving one file: `Range` requests answer 206 with that
   * slice, a plain request answers 200 with a real streaming body.
   */
  function serve(bytes: Buffer) {
    return jest.fn(async (_connection: unknown, _endpoint: string, options?: RequestInit) => {
      const range = (options?.headers as Record<string, string> | undefined)?.Range;

      if (range) {
        const [, start, end] = /bytes=(\d+)-(\d+)/.exec(range)!;

        return new Response(new Uint8Array(bytes.subarray(Number(start), Number(end) + 1)), { status: 206 });
      }

      return new Response(new Uint8Array(bytes), { status: 200 });
    });
  }

  const FACEBOOK_EXPORT = [
    'your_facebook_activity/posts/your_posts_1.json',
    'your_facebook_activity/messages/inbox/alice_1/message_1.json',
  ];
  const archive = (bytes: Buffer, overrides: Record<string, unknown> = {}) => ({
    id: 'drive-zip-1',
    name: 'facebook-export.zip',
    mimeType: 'application/zip',
    modifiedTime: '2026-10-01T00:00:00Z',
    size: bytes.length,
    ...overrides,
  });

  it('downloads a zip an importer recognises and starts a run declared as that importer', async () => {
    const { service, googleClient, stagedSources, importRuns, ledger, connection } = build();
    const bytes = zipOf(FACEBOOK_EXPORT);
    googleClient.requestRaw.mockImplementation(serve(bytes));

    const result = await service.ingestDriveArchive({ connection, userId: 'user-1', file: archive(bytes) });

    expect(result).toMatchObject({ outcome: 'downloaded', byteSize: bytes.length, importers: ['facebook'] });

    const registerInput = stagedSources.registerUpload.mock.calls[0][1] as {
      dropId: string;
      sourcePath: string;
    };
    expect(await readFile(registerInput.sourcePath)).toEqual(bytes);

    expect(importRuns.startRun).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({
        dropId: registerInput.dropId,
        source: 'connections',
        declaredSources: ['facebook'],
      }),
    );
    expect(ledger.recordSuccess).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ externalFileId: 'drive-zip-1', byteSize: bytes.length }),
    );
  });

  it('leaves an unrecognised zip alone: listing read, nothing downloaded, remembered', async () => {
    const { service, googleClient, stagedSources, importRuns, ledger, connection } = build();
    const bytes = zipOf(['proj/src/index.ts', 'proj/package.json', 'proj/notes.ics']);
    googleClient.requestRaw.mockImplementation(serve(bytes));

    const result = await service.ingestDriveArchive({ connection, userId: 'user-1', file: archive(bytes) });

    expect(result).toEqual({ outcome: 'not_an_export' });
    // Every request carried a Range header — the full file was never asked for.
    for (const call of googleClient.requestRaw.mock.calls) {
      expect((call[2] as RequestInit).headers).toHaveProperty('Range');
    }

    expect(stagedSources.registerUpload).not.toHaveBeenCalled();
    expect(importRuns.startRun).not.toHaveBeenCalled();
    expect(ledger.recordNotExport).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ externalFileId: 'drive-zip-1', revision: '2026-10-01T00:00:00Z' }),
    );
    expect(await readdir(uploadsDir)).toEqual([]);
  });

  it.each(['downloaded', 'not_export'] as const)(
    'makes no request for a zip already settled as %s at this revision',
    async (status) => {
      const { service, googleClient, ledger, connection } = build();
      ledger.findCurrent.mockResolvedValue({
        status,
        revision: '2026-10-01T00:00:00Z',
      } as CloudFileIngest);

      const result = await service.ingestDriveArchive({
        connection,
        userId: 'user-1',
        file: archive(Buffer.alloc(100)),
      });

      expect(result.outcome).toBe(status === 'downloaded' ? 'skipped_unchanged' : 'not_an_export');
      expect(googleClient.requestRaw).not.toHaveBeenCalled();
    },
  );

  it('re-checks a zip whose revision moved on from a not_export verdict', async () => {
    const { service, googleClient, ledger, connection } = build();
    const bytes = zipOf(FACEBOOK_EXPORT);
    googleClient.requestRaw.mockImplementation(serve(bytes));
    ledger.findCurrent.mockResolvedValue({ status: 'not_export', revision: 'older' } as CloudFileIngest);

    const result = await service.ingestDriveArchive({ connection, userId: 'user-1', file: archive(bytes) });

    expect(result.outcome).toBe('downloaded');
  });

  it('records a failure, and no verdict, when the listing cannot be read', async () => {
    const { service, googleClient, ledger, connection } = build();
    googleClient.requestRaw.mockResolvedValue(new Response('nope', { status: 403, statusText: 'Forbidden' }));

    const result = await service.ingestDriveArchive({
      connection,
      userId: 'user-1',
      file: archive(Buffer.alloc(1000)),
    });

    expect(result.outcome).toBe('failed');
    expect(ledger.recordNotExport).not.toHaveBeenCalled();
    expect(ledger.recordFailure).toHaveBeenCalled();
  });

  it('removes the partial file and fails when the download comes up short', async () => {
    const { service, googleClient, stagedSources, ledger, connection } = build();
    const bytes = zipOf(FACEBOOK_EXPORT);
    const ranged = serve(bytes);
    googleClient.requestRaw.mockImplementation(async (c: unknown, e: string, options?: RequestInit) =>
      options?.headers
        ? ranged(c, e, options)
        : new Response(new Uint8Array(bytes.subarray(0, 50)), { status: 200 }),
    );

    const result = await service.ingestDriveArchive({ connection, userId: 'user-1', file: archive(bytes) });

    expect(result).toMatchObject({ outcome: 'failed', attempts: MAX_DOWNLOAD_ATTEMPTS });
    expect(stagedSources.registerUpload).not.toHaveBeenCalled();
    expect(ledger.recordFailure).toHaveBeenCalled();
    expect(await readdir(uploadsDir)).toEqual([]);
  });

  it('does not try to range over a file with no size', async () => {
    const { service, googleClient, ledger, connection } = build();

    const result = await service.ingestDriveArchive({
      connection,
      userId: 'user-1',
      file: archive(Buffer.alloc(0), { size: null }),
    });

    expect(result).toEqual({ outcome: 'not_an_export' });
    expect(googleClient.requestRaw).not.toHaveBeenCalled();
    expect(ledger.recordNotExport).not.toHaveBeenCalled();
  });
});

describe('CloudFileIngestService — Dropbox', () => {
  it('ingests a recognised export through the Dropbox client, keyed on rev', async () => {
    const { service, googleClient, dropboxClient, importRuns, ledger, connection } = build();
    const zip = new AdmZip();
    zip.addFile('your_facebook_activity/posts/your_posts_1.json', Buffer.from('[]'));
    const bytes = zip.toBuffer();

    dropboxClient.download.mockImplementation(
      async (_connection: unknown, _fileId: string, range?: { offset: number; length: number }) =>
        range
          ? new Response(new Uint8Array(bytes.subarray(range.offset, range.offset + range.length)), {
              status: 206,
            })
          : new Response(new Uint8Array(bytes), { status: 200 }),
    );

    const result = await service.ingestDropboxArchive({
      connection,
      userId: 'user-1',
      file: {
        id: 'id:abc',
        name: 'facebook.zip',
        mimeType: 'application/zip',
        rev: 'rev-9',
        size: bytes.length,
      },
    });

    expect(result).toMatchObject({ outcome: 'downloaded', importers: ['facebook'] });
    expect(dropboxClient.download).toHaveBeenCalledWith(connection, 'id:abc', expect.anything());
    expect(googleClient.requestRaw).not.toHaveBeenCalled();
    expect(importRuns.startRun).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ declaredSources: ['facebook'] }),
    );
    expect(ledger.recordSuccess).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ provider: DROPBOX_PROVIDER, externalFileId: 'id:abc', revision: 'rev-9' }),
    );
  });

  it('downloads a document and skips it once the ledger has that rev', async () => {
    const { service, dropboxClient, ledger, connection } = build();
    dropboxClient.download.mockResolvedValue(new Response('%PDF-1.4', { status: 200 }));
    const file = { id: 'id:doc', name: 'notes.pdf', mimeType: 'application/pdf', rev: 'rev-1' };

    expect((await service.ingestDropboxDocument({ connection, userId: 'user-1', file })).outcome).toBe(
      'downloaded',
    );

    ledger.findCurrent.mockResolvedValue({ status: 'downloaded', revision: 'rev-1' } as CloudFileIngest);
    expect((await service.ingestDropboxDocument({ connection, userId: 'user-1', file })).outcome).toBe(
      'skipped_unchanged',
    );
    expect(dropboxClient.download).toHaveBeenCalledTimes(1);
  });
});

describe('CloudFileIngestService — photo and video batches', () => {
  const media = (name: string, body: string, overrides: Record<string, unknown> = {}) => ({
    id: `id:${name}`,
    name,
    mimeType: 'image/jpeg',
    revision: 'rev-1',
    size: Buffer.byteLength(body),
    relativePath: `Camera Uploads/${name}`,
    ...overrides,
  });

  it('downloads a page of media into one folder and starts ONE run for all of it', async () => {
    const { service, dropboxClient, stagedSources, importRuns, ledger, connection } = build();
    const bodies: Record<string, string> = { 'id:a.jpg': 'aaaa', 'id:b.jpg': 'bbbbbb' };
    dropboxClient.download.mockImplementation(
      async (_c: unknown, fileId: string) => new Response(bodies[fileId], { status: 200 }),
    );

    const result = await service.ingestDropboxMedia({
      connection,
      userId: 'user-1',
      files: [media('a.jpg', 'aaaa'), media('b.jpg', 'bbbbbb')],
    });

    expect(result.downloaded.sort()).toEqual(['id:a.jpg', 'id:b.jpg']);
    expect(result.byteSize).toBe(10);
    expect(result.importRunId).toBe('run-1');

    const [dropId] = await readdir(uploadsDir);
    const batchDir = path.join(uploadsDir, dropId, 'Dropbox');

    expect(await readFile(path.join(batchDir, 'Camera Uploads', 'a.jpg'), 'utf8')).toBe('aaaa');
    expect(await readFile(path.join(batchDir, 'Camera Uploads', 'b.jpg'), 'utf8')).toBe('bbbbbb');

    expect(stagedSources.registerUpload).toHaveBeenCalledTimes(1);
    expect(stagedSources.registerUpload).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ dropId, sourcePath: batchDir, kind: 'directory', sizeBytes: 10 }),
    );
    expect(importRuns.startRun).toHaveBeenCalledTimes(1);
    // The run remembers the photos came from Dropbox, so they are attributed to it.
    expect(importRuns.startRun).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({
        source: 'connections',
        originPlatform: 'dropbox',
        originConnectionId: 'conn-1',
      }),
    );
    // One ledger entry per photo, all pointing at the one run.
    expect(ledger.recordSuccess).toHaveBeenCalledTimes(2);
    expect(ledger.recordSuccess).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({
        externalFileId: 'id:a.jpg',
        revision: 'rev-1',
        byteSize: 4,
        importRunId: 'run-1',
      }),
    );
  });

  it('skips photos the ledger already has, and starts no run when nothing is new', async () => {
    const { service, dropboxClient, importRuns, ledger, connection } = build();
    ledger.findCurrent.mockResolvedValue({ status: 'downloaded', revision: 'rev-1' } as CloudFileIngest);

    const result = await service.ingestDropboxMedia({
      connection,
      userId: 'user-1',
      files: [media('a.jpg', 'aaaa')],
    });

    expect(result).toMatchObject({ downloaded: [], unchanged: ['id:a.jpg'], failed: [] });
    expect(dropboxClient.download).not.toHaveBeenCalled();
    expect(importRuns.startRun).not.toHaveBeenCalled();
  });

  it('imports the photos that arrived when one of the page fails', async () => {
    const { service, dropboxClient, importRuns, ledger, connection } = build();
    dropboxClient.download.mockImplementation(async (_c: unknown, fileId: string) =>
      fileId === 'id:bad.jpg'
        ? new Response('nope', { status: 500, statusText: 'Server Error' })
        : new Response('good', { status: 200 }),
    );

    const result = await service.ingestDropboxMedia({
      connection,
      userId: 'user-1',
      files: [media('good.jpg', 'good'), media('bad.jpg', 'xxxx')],
    });

    expect(result.downloaded).toEqual(['id:good.jpg']);
    expect(result.failed).toEqual([{ id: 'id:bad.jpg', reason: expect.stringContaining('500') }]);
    expect(importRuns.startRun).toHaveBeenCalledTimes(1);
    expect(ledger.recordFailure).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ externalFileId: 'id:bad.jpg' }),
    );

    const [dropId] = await readdir(uploadsDir);
    expect(await readdir(path.join(uploadsDir, dropId, 'Dropbox', 'Camera Uploads'))).toEqual(['good.jpg']);
  });

  it('does not import a photo that came up short', async () => {
    const { service, dropboxClient, importRuns, connection } = build();
    dropboxClient.download.mockImplementation(async () => new Response('half', { status: 200 }));

    const result = await service.ingestDropboxMedia({
      connection,
      userId: 'user-1',
      files: [media('a.jpg', 'the whole photo')],
    });

    expect(result.downloaded).toEqual([]);
    expect(result.failed[0].reason).toContain('ended at 4 of 15');
    expect(importRuns.startRun).not.toHaveBeenCalled();
    expect(await readdir(uploadsDir)).toEqual([]);
  });

  it('uses the Drive client for Drive media', async () => {
    const { service, googleClient, dropboxClient, importRuns, connection } = build();
    googleClient.requestRaw.mockImplementation(async () => new Response('jpeg', { status: 200 }));

    const result = await service.ingestDriveMedia({
      connection,
      userId: 'user-1',
      files: [media('a.jpg', 'jpeg', { id: 'drive-1', relativePath: 'drive-1/a.jpg' })],
    });

    expect(result.downloaded).toEqual(['drive-1']);
    expect(importRuns.startRun).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ originPlatform: 'google_drive', originConnectionId: 'conn-1' }),
    );
    expect(googleClient.requestRaw).toHaveBeenCalledWith(connection, '/drive/v3/files/drive-1?alt=media');
    expect(dropboxClient.download).not.toHaveBeenCalled();
  });
});

describe('CloudFileIngestService — media batch path safety', () => {
  it.each(['../escape.jpg', 'a/../../escape.jpg', 'a/./b.jpg'])(
    'refuses the path %s',
    async (relativePath) => {
      const { service, dropboxClient, importRuns, connection } = build();
      dropboxClient.download.mockImplementation(async () => new Response('x', { status: 200 }));

      const result = await service.ingestDropboxMedia({
        connection,
        userId: 'user-1',
        files: [
          { id: 'id:x', name: 'escape.jpg', mimeType: 'image/jpeg', revision: 'r', size: 1, relativePath },
        ],
      });

      expect(result.downloaded).toEqual([]);
      expect(result.failed[0].reason).toContain('unsafe path');
      expect(importRuns.startRun).not.toHaveBeenCalled();
    },
  );

  it('keeps a file name exactly as the provider has it', async () => {
    const { service, dropboxClient, connection } = build();
    dropboxClient.download.mockImplementation(async () => new Response('x', { status: 200 }));

    await service.ingestDropboxMedia({
      connection,
      userId: 'user-1',
      files: [
        {
          id: 'id:x',
          name: '2012-07-15 14.50.57 (café).jpg',
          mimeType: 'image/jpeg',
          revision: 'r',
          size: 1,
          relativePath: 'Camera Uploads/2012-07-15 14.50.57 (café).jpg',
        },
      ],
    });

    const [dropId] = await readdir(uploadsDir);

    expect(await readdir(path.join(uploadsDir, dropId, 'Dropbox', 'Camera Uploads'))).toEqual([
      '2012-07-15 14.50.57 (café).jpg',
    ]);
  });
});

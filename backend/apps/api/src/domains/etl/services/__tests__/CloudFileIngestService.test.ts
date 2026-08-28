import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import config from '@ci/configuration';

import type { CloudFileIngest } from '../../entities/CloudFileIngestEntity';
import {
  CloudFileIngestService,
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
  };

  const service = new CloudFileIngestService(
    googleClient as never,
    stagedSources as never,
    importRuns as never,
    ledger as never,
    makeLogger() as never,
  );

  const connection = { id: 'conn-1', accessToken: 'token' } as never;

  return { service, googleClient, stagedSources, importRuns, ledger, connection, calls };
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

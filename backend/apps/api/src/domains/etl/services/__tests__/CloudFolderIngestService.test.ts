import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import config from '@ci/configuration';

import type { CloudFolderExport } from '../../entities/CloudFolderExportEntity';
import { CloudFolderIngestService } from '../CloudFolderIngestService';

let uploadsDir: string;
let previousUploadsDir: string;

beforeEach(async () => {
  uploadsDir = await mkdtemp(path.join(os.tmpdir(), 'ci-folder-ingest-'));
  previousUploadsDir = config.import.uploadsDir;
  (config.import as { uploadsDir: string }).uploadsDir = uploadsDir;
});

afterEach(() => {
  (config.import as { uploadsDir: string }).uploadsDir = previousUploadsDir;
});

const ROOT = '/apps/meta/meta-2026-oct-05/facebook-user-2026-10-05-abc';
/** The folder Meta makes for one transfer; its part folders are one export. */
const TRANSFER_ROOT = '/apps/meta/meta-2026-oct-05';
const DISPLAY_ROOT = '/Apps/Meta/meta-2026-oct-05/facebook-user-2026-10-05-abc';

/** The export as Dropbox holds it: display path → contents. */
const REMOTE: Record<string, string> = {
  [`${DISPLAY_ROOT}/your_facebook_activity/messages/inbox/Friends_1/message_1.json`]: '{"messages":[]}',
  [`${DISPLAY_ROOT}/your_facebook_activity/messages/inbox/Friends_1/photos/a.jpg`]: 'jpeg-bytes',
  [`${DISPLAY_ROOT}/your_facebook_activity/posts/your_videos.json`]: '[]',
};

/** A Drive tree: folder and file entries by id, as Drive's API describes them. */
interface DriveNode {
  id: string;
  name: string;
  parent: string | null;
  body?: string;
}

const DRIVE_FOLDER = 'application/vnd.google-apps.folder';

function driveClient(nodes: DriveNode[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const entry = (node: DriveNode) => ({
    id: node.id,
    name: node.name,
    mimeType: node.body == null ? DRIVE_FOLDER : 'application/octet-stream',
    ...(node.body == null ? {} : { size: String(Buffer.byteLength(node.body)) }),
    ...(node.parent ? { parents: [node.parent] } : {}),
    webViewLink: `https://drive.google.com/file/d/${node.id}/view`,
  });

  return {
    request: jest.fn(async (_connection: unknown, endpoint: string) => {
      const url = new URL(endpoint, 'https://www.googleapis.com');
      const q = url.searchParams.get('q');

      if (q) {
        const parent = /^'([^']+)' in parents/.exec(q)![1];

        return { files: nodes.filter((node) => node.parent === parent).map(entry) };
      }

      const node = byId.get(decodeURIComponent(url.pathname.split('/').pop()!));
      if (!node) {
        throw new Error('404');
      }

      return entry(node);
    }),
    requestRaw: jest.fn(async (_connection: unknown, endpoint: string) => {
      const id = decodeURIComponent(
        new URL(endpoint, 'https://www.googleapis.com').pathname.split('/').pop()!,
      );

      return new Response(byId.get(id)!.body, { status: 200 });
    }),
  };
}

function build(remote: Record<string, string> = REMOTE, driveNodes: DriveNode[] = []) {
  const entries = Object.entries(remote).map(([display, body], i) => ({
    '.tag': 'file',
    id: `id:${i}`,
    name: path.posix.basename(display),
    path_display: display,
    path_lower: display.toLowerCase(),
    size: Buffer.byteLength(body),
  }));

  const dropboxClient = {
    rpc: jest.fn(async () => ({ entries, cursor: 'c', has_more: false })),
    download: jest.fn(async (_connection: unknown, fileId: string) => {
      const body = Object.values(remote)[Number(fileId.slice(3))];

      return new Response(body, { status: 200 });
    }),
  };
  const googleClient = {
    ...driveClient(driveNodes),
    refreshAccessToken: jest.fn(async () => ({
      accessToken: 'renewed',
      refreshToken: null,
      tokenExpiry: new Date(Date.now() + 3_600_000),
    })),
  };
  const connections = {
    update: jest.fn(async (_ctx: unknown, id: string, data: Record<string, unknown>) => ({
      id,
      userId: 'user-1',
      refreshToken: 'refresh',
      ...data,
    })),
  };
  const stagedSources = { registerUpload: jest.fn(async () => ({})) };
  const importRuns = { startRun: jest.fn(async () => ({ run: { id: 'run-1' }, stages: [] })) };
  const fileService = { removePointersByExternalIds: jest.fn(async () => 2) };

  const known: CloudFolderExport[] = [];
  const ledger = {
    listForConnection: jest.fn(async () => known),
    recordChange: jest.fn(async () => undefined),
    claimSettled: jest.fn(async (): Promise<CloudFolderExport[]> => []),
    heartbeat: jest.fn(async () => undefined),
    markImported: jest.fn(async () => undefined),
    markWaiting: jest.fn(async () => undefined),
    markFailed: jest.fn(async () => undefined),
  };
  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  };

  const service = new CloudFolderIngestService(
    dropboxClient as never,
    googleClient as never,
    connections as never,
    stagedSources as never,
    importRuns as never,
    fileService as never,
    ledger as never,
    logger as never,
  );

  return {
    service,
    dropboxClient,
    googleClient,
    connections,
    stagedSources,
    importRuns,
    fileService,
    ledger,
    known,
    logger,
  };
}

const connection = { id: 'conn-1', accessToken: 'token' } as never;
const folder = (overrides: Partial<CloudFolderExport> = {}) =>
  ({
    id: 'folder-1',
    userId: 'user-1',
    connectionId: 'conn-1',
    provider: 'dropbox',
    rootPath: ROOT,
    importers: ['facebook'],
    status: 'downloading',
    ...overrides,
  }) as CloudFolderExport;

describe('CloudFolderIngestService.claimDropboxFiles', () => {
  const listed = (paths: string[]) => paths.map((p) => ({ path: p }));

  it('recognises an export folder from the listing and claims only the files inside it', async () => {
    const { service, ledger } = build();
    const exportRoot = '/exports/facebook-user-2026-10-05-abc';
    const files = listed([
      `${exportRoot}/your_facebook_activity/messages/inbox/friends_1/message_1.json`,
      `${exportRoot}/your_facebook_activity/posts/media/a.jpg`,
      '/camera uploads/2012-07-15 14.50.40.jpg',
      '/keys/ssh/me.pub',
    ]);

    const claimed = await service.claimDropboxFiles({ connection, userId: 'user-1', files });

    expect([...claimed].map((f) => f.path)).toEqual([files[0].path, files[1].path]);
    expect(ledger.recordChange).toHaveBeenCalledTimes(1);
    expect(ledger.recordChange).toHaveBeenCalledWith(
      { userId: 'user-1' },
      { connectionId: 'conn-1', provider: 'dropbox', rootPath: exportRoot, importers: ['facebook'] },
    );
  });

  it('takes the part folders of one Meta transfer as ONE export, rooted at the transfer folder', async () => {
    const { service, ledger } = build();
    const files = listed([
      `${TRANSFER_ROOT}/facebook-user-2026-10-05-abc/your_facebook_activity/messages/inbox/friends_1/message_1.json`,
      // A part that holds only media: on its own it is still part of the export.
      `${TRANSFER_ROOT}/facebook-user-2026-10-05-xyz/your_facebook_activity/messages/inbox/friends_1/photos/a.jpg`,
      '/camera uploads/2012-07-15 14.50.40.jpg',
    ]);

    const claimed = await service.claimDropboxFiles({ connection, userId: 'user-1', files });

    expect([...claimed].map((f) => f.path)).toEqual([files[0].path, files[1].path]);
    expect(ledger.recordChange).toHaveBeenCalledTimes(1);
    expect(ledger.recordChange).toHaveBeenCalledWith(
      { userId: 'user-1' },
      { connectionId: 'conn-1', provider: 'dropbox', rootPath: TRANSFER_ROOT, importers: ['facebook'] },
    );
  });

  it('claims a file under an already-known folder without needing to recognise it again', async () => {
    const { service, ledger, known } = build();
    known.push(folder({ status: 'imported' }));
    // On its own this path would not be recognised as anything.
    const files = listed([`${ROOT}/late_arrival.jpg`, '/notes.txt']);

    const claimed = await service.claimDropboxFiles({ connection, userId: 'user-1', files });

    expect([...claimed].map((f) => f.path)).toEqual([`${ROOT}/late_arrival.jpg`]);
    // Recorded as a change, which is what sends an imported folder round again.
    expect(ledger.recordChange).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ rootPath: ROOT }),
    );
  });

  it('claims nothing from an ordinary Dropbox', async () => {
    const { service, ledger } = build();

    const claimed = await service.claimDropboxFiles({
      connection,
      userId: 'user-1',
      files: listed(['/camera uploads/a.jpg', '/docs/report.pdf', '/project/messages/readme.md']),
    });

    expect(claimed.size).toBe(0);
    expect(ledger.recordChange).not.toHaveBeenCalled();
  });

  it('never treats the whole Dropbox as one export', async () => {
    const { service, ledger } = build();

    // A Facebook export unpacked straight into the Dropbox root.
    const claimed = await service.claimDropboxFiles({
      connection,
      userId: 'user-1',
      files: listed(['/your_facebook_activity/posts/your_posts_1.json', '/camera uploads/a.jpg']),
    });

    expect(claimed.size).toBe(0);
    expect(ledger.recordChange).not.toHaveBeenCalled();
  });

  it('treats every file as ordinary when the ledger cannot be read', async () => {
    const { service, ledger } = build();
    ledger.listForConnection.mockRejectedValue(new Error('db away'));

    const claimed = await service.claimDropboxFiles({
      connection,
      userId: 'user-1',
      files: listed([`${ROOT}/your_facebook_activity/posts/media/a.jpg`]),
    });

    expect(claimed.size).toBe(0);
  });
});

describe('CloudFolderIngestService.ingestSettledDropboxFolders', () => {
  it('downloads a settled folder with its structure intact and starts ONE run for it', async () => {
    const { service, dropboxClient, stagedSources, importRuns, fileService, ledger } = build();
    ledger.claimSettled.mockResolvedValue([folder()]);

    await service.ingestSettledDropboxFolders({ connection, userId: 'user-1' });

    // Listed fresh from Dropbox at download time, by the folder's own path.
    expect(dropboxClient.rpc).toHaveBeenCalledWith(
      connection,
      '/2/files/list_folder',
      expect.objectContaining({ path: ROOT, recursive: true }),
    );

    const [dropId] = await readdir(uploadsDir);
    const exportDir = path.join(uploadsDir, dropId, 'facebook-user-2026-10-05-abc');

    // Display casing preserved: the importer matches on these names.
    expect(
      await readFile(
        path.join(exportDir, 'your_facebook_activity/messages/inbox/Friends_1/photos/a.jpg'),
        'utf8',
      ),
    ).toBe('jpeg-bytes');
    expect(
      await readFile(path.join(exportDir, 'your_facebook_activity/posts/your_videos.json'), 'utf8'),
    ).toBe('[]');

    const totalBytes = Object.values(REMOTE).reduce((n, body) => n + Buffer.byteLength(body), 0);

    expect(stagedSources.registerUpload).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ dropId, sourcePath: exportDir, kind: 'directory', sizeBytes: totalBytes }),
    );
    expect(importRuns.startRun).toHaveBeenCalledTimes(1);
    expect(importRuns.startRun).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({
        dropId,
        source: 'connections',
        declaredSources: ['facebook'],
        originPlatform: 'dropbox',
        originConnectionId: 'conn-1',
      }),
    );
    expect(ledger.markImported).toHaveBeenCalledWith(
      'folder-1',
      expect.objectContaining({ fileCount: 3, byteSize: totalBytes, dropId, importRunId: 'run-1' }),
    );

    // The pointer rows an earlier sync wrote for these files are cleared.
    expect(fileService.removePointersByExternalIds).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.arrayContaining([
        'https://www.dropbox.com/home/Apps/Meta/meta-2026-oct-05/facebook-user-2026-10-05-abc/your_facebook_activity/posts?preview=your_videos.json',
      ]),
    );
  });

  it('does nothing when no folder has settled', async () => {
    const { service, dropboxClient, importRuns } = build();

    await service.ingestSettledDropboxFolders({ connection, userId: 'user-1' });

    expect(dropboxClient.rpc).not.toHaveBeenCalled();
    expect(importRuns.startRun).not.toHaveBeenCalled();
  });

  it('gives the folder back for a retry, and leaves nothing on disk, when a file fails to download', async () => {
    const { service, dropboxClient, importRuns, ledger } = build();
    ledger.claimSettled.mockResolvedValue([folder()]);
    dropboxClient.download.mockImplementation(async (_c: unknown, fileId: string) =>
      fileId === 'id:1'
        ? new Response('expired', { status: 401, statusText: 'Unauthorized' })
        : new Response(Object.values(REMOTE)[Number(fileId.slice(3))], { status: 200 }),
    );

    await service.ingestSettledDropboxFolders({ connection, userId: 'user-1' });

    expect(importRuns.startRun).not.toHaveBeenCalled();
    expect(ledger.markImported).not.toHaveBeenCalled();
    expect(ledger.markFailed).toHaveBeenCalledWith('folder-1', expect.stringContaining('401'));
    expect(await readdir(uploadsDir)).toEqual([]);
  });

  it('fails the folder rather than import a file that came up short', async () => {
    const { service, dropboxClient, importRuns, ledger } = build();
    ledger.claimSettled.mockResolvedValue([folder()]);
    dropboxClient.download.mockImplementation(async () => new Response('x', { status: 200 }));

    await service.ingestSettledDropboxFolders({ connection, userId: 'user-1' });

    expect(importRuns.startRun).not.toHaveBeenCalled();
    expect(ledger.markFailed).toHaveBeenCalledWith('folder-1', expect.stringContaining('ended at 1 of'));
  });

  it('refuses a listing entry that would be written outside the export folder', async () => {
    const { service, importRuns, ledger } = build({
      [`${DISPLAY_ROOT}/your_facebook_activity/posts/your_posts_1.json`]: '[]',
      [`${DISPLAY_ROOT}/../../../escape.txt`]: 'x',
    });
    ledger.claimSettled.mockResolvedValue([folder()]);

    await service.ingestSettledDropboxFolders({ connection, userId: 'user-1' });

    expect(importRuns.startRun).not.toHaveBeenCalled();
    expect(ledger.markFailed).toHaveBeenCalledWith('folder-1', expect.stringContaining('refusing to write'));
  });

  it('downloads nothing, and waits, while the folder holds only attachments', async () => {
    // What Meta delivers first: the photos of a conversation, hours before the conversation.
    const { service, dropboxClient, importRuns, ledger } = build({
      [`${DISPLAY_ROOT}/your_facebook_activity/messages/inbox/Friends_1/photos/a.jpg`]: 'jpeg-bytes',
      [`${DISPLAY_ROOT}/your_facebook_activity/messages/inbox/Friends_1/videos/b.mp4`]: 'mp4-bytes',
    });
    ledger.claimSettled.mockResolvedValue([folder()]);

    await service.ingestSettledDropboxFolders({ connection, userId: 'user-1' });

    expect(dropboxClient.download).not.toHaveBeenCalled();
    expect(importRuns.startRun).not.toHaveBeenCalled();
    expect(ledger.markImported).not.toHaveBeenCalled();
    expect(ledger.markFailed).not.toHaveBeenCalled();
    expect(ledger.markWaiting).toHaveBeenCalledWith('folder-1', {
      fileCount: 2,
      reason: expect.stringContaining('waiting'),
    });
    expect(await readdir(uploadsDir)).toEqual([]);
  });
});

/**
 * My Drive
 * ├── meta-2026-Oct-05-10-12-25/            (Meta's transfer folder)
 * │   ├── facebook-user-2026-10-06-AAA/     part 1: the messages
 * │   └── facebook-user-2026-10-06-BBB/     part 2: their photos
 * └── Holiday/beach.jpg
 */
const DRIVE_TREE: DriveNode[] = [
  { id: 'root', name: 'My Drive', parent: null },
  { id: 'meta', name: 'meta-2026-Oct-05-10-12-25', parent: 'root' },
  { id: 'p1', name: 'facebook-user-2026-10-06-AAA', parent: 'meta' },
  { id: 'p1-act', name: 'your_facebook_activity', parent: 'p1' },
  { id: 'p1-msg', name: 'messages', parent: 'p1-act' },
  { id: 'p1-inbox', name: 'inbox', parent: 'p1-msg' },
  { id: 'p1-thread', name: 'Friends_1', parent: 'p1-inbox' },
  { id: 'f-json', name: 'message_1.json', parent: 'p1-thread', body: '{"messages":[]}' },
  { id: 'p2', name: 'facebook-user-2026-10-06-BBB', parent: 'meta' },
  { id: 'p2-act', name: 'your_facebook_activity', parent: 'p2' },
  { id: 'p2-msg', name: 'messages', parent: 'p2-act' },
  { id: 'p2-inbox', name: 'inbox', parent: 'p2-msg' },
  { id: 'p2-thread', name: 'Friends_1', parent: 'p2-inbox' },
  { id: 'p2-photos', name: 'photos', parent: 'p2-thread' },
  { id: 'f-jpg', name: 'a.jpg', parent: 'p2-photos', body: 'jpeg-bytes' },
  { id: 'holiday', name: 'Holiday', parent: 'root' },
  { id: 'f-beach', name: 'beach.jpg', parent: 'holiday', body: 'sand' },
];

const driveListed = (ids: string[]) =>
  ids.map((id) => {
    const node = DRIVE_TREE.find((n) => n.id === id)!;

    return { id, name: node.name, parents: node.parent ? [node.parent] : undefined };
  });

describe('CloudFolderIngestService.claimDriveFiles', () => {
  it('works out where each file sits and claims a Meta transfer by its folder ids', async () => {
    const { service, ledger, googleClient } = build(REMOTE, DRIVE_TREE);
    const files = driveListed(['f-jpg', 'f-beach']);

    const claimed = await service.claimDriveFiles({ connection, userId: 'user-1', files });

    // A page holding only one part's photos is enough to recognise the export.
    expect([...claimed].map((f) => f.id)).toEqual(['f-jpg']);
    expect(ledger.recordChange).toHaveBeenCalledTimes(1);
    expect(ledger.recordChange).toHaveBeenCalledWith(
      { userId: 'user-1' },
      // Ids, not names: two Drive folders may share a name. My Drive is where paths start.
      { connectionId: 'conn-1', provider: 'google_drive', rootPath: '/meta', importers: ['facebook'] },
    );

    // Each folder is asked about once, however many files or pages share it.
    const lookups = googleClient.request.mock.calls.length;
    await service.claimDriveFiles({ connection, userId: 'user-1', files: driveListed(['f-jpg', 'f-json']) });
    expect(googleClient.request.mock.calls.length).toBeLessThan(lookups * 2);
  });

  it('claims a file under an already-known transfer folder', async () => {
    const { service, known } = build(REMOTE, DRIVE_TREE);
    known.push(folder({ provider: 'google_drive', rootPath: '/meta', status: 'imported' }));

    const claimed = await service.claimDriveFiles({
      connection,
      userId: 'user-1',
      files: driveListed(['f-json', 'f-beach']),
    });

    expect([...claimed].map((f) => f.id)).toEqual(['f-json']);
  });

  it('leaves alone a file the listing gave no parent for', async () => {
    const { service, ledger, googleClient } = build(REMOTE, DRIVE_TREE);

    const claimed = await service.claimDriveFiles({
      connection,
      userId: 'user-1',
      files: [{ id: 'shared', name: 'message_1.json' }],
    });

    expect(claimed.size).toBe(0);
    expect(googleClient.request).not.toHaveBeenCalled();
    expect(ledger.recordChange).not.toHaveBeenCalled();
  });

  it('treats every file as ordinary when a folder lookup fails', async () => {
    const { service, googleClient } = build(REMOTE, DRIVE_TREE);
    googleClient.request.mockRejectedValue(new Error('403'));

    const claimed = await service.claimDriveFiles({
      connection,
      userId: 'user-1',
      files: driveListed(['f-jpg']),
    });

    expect(claimed.size).toBe(0);
  });
});

describe('CloudFolderIngestService.ingestSettledDriveFolders', () => {
  it('lays the parts of a transfer over each other and starts ONE run for the whole export', async () => {
    const { service, stagedSources, importRuns, fileService, ledger } = build(REMOTE, DRIVE_TREE);
    ledger.claimSettled.mockResolvedValue([folder({ provider: 'google_drive', rootPath: '/meta' })]);

    await service.ingestSettledDriveFolders({ connection, userId: 'user-1' });

    const [dropId] = await readdir(uploadsDir);
    const exportDir = path.join(uploadsDir, dropId, 'meta-2026-Oct-05-10-12-25');
    const thread = path.join(exportDir, 'your_facebook_activity/messages/inbox/Friends_1');

    // The messages came from one part and the photo from another; the importer
    // finds the photo where the message says it is.
    expect(await readFile(path.join(thread, 'message_1.json'), 'utf8')).toBe('{"messages":[]}');
    expect(await readFile(path.join(thread, 'photos/a.jpg'), 'utf8')).toBe('jpeg-bytes');
    expect(await readdir(exportDir)).toEqual(['your_facebook_activity']);

    expect(stagedSources.registerUpload).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ dropId, sourcePath: exportDir, kind: 'directory' }),
    );
    expect(importRuns.startRun).toHaveBeenCalledTimes(1);
    expect(importRuns.startRun).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({
        dropId,
        label: 'meta-2026-Oct-05-10-12-25',
        declaredSources: ['facebook'],
        originPlatform: 'google_drive',
        originConnectionId: 'conn-1',
      }),
    );
    expect(ledger.markImported).toHaveBeenCalledWith('folder-1', expect.objectContaining({ fileCount: 2 }));
    expect(fileService.removePointersByExternalIds).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.arrayContaining(['https://drive.google.com/file/d/f-jpg/view']),
    );
  });

  it('keeps the first copy, and says so, when two parts hold the same path', async () => {
    const { service, ledger, logger } = build(REMOTE, [
      ...DRIVE_TREE,
      { id: 'dup', name: 'message_1.json', parent: 'p2-thread', body: 'other' },
    ]);
    ledger.claimSettled.mockResolvedValue([folder({ provider: 'google_drive', rootPath: '/meta' })]);

    await service.ingestSettledDriveFolders({ connection, userId: 'user-1' });

    const [dropId] = await readdir(uploadsDir);
    const kept = path.join(
      uploadsDir,
      dropId,
      'meta-2026-Oct-05-10-12-25/your_facebook_activity/messages/inbox/Friends_1/message_1.json',
    );

    expect(await readFile(kept, 'utf8')).toBe('{"messages":[]}');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('same file more than once'),
      expect.objectContaining({ count: 1 }),
    );
  });
});

describe('CloudFolderIngestService access token', () => {
  it('renews a token that is about to run out before downloading, and downloads with the new one', async () => {
    const { service, googleClient, connections, ledger } = build(REMOTE, DRIVE_TREE);
    ledger.claimSettled.mockResolvedValue([folder({ provider: 'google_drive', rootPath: '/meta' })]);
    const expiring = {
      id: 'conn-1',
      userId: 'user-1',
      accessToken: 'old',
      refreshToken: 'refresh',
      tokenExpiry: new Date(Date.now() + 60_000),
    } as never;

    await service.ingestSettledDriveFolders({ connection: expiring, userId: 'user-1' });

    expect(googleClient.refreshAccessToken).toHaveBeenCalledTimes(1);
    // A null refresh token from the provider must not wipe the stored one.
    expect(connections.update).toHaveBeenCalledWith(
      { userId: 'user-1' },
      'conn-1',
      expect.not.objectContaining({ refreshToken: null }),
    );
    expect(googleClient.requestRaw).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'renewed' }),
      expect.stringContaining('alt=media'),
    );
    expect(ledger.markImported).toHaveBeenCalled();
  });

  it('leaves a token with plenty of time left alone', async () => {
    const { service, googleClient, ledger } = build(REMOTE, DRIVE_TREE);
    ledger.claimSettled.mockResolvedValue([folder({ provider: 'google_drive', rootPath: '/meta' })]);
    const fresh = {
      id: 'conn-1',
      userId: 'user-1',
      accessToken: 'old',
      refreshToken: 'refresh',
      tokenExpiry: new Date(Date.now() + 3_000_000),
    } as never;

    await service.ingestSettledDriveFolders({ connection: fresh, userId: 'user-1' });

    expect(googleClient.refreshAccessToken).not.toHaveBeenCalled();
  });
});

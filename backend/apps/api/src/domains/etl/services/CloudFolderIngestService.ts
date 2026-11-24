import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';
import { ConnectionService, DropboxClient, GoogleClient, type Connection } from '@ci/domains/connections';
import { FileService } from '@ci/domains/files';
import {
  ImportRunService,
  listingHasRecords,
  recognizeListingRoots,
  sanitizeFilename,
  StagedSourceService,
  uploadsRoot,
} from '@ci/domains/import';

import type { CloudFolderExport } from '../entities/CloudFolderExportEntity';

import { DROPBOX_PROVIDER, GOOGLE_DRIVE_PROVIDER } from './CloudFileIngestService';
import { CloudFolderExportLedgerService } from './CloudFolderExportLedgerService';
import { dropboxWebLink } from './Dropbox/dropboxWebLink';

/** How deep under the drive's root an export folder may sit. Meta's is four down. */
const EXPORT_ROOT_MAX_DEPTH = 10;

/** Files fetched at once while downloading a folder. */
const DOWNLOAD_CONCURRENCY = 4;

/** Heartbeat the ledger row every this many files, so a long download is not taken for dead. */
const HEARTBEAT_EVERY_FILES = 25;

/**
 * A download is given a new access token once its own has less than this
 * left. A Google token lasts an hour and an export can take longer than what
 * remains of it; without this the folder fails part-way and starts again.
 */
const TOKEN_REFRESH_MARGIN_MS = 10 * 60 * 1000;

/** Tries per file before one bad response is allowed to fail the whole folder. */
const FILE_DOWNLOAD_ATTEMPTS = 3;

/**
 * The folder Meta creates for ONE transfer ("meta-2026-Oct-05-10-12-25"). A
 * large export arrives inside it as several part folders
 * (facebook-<user>-<date>-<id>), the same split Meta makes into several zips:
 * each part repeats the top of the tree and holds a different share of the
 * files, so a conversation's messages can sit in one part and its photos in
 * another. The parts only mean something laid over each other, so the unit
 * that is recognised, downloaded and imported is the transfer folder.
 */
const META_TRANSFER_FOLDER_RE = /^meta-\d{4}-[a-z]{3}-\d{2}(-|$)/i;

/** Drive folders listed at once while walking an export folder. */
const DRIVE_LIST_CONCURRENCY = 4;

/** Folder lookups made at once while working out where a page's files sit. */
const DRIVE_ANCESTRY_CONCURRENCY = 8;

/** How long a Drive folder's name and parent are trusted before being asked for again. */
const DRIVE_FOLDER_CACHE_MS = 10 * 60 * 1000;
const DRIVE_FOLDER_CACHE_MAX = 50_000;

/** Longest chain of parents followed; a real tree is nowhere near, a cycle would be. */
const DRIVE_MAX_ANCESTORS = 40;

const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

/** A stream or fetch failure is not always an `Error` of this realm; keep whatever it says. */
function errorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;

  return typeof message === 'string' && message ? message : String(error);
}

/** A download failure that trying again will not fix. */
class PermanentDownloadError extends Error {}

/** A file as a sync listing describes it, reduced to what folder handling needs. */
export interface CloudListedFile {
  /** The provider's normalized path (Dropbox: `path_lower`), with a leading slash. */
  path: string;
}

/**
 * A Drive file as a sync listing describes it. Drive has no paths: a file
 * knows its name and the id of the folder it is in, and nothing above that.
 */
export interface DriveListedFile {
  id: string;
  name: string;
  /** Absent for a file that is in no folder of this drive (shared with the person). */
  parents?: string[];
}

/** One listed file, in the two spellings folder handling needs. */
interface ClaimCandidate<T> {
  file: T;
  /**
   * What the ledger's `root_path` is a prefix of. Must be stable and unique:
   * Dropbox's `path_lower`; for Drive the chain of folder ids, because two
   * Drive folders can share a name.
   */
  path: string;
  /** The same path as the names an importer's recogniser looks for. */
  namedPath: string;
}

function segments(posixPath: string): string[] {
  return posixPath.split('/').filter((part) => part.length > 0);
}

/**
 * A Drive name as one path segment. Drive allows a slash in a name, and
 * allows `.` and `..` as names; a path allows none of those.
 */
function driveSegment(name: string | undefined): string {
  const safe = (name ?? '').replace(/[\\/\0]/g, '_');

  return safe === '' || safe === '.' || safe === '..' ? '_' : safe;
}

async function eachLimited<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];

  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
        await task(item);
      }
    }),
  );
}

/** One file of an export folder, as listed fresh at download time. */
interface FolderFile {
  id: string;
  /** Path relative to the export folder, in the provider's display casing. */
  relativePath: string;
  size: number;
  /** The pointer row a sync may have written for this file before the folder was recognised. */
  pointerExternalId: string | null;
}

/**
 * The connection a download is using. Held by reference so that a token
 * renewed part-way through reaches the requests still to be made.
 */
interface CloudSession {
  connection: Connection;
  client: Pick<DropboxClient | GoogleClient, 'refreshAccessToken'>;
  renewing?: Promise<void>;
}

/** The provider-specific half: how to list a folder and fetch a file. */
interface CloudFolderSource {
  provider: string;
  label: string;
  session: CloudSession;
  /** The folder's own name, and every file under it. */
  list(rootPath: string): Promise<{ name: string; files: FolderFile[] }>;
  download(fileId: string): Promise<Response>;
}

interface DriveEntry {
  id: string;
  name?: string;
  mimeType?: string;
  size?: string;
  webViewLink?: string;
  parents?: string[];
}

interface DriveFolderInfo {
  name: string;
  /** Null for a folder that is in no other: My Drive itself, or the top of something shared. */
  parent: string | null;
  at: number;
}

interface DropboxEntry {
  '.tag': string;
  id: string;
  name: string;
  path_display?: string;
  path_lower?: string;
  size?: number;
}

/**
 * Data exports that sit in a cloud drive as a FOLDER of loose files.
 *
 * Meta's "transfer a copy of your information" writes a Facebook export into
 * Dropbox this way — hundreds or thousands of individual files under
 * `/Apps/Meta/meta-<date>/facebook-<user>-<date>-<id>/`, written a few at a
 * time over the better part of an hour. Handled file by file they would each
 * become a pointer row and the export would never be imported; and the folder
 * cannot be imported until it is whole, or its media arrives with no message
 * or post to attach to.
 *
 * So, in three steps spread over several sync ticks:
 *
 *  1. {@link claimFiles} — as a sync lists files, the folders an importer
 *     recognises (the same recognisers a zip's listing is run past, see
 *     recognizeListingRoots) are recorded, and their files are withheld from
 *     ordinary per-file handling.
 *  2. The folder waits until no sync has seen it change for FOLDER_SETTLE_MS.
 *  3. {@link ingestSettled} — the whole folder is downloaded into one drop,
 *     structure intact, and handed to the import pipeline as ONE run, exactly
 *     as if the person had dropped that folder on the import page.
 *
 * Dropbox and Google Drive are wired. Dropbox lists paths; Drive lists a name
 * and a parent folder id per file, so its paths are worked out here, a lookup
 * per folder (see {@link claimDriveFiles}).
 *
 * A Meta transfer that arrives as several part folders is one export, rooted
 * at the transfer folder and downloaded with its parts laid over each other
 * (see META_TRANSFER_FOLDER_RE).
 */
@Injectable()
export class CloudFolderIngestService {
  /** `<connection id>:<folder id>` → that Drive folder's name and parent. */
  private readonly driveFolders = new Map<string, DriveFolderInfo>();

  constructor(
    private readonly dropboxClient: DropboxClient,
    private readonly googleClient: GoogleClient,
    private readonly connections: ConnectionService,
    private readonly stagedSources: StagedSourceService,
    private readonly importRuns: ImportRunService,
    private readonly fileService: FileService,
    private readonly ledger: CloudFolderExportLedgerService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(CloudFolderIngestService.name);
  }

  /**
   * Which of these freshly listed Dropbox files belong to an export folder —
   * one already known, or one recognised just now from this listing. The
   * caller leaves those files alone; everything else is an ordinary file.
   *
   * Recognition failing is not a reason to fail the sync: the files are then
   * simply treated as ordinary ones, as they were before this existed.
   */
  async claimDropboxFiles<T extends CloudListedFile>({
    connection,
    userId,
    files,
  }: {
    connection: Connection;
    userId: string;
    files: T[];
  }): Promise<Set<T>> {
    return this.claimFiles(
      { connectionId: connection.id, provider: DROPBOX_PROVIDER },
      'Dropbox',
      userId,
      // Dropbox's path is both things at once: unique, and made of names.
      () => files.map((file) => ({ file, path: file.path, namedPath: file.path })),
    );
  }

  /**
   * {@link claimDropboxFiles} for Drive. `folders` are the folder entries of
   * the same listing, if any: each one seen there is a lookup saved.
   *
   * A file's place is the chain of folders above it, found by asking Drive
   * for each folder's name and parent once and remembering the answer; a
   * listing page's files share a handful of folders, so this is a few
   * requests a page, not one per file. A file the listing gave no parent for
   * is in no folder, and so in no export folder.
   */
  async claimDriveFiles<T extends DriveListedFile>({
    connection,
    userId,
    files,
    folders = [],
  }: {
    connection: Connection;
    userId: string;
    files: T[];
    folders?: DriveListedFile[];
  }): Promise<Set<T>> {
    return this.claimFiles(
      { connectionId: connection.id, provider: GOOGLE_DRIVE_PROVIDER },
      'Drive',
      userId,
      async () => {
        // The lookups below are requests of their own, and a transform is
        // handed whatever token the last sync left behind. With a dead one
        // every lookup fails and a page of export files would be taken for
        // ordinary ones.
        const session: CloudSession = { connection, client: this.googleClient };
        await this.keepAuthorised(session);
        connection = session.connection;

        const now = Date.now();
        for (const folder of folders) {
          if (folder.parents?.[0]) {
            this.rememberDriveFolder(connection, folder.id, {
              name: folder.name,
              parent: folder.parents[0],
              at: now,
            });
          }
        }

        const chains = new Map<string, { ids: string[]; names: string[] }>();
        const parentIds = [
          ...new Set(files.map((file) => file.parents?.[0]).filter((id): id is string => !!id)),
        ];

        await eachLimited(parentIds, DRIVE_ANCESTRY_CONCURRENCY, async (folderId) => {
          chains.set(folderId, await this.driveFolderChain(connection, folderId));
        });

        const candidates: Array<ClaimCandidate<T>> = [];
        for (const file of files) {
          const chain = file.parents?.[0] ? chains.get(file.parents[0]) : undefined;

          if (chain) {
            candidates.push({
              file,
              path: `/${[...chain.ids, file.id].join('/')}`,
              namedPath: `/${[...chain.names, driveSegment(file.name)].join('/')}`,
            });
          }
        }

        return candidates;
      },
    );
  }

  /**
   * The folders above a Drive folder and the folder itself, outermost first,
   * as ids and as names. The one folder that is in no other — My Drive, or
   * the top of a tree someone shared — is left off: it is where paths start.
   */
  private async driveFolderChain(
    connection: Connection,
    folderId: string,
  ): Promise<{ ids: string[]; names: string[] }> {
    const ids: string[] = [];
    const names: string[] = [];

    for (let id: string | null = folderId; id;) {
      if (ids.length >= DRIVE_MAX_ANCESTORS) {
        throw new Error(`Drive folder ${folderId} has more than ${DRIVE_MAX_ANCESTORS} folders above it`);
      }

      const info: DriveFolderInfo = await this.driveFolder(connection, id);

      if (info.parent == null) {
        break;
      }

      ids.unshift(id);
      names.unshift(driveSegment(info.name));
      id = info.parent;
    }

    return { ids, names };
  }

  private async driveFolder(connection: Connection, folderId: string): Promise<DriveFolderInfo> {
    const cached = this.driveFolders.get(`${connection.id}:${folderId}`);

    if (cached && Date.now() - cached.at < DRIVE_FOLDER_CACHE_MS) {
      return cached;
    }

    const entry = await this.googleClient.request<DriveEntry>(
      connection,
      `/drive/v3/files/${encodeURIComponent(folderId)}?fields=id,name,parents`,
    );

    return this.rememberDriveFolder(connection, folderId, {
      name: entry.name ?? '',
      parent: entry.parents?.[0] ?? null,
      at: Date.now(),
    });
  }

  private rememberDriveFolder(
    connection: Connection,
    folderId: string,
    info: DriveFolderInfo,
  ): DriveFolderInfo {
    if (this.driveFolders.size >= DRIVE_FOLDER_CACHE_MAX) {
      this.driveFolders.clear();
    }

    this.driveFolders.set(`${connection.id}:${folderId}`, info);

    return info;
  }

  /**
   * The provider-neutral claim. `listCandidates` is a function so that a
   * provider's own failure to place its files (a Drive folder lookup that
   * errors) is caught here with everything else.
   */
  private async claimFiles<T>(
    key: { connectionId: string; provider: string },
    label: string,
    userId: string,
    listCandidates: () => Array<ClaimCandidate<T>> | Promise<Array<ClaimCandidate<T>>>,
  ): Promise<Set<T>> {
    const claimed = new Set<T>();

    try {
      const candidates = await listCandidates();

      if (candidates.length === 0) {
        return claimed;
      }

      const importersByRoot = new Map<string, string[]>();
      for (const known of await this.ledger.listForConnection({ userId }, key)) {
        importersByRoot.set(known.rootPath, known.importers);
      }

      const under = (root: string, candidate: ClaimCandidate<T>): boolean =>
        candidate.path.startsWith(`${root}/`);
      const unclaimed = candidates.filter(
        (candidate) => ![...importersByRoot.keys()].some((root) => under(root, candidate)),
      );

      if (unclaimed.length > 0) {
        const recognised = await recognizeListingRoots(
          unclaimed.map((candidate) => candidate.namedPath),
          { maxDepth: EXPORT_ROOT_MAX_DEPTH },
        );

        for (const { root: recognisedRoot, importers } of recognised) {
          // One part of a Meta transfer stands for the whole transfer folder.
          const parent = path.posix.dirname(recognisedRoot);
          const root = META_TRANSFER_FOLDER_RE.test(path.posix.basename(parent)) ? parent : recognisedRoot;

          // `''` would be the person's entire drive. No export is written
          // there, and treating it as one would download everything they own.
          if (root === '' || root === '.') {
            continue;
          }

          // From the folder's names to its unique path: the same number of
          // segments off the front of a file inside it. Two same-named Drive
          // folders come out as two roots, which is what they are.
          const depth = segments(root).length;
          for (const candidate of unclaimed) {
            if (!candidate.namedPath.startsWith(`/${root}/`)) {
              continue;
            }

            const rootPath = `/${segments(candidate.path).slice(0, depth).join('/')}`;
            const already = importersByRoot.get(rootPath) ?? [];

            importersByRoot.set(rootPath, [
              ...already,
              ...importers.filter((name) => !already.includes(name)),
            ]);
          }
        }
      }

      for (const [root, importers] of importersByRoot) {
        const members = candidates.filter((candidate) => under(root, candidate));

        if (members.length === 0) {
          continue;
        }

        await this.ledger.recordChange({ userId }, { ...key, rootPath: root, importers });
        members.forEach((candidate) => claimed.add(candidate.file));
      }
    } catch (error) {
      this.logger.warn(`Could not check ${label} files for export folders; treating them as ordinary files`, {
        connectionId: key.connectionId,
        error: errorMessage(error),
      });

      return new Set<T>();
    }

    return claimed;
  }

  /**
   * Download every export folder of this connection that has settled, and
   * start an import run for each. Resolves when they have all finished, and
   * never rejects.
   *
   * The SYNC does not await this: a full export with media is thousands of
   * files and can outlast the sync job that noticed it, so the transform
   * starts it and moves on. A download that dies with the process is picked
   * up again by a later tick (see FOLDER_DOWNLOAD_STALE_MS).
   */
  async ingestSettledDropboxFolders({
    connection,
    userId,
  }: {
    connection: Connection;
    userId: string;
  }): Promise<void> {
    await this.ingestSettled(
      this.dropboxSource({ connection, client: this.dropboxClient }),
      connection,
      userId,
    );
  }

  /** {@link ingestSettledDropboxFolders} for Drive. */
  async ingestSettledDriveFolders({
    connection,
    userId,
  }: {
    connection: Connection;
    userId: string;
  }): Promise<void> {
    await this.ingestSettled(this.driveSource({ connection, client: this.googleClient }), connection, userId);
  }

  private async ingestSettled(
    source: CloudFolderSource,
    connection: Connection,
    userId: string,
  ): Promise<void> {
    const key = { connectionId: connection.id, provider: source.provider };
    let ready: CloudFolderExport[];

    try {
      ready = await this.ledger.claimSettled({ userId }, key);
    } catch (error) {
      this.logger.warn(`Could not check for settled ${source.label} export folders`, {
        connectionId: connection.id,
        error: errorMessage(error),
      });

      return;
    }

    await Promise.all(ready.map((folder) => this.ingestFolder(source, userId, folder)));
  }

  /**
   * Renew the session's access token if it is about to run out. The sync that
   * started this download only renews a token that has ALREADY expired, so
   * the one handed over may have minutes left. Failing to renew is not fatal
   * here: the requests that follow say so themselves if the token really is
   * dead.
   */
  private async keepAuthorised(session: CloudSession): Promise<void> {
    const { refreshToken, tokenExpiry } = session.connection;

    if (
      !refreshToken ||
      !tokenExpiry ||
      new Date(tokenExpiry).getTime() - Date.now() > TOKEN_REFRESH_MARGIN_MS
    ) {
      return;
    }

    // Several files finish at once; one renewal serves them all.
    session.renewing ??= (async () => {
      try {
        const renewed = await session.client.refreshAccessToken(session.connection);
        // Some providers answer a null refresh token, meaning "keep yours".
        const { refreshToken: newRefreshToken, ...rest } = renewed;
        const updated = await this.connections.update(
          { userId: session.connection.userId },
          session.connection.id,
          newRefreshToken == null ? rest : renewed,
        );

        if (updated) {
          session.connection = updated;
        }
      } catch (error) {
        this.logger.warn('Could not renew the access token during an export folder download', {
          connectionId: session.connection.id,
          error: errorMessage(error),
        });
      } finally {
        session.renewing = undefined;
      }
    })();

    await session.renewing;
  }

  private dropboxSource(session: CloudSession): CloudFolderSource {
    return {
      provider: DROPBOX_PROVIDER,
      label: 'Dropbox',
      session,
      list: async (rootPath) => {
        const files: FolderFile[] = [];
        let page = await this.dropboxClient.rpc<{
          entries: DropboxEntry[];
          cursor: string;
          has_more: boolean;
        }>(session.connection, '/2/files/list_folder', {
          path: rootPath,
          recursive: true,
          include_deleted: false,
          include_non_downloadable_files: false,
        });

        for (;;) {
          for (const entry of page.entries) {
            if (
              entry['.tag'] !== 'file' ||
              !entry.path_display ||
              !entry.path_lower?.startsWith(`${rootPath}/`)
            ) {
              continue;
            }

            files.push({
              id: entry.id,
              // Same length as path_lower, so the root's length cuts the
              // display path at the same place.
              relativePath: entry.path_display.slice(rootPath.length + 1),
              size: entry.size ?? 0,
              pointerExternalId: dropboxWebLink(entry),
            });
          }

          if (!page.has_more) {
            return { name: path.posix.basename(rootPath), files };
          }

          page = await this.dropboxClient.rpc(session.connection, '/2/files/list_folder/continue', {
            cursor: page.cursor,
          });
        }
      },
      download: (fileId) => this.dropboxClient.download(session.connection, fileId),
    };
  }

  private driveSource(session: CloudSession): CloudFolderSource {
    return {
      provider: GOOGLE_DRIVE_PROVIDER,
      label: 'Drive',
      session,
      // Drive cannot list a folder's whole tree in one request, only one
      // folder's children; so the tree is walked, a level at a time.
      list: async (rootPath) => {
        const rootId = segments(rootPath).pop();

        if (!rootId) {
          throw new Error(`not a Drive folder path: ${rootPath}`);
        }

        const root = await this.googleClient.request<DriveEntry>(
          session.connection,
          `/drive/v3/files/${encodeURIComponent(rootId)}?fields=id,name`,
        );
        const files: FolderFile[] = [];
        const taken = new Set<string>();
        let level = [{ id: rootId, prefix: '' }];

        while (level.length > 0) {
          const next: typeof level = [];

          await eachLimited(level, DRIVE_LIST_CONCURRENCY, async (dir) => {
            let pageToken: string | undefined;

            do {
              const params = new URLSearchParams({
                q: `'${dir.id}' in parents and trashed=false`,
                pageSize: '1000',
                fields: 'nextPageToken,files(id,name,mimeType,size,webViewLink)',
              });
              if (pageToken) {
                params.set('pageToken', pageToken);
              }

              const page = await this.googleClient.request<{ files?: DriveEntry[]; nextPageToken?: string }>(
                session.connection,
                `/drive/v3/files?${params.toString()}`,
              );

              for (const entry of page.files ?? []) {
                const name = driveSegment(entry.name);

                if (entry.mimeType === DRIVE_FOLDER_MIME) {
                  next.push({ id: entry.id, prefix: `${dir.prefix}${name}/` });
                  continue;
                }

                // No size means no bytes to fetch: a native Google document,
                // or a shortcut. An export is made of neither.
                if (entry.size == null) {
                  continue;
                }

                // Drive lets two files in one folder share a name. Both are
                // kept; the second carries its id to stay a different file.
                let relativePath = `${dir.prefix}${name}`;
                if (taken.has(relativePath)) {
                  const ext = path.posix.extname(name);

                  relativePath = `${dir.prefix}${name.slice(0, name.length - ext.length)} (${entry.id})${ext}`;
                }

                taken.add(relativePath);
                files.push({
                  id: entry.id,
                  relativePath,
                  size: Number(entry.size),
                  pointerExternalId: entry.webViewLink ?? null,
                });
              }

              pageToken = page.nextPageToken;
            } while (pageToken);
          });

          level = next;
        }

        return { name: driveSegment(root.name), files };
      },
      download: (fileId) =>
        this.googleClient.requestRaw(
          session.connection,
          `/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
        ),
    };
  }

  /**
   * The files of a Meta transfer folder with its part folders laid over each
   * other: `facebook-…-abc/your_facebook_activity/x` becomes
   * `your_facebook_activity/x`. Meta puts each file in exactly one part; if
   * two parts ever do hold the same path, the first (by part name) is kept
   * and the rest are reported, never silently merged.
   */
  private mergeTransferParts(files: FolderFile[]): { files: FolderFile[]; collisions: string[] } {
    const merged = new Map<string, FolderFile>();
    const collisions: string[] = [];

    for (const file of [...files].sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1))) {
      const parts = file.relativePath.split('/');
      const relativePath = parts.length > 1 ? parts.slice(1).join('/') : file.relativePath;

      if (merged.has(relativePath)) {
        collisions.push(file.relativePath);
      } else {
        merged.set(relativePath, { ...file, relativePath });
      }
    }

    return { files: [...merged.values()], collisions };
  }

  /** Download one claimed folder and start its import run. Never throws. */
  private async ingestFolder(
    source: CloudFolderSource,
    userId: string,
    folder: CloudFolderExport,
  ): Promise<void> {
    // The claim stamped updated_at; anything a sync sees change after that
    // moment is something this download may have missed.
    const claimedAt = new Date();
    const dropId = uuidv7();
    const dropDir = path.join(uploadsRoot(), dropId);

    try {
      await this.keepAuthorised(source.session);

      const listing = await source.list(folder.rootPath);
      const folderName = sanitizeFilename(listing.name) || 'export';
      const exportDir = path.join(dropDir, folderName);
      const listed = listing.files;

      if (listed.length === 0) {
        throw new Error('the folder is empty');
      }

      const { files, collisions } = META_TRANSFER_FOLDER_RE.test(listing.name)
        ? this.mergeTransferParts(listed)
        : { files: listed, collisions: [] };

      if (collisions.length > 0) {
        this.logger.warn(`${source.label} export parts hold the same file more than once; kept the first`, {
          rootPath: folder.rootPath,
          count: collisions.length,
          examples: collisions.slice(0, 10),
        });
      }

      // Recognised by its shape, settled — and still possibly only half
      // delivered. Meta writes a transfer's attachments hours before the
      // conversations they belong to, pausing far longer than the settle
      // window in between; downloading gigabytes of media that the importer
      // then reads nothing from helps nobody. Wait for something to read.
      if (
        !listingHasRecords(
          folder.importers,
          files.map((file) => file.relativePath),
        )
      ) {
        const reason = `waiting: nothing in this folder yet that the ${folder.importers.join('/')} importer reads (${files.length} files so far)`;

        await this.ledger.markWaiting(folder.id, { fileCount: files.length, reason });
        this.logger.log(`A ${source.label} export folder is not ready to import yet`, {
          rootPath: folder.rootPath,
          folderName,
          importers: folder.importers,
          fileCount: files.length,
        });

        return;
      }

      this.logger.log(`Downloading a ${source.label} export folder`, {
        rootPath: folder.rootPath,
        folderName,
        fileCount: files.length,
        byteSize: files.reduce((sum, file) => sum + file.size, 0),
      });

      await mkdir(exportDir, { recursive: true });

      let byteSize = 0;
      let done = 0;
      const queue = [...files];

      const worker = async (): Promise<void> => {
        for (let file = queue.shift(); file; file = queue.shift()) {
          // Not `byteSize += await …`: that reads the total BEFORE the await,
          // and with several workers each would overwrite the others' sums.
          const written = await this.downloadFile(source, exportDir, file);

          byteSize += written;
          done += 1;

          if (done % HEARTBEAT_EVERY_FILES === 0) {
            await this.ledger.heartbeat(folder.id);
            await this.keepAuthorised(source.session);
          }
        }
      };

      await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, worker));

      await this.stagedSources.registerUpload(
        { userId },
        {
          dropId,
          sourcePath: exportDir,
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
          label: folderName,
          source: 'connections',
          declaredSources: folder.importers,
          originPlatform: source.provider,
          originConnectionId: folder.connectionId,
        },
      );

      await this.ledger.markImported(folder.id, {
        claimedAt,
        fileCount: files.length,
        byteSize,
        dropId,
        importRunId: run.id,
      });

      // Files of this folder that a sync listed before the folder was
      // recognised were written as ordinary pointer rows. The import run now
      // owns them.
      const pointers = listed.map((file) => file.pointerExternalId).filter((id): id is string => id != null);
      const removed = await this.fileService.removePointersByExternalIds({ userId }, pointers).catch(() => 0);

      this.logger.log(`Downloaded a ${source.label} export folder and started an import run for it`, {
        rootPath: folder.rootPath,
        folderName,
        importers: folder.importers,
        fileCount: files.length,
        byteSize,
        dropId,
        runId: run.id,
        pointerRowsRemoved: removed,
      });
    } catch (error) {
      const reason = errorMessage(error);

      await rm(dropDir, { recursive: true, force: true }).catch(() => undefined);
      await this.ledger.markFailed(folder.id, reason).catch(() => undefined);

      this.logger.warn(`${source.label} export folder download failed; it will be retried`, {
        rootPath: folder.rootPath,
        error: reason,
      });
    }
  }

  /**
   * {@link downloadFileOnce}, tried again on failure. One refused request in
   * several thousand must not throw away a folder that is otherwise here.
   */
  private async downloadFile(
    source: CloudFolderSource,
    exportDir: string,
    file: FolderFile,
  ): Promise<number> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.downloadFileOnce(source, exportDir, file);
      } catch (error) {
        if (attempt >= FILE_DOWNLOAD_ATTEMPTS || error instanceof PermanentDownloadError) {
          throw error;
        }

        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  }

  /** Stream one file to its place under `exportDir`; returns the bytes written. */
  private async downloadFileOnce(
    source: CloudFolderSource,
    exportDir: string,
    file: FolderFile,
  ): Promise<number> {
    const target = path.resolve(exportDir, ...file.relativePath.split('/'));

    // The path comes from the provider, not from us. Nothing is written
    // outside the export's own directory, whatever it says.
    if (!target.startsWith(exportDir + path.sep)) {
      throw new PermanentDownloadError(`refusing to write outside the export folder: ${file.relativePath}`);
    }

    const response = await source.download(file.id);

    if (!response.ok || response.body == null) {
      const message = `${source.label} download of ${file.relativePath} failed: ${response.status} ${response.statusText}`;

      // Asking again does not change a refusal (an expired token, a file that
      // has gone); it can change a rate limit or a server error.
      throw response.status >= 400 && response.status < 500 && response.status !== 429
        ? new PermanentDownloadError(message)
        : new Error(message);
    }

    await mkdir(path.dirname(target), { recursive: true });

    let written = 0;

    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          written += chunk.length;
          callback(null, chunk);
        },
      }),
      createWriteStream(target),
    );

    if (written !== file.size) {
      throw new Error(
        `${source.label} download of ${file.relativePath} ended at ${written} of ${file.size} bytes`,
      );
    }

    return written;
  }
}

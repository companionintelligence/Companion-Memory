import { mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  NotFoundException,
  Param,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
  type OnModuleInit,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { v7 as uuidv7 } from 'uuid';

import { Context, type RequestContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import config from '@ci/configuration';

import { StagedSourceService } from '../services/StagedSourceService';
import { sanitizeRelativePath, sanitizeUploadName } from '../sources/sanitizeFilename';

/**
 * Ceiling on a single uploaded archive. Real exports are large — Google Takeout
 * splits run 40-50GB — so this is a sanity bound on one file, not a policy about
 * how much someone may import.
 */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024 * 1024;

/** Ceiling on files inside one dropped folder. Unzipped Takeout belongs in a zip. */
const MAX_DIRECTORY_FILES = 10_000;

/** What the caller gets back per uploaded file. */
export interface DropSummary {
  dropId: string;
  originalFilename: string | null;
  sizeBytes: number | null;
  status: string;
  expiresAt: Date | null;
}

/**
 * Intake for bulk exports: bytes in, a registered staged upload out.
 *
 * Upload and import are deliberately separate steps. The upload lands the
 * archive in the importer's own uploads directory and registers it; nothing is
 * unpacked, recognized or parsed here. That happens later, in the run's
 * `unpack` stage — which MOVES the staged copy into the run's scratch, so the
 * bytes are written once and never copied again — because a 40GB Takeout
 * cannot be expanded inside a request and because the user has not yet said
 * what they want done with it.
 *
 * Starting that import is `POST /import/runs` on {@link ImportRunsController},
 * which owns the run surface. This controller ends at the registered upload.
 */
/** Where multer lands the bytes before they hop into a drop directory. */
function incomingDir(): string {
  return path.join(config.import.uploadsDir, 'incoming');
}

@Controller('import/uploads')
export class ImportUploadsController implements OnModuleInit {
  constructor(private readonly sources: StagedSourceService) {}

  /**
   * Prepare the incoming directory, best-effort, so the first upload does not
   * pay the mkdir and a misconfigured deployment says so ONCE, legibly, at
   * boot. Never throws: an unwritable uploads directory must cost the upload
   * routes, not take the whole API down with it.
   */
  async onModuleInit(): Promise<void> {
    try {
      await mkdir(incomingDir(), { recursive: true });
    } catch (err: unknown) {
      Logger.warn(
        `The uploads staging directory is not writable (${(err as Error).message}). ` +
          `Uploads will fail until CI_IMPORT_UPLOADS_DIR points somewhere this process can write.`,
        ImportUploadsController.name,
      );
    }
  }

  /**
   * Stage one or more uploaded files.
   *
   * Multer writes to `<uploadsDir>/incoming` rather than a buffer, so a
   * multi-GB upload never sits in the heap — and rather than the OS tmpdir,
   * so the hop into `<uploadsDir>/<dropId>/` is an atomic same-filesystem
   * rename instead of a copy across the container boundary (the uploads dir
   * is a bind mount; `tmpdir()` is not). A crash between multer's write and
   * the rename, or between the rename and the registration, leaves bytes only
   * the orphan sweep can see — which is exactly what the sweep is for.
   *
   * The destination is a FUNCTION, deliberately. Multer given a string `dest`
   * mkdirs it while the class is still being DEFINED, which turns an
   * unwritable directory into a boot failure for the entire API — the
   * importer being unavailable must never cost more than the importer. With a
   * function, the filesystem is first touched when an upload arrives, and a
   * failure is this route's error response.
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Post()
  @UseInterceptors(
    FilesInterceptor('files', undefined, {
      storage: diskStorage({
        destination: (_req, _file, callback) => {
          mkdir(incomingDir(), { recursive: true }).then(
            () => callback(null, incomingDir()),
            (err: Error) => callback(err, incomingDir()),
          );
        },
      }),
      limits: { fileSize: MAX_UPLOAD_BYTES },
      // Browsers send the file name as raw UTF-8. Multer reads it as latin1
      // unless told otherwise, so `José.txt` arrived as `JosÃ©.txt`.
      defParamCharset: 'utf8',
    }),
  )
  async upload(
    @Context() context: RequestContext,
    @UploadedFiles() files: Express.Multer.File[],
    @Body() body?: { paths?: string | string[] },
  ): Promise<DropSummary[]> {
    const userId = requireUserId(context);

    if (!files || files.length === 0) {
      throw new BadRequestException('At least one file is required');
    }

    const paths = asStringList(body?.paths);

    try {
      if (paths.length > 0) {
        return [await this.stageDirectory(userId, files, paths)];
      }

      const staged: DropSummary[] = [];

      // Sequential, not Promise.all: a multi-part export arriving at once
      // should settle into the registry in a stable order, and there is no
      // wall-clock win to parallel renames on one filesystem.
      for (const file of files) {
        staged.push(await this.stageFile(userId, file));
      }

      return staged;
    } finally {
      // On success every file was renamed away and these unlinks no-op; on
      // failure the incoming copies must not sit until the orphan sweep.
      for (const file of files) {
        if (file.path) {
          await unlink(file.path).catch((err: NodeJS.ErrnoException) => {
            if (err.code !== 'ENOENT') {
              Logger.error(`Failed to delete incoming upload ${file.path}`, ImportUploadsController.name);
            }
          });
        }
      }
    }
  }

  /** Uploads still awaiting an import decision. */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get()
  async list(@Context() context: RequestContext): Promise<DropSummary[]> {
    const userId = requireUserId(context);
    const uploads = await this.sources.listStagedUploads({ userId });

    return uploads.map(toSummary);
  }

  /**
   * Discard a staged upload and reclaim its bytes, or dismiss an expired
   * tombstone. An upload a run has CLAIMED is refused — deleting bytes out
   * from under a running unpack is a race, not a cleanup; cancel the run
   * instead.
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Delete(':dropId')
  async remove(
    @Context() context: RequestContext,
    @Param('dropId') dropId: string,
  ): Promise<{ released: boolean }> {
    const userId = requireUserId(context);
    const released = await this.sources.releaseUpload({ userId }, dropId);

    if (!released) {
      throw new NotFoundException(`No staged upload ${dropId}`);
    }

    return { released };
  }

  private async stageFile(userId: string, file: Express.Multer.File): Promise<DropSummary> {
    const dropId = uuidv7();
    // The name is attacker-controlled text landing on a real filesystem;
    // sanitizing it is containment, not cosmetics. It keeps its spaces:
    // importers recognize `My Clippings.txt` and the like by name.
    const filename = sanitizeUploadName(file.originalname);
    const dropDir = path.join(config.import.uploadsDir, dropId);
    const sourcePath = path.join(dropDir, filename);

    await mkdir(dropDir, { recursive: true });
    await rename(file.path, sourcePath);

    const source = await this.sources.registerUpload(
      { userId },
      {
        dropId,
        sourcePath,
        originalFilename: file.originalname,
        contentType: file.mimetype,
        sizeBytes: file.size,
      },
    );

    return toSummary(source);
  }

  /**
   * One drop for a whole folder: files land under `<uploadsDir>/<dropId>/`
   * at their relative paths, and the staged source is the root folder so
   * unpack can move the tree the same way an inbox directory unit does.
   */
  private async stageDirectory(
    userId: string,
    files: Express.Multer.File[],
    rawPaths: string[],
  ): Promise<DropSummary> {
    if (rawPaths.length !== files.length) {
      throw new BadRequestException('Each uploaded file needs a relative path');
    }

    if (files.length > MAX_DIRECTORY_FILES) {
      throw new BadRequestException(
        `A folder upload cannot contain more than ${MAX_DIRECTORY_FILES} files — zip the export instead`,
      );
    }

    const dropId = uuidv7();
    const dropDir = path.join(config.import.uploadsDir, dropId);
    const dropRoot = path.resolve(dropDir);

    await mkdir(dropDir, { recursive: true });

    let sizeBytes = 0;
    let rootName: string | null = null;

    for (let i = 0; i < files.length; i += 1) {
      let relative: string;

      try {
        relative = sanitizeRelativePath(rawPaths[i]);
      } catch (err: unknown) {
        throw new BadRequestException(err instanceof Error ? err.message : 'Invalid relative path');
      }

      const segments = relative.split('/');
      rootName ??= segments[0];
      const dest = path.resolve(dropDir, ...segments);

      if (dest !== dropRoot && !dest.startsWith(`${dropRoot}${path.sep}`)) {
        throw new BadRequestException('Path escapes the upload directory');
      }

      await mkdir(path.dirname(dest), { recursive: true });
      await rename(files[i].path, dest);
      sizeBytes += files[i].size;
    }

    const folder = rootName ?? 'export';
    const sourcePath = path.join(dropDir, folder);
    const source = await this.sources.registerUpload(
      { userId },
      {
        dropId,
        sourcePath,
        originalFilename: folder,
        contentType: 'application/x-directory',
        sizeBytes,
        kind: 'directory',
      },
    );

    return toSummary(source);
  }
}

function asStringList(value: string | string[] | undefined): string[] {
  if (value == null) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function requireUserId(context: RequestContext): string {
  if (!context.userId) {
    throw new BadRequestException('An authenticated user is required to stage an upload');
  }

  return context.userId;
}

function toSummary(source: {
  dropId: string | null;
  originalFilename: string | null;
  sizeBytes: number | null;
  status: string;
  expiresAt: Date | null;
}): DropSummary {
  return {
    dropId: source.dropId ?? '',
    originalFilename: source.originalFilename,
    sizeBytes: source.sizeBytes,
    status: source.status,
    expiresAt: source.expiresAt,
  };
}

import { Injectable } from '@nestjs/common';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { FileService, FileVariant } from '@ci/domains/files';

import { Loader } from './Loader';

/**
 * The binary behind a `ci.content` row whose `external_id` is a `ci.files.id`:
 * the PREVIEW variant's URL (the thumbnail, when one has been generated), the
 * ORIGINAL's URL, and the ORIGINAL's content type, filename and byte size.
 */
export interface ContentFileMedia {
  previewUrl: string | null;
  mediaUrl: string | null;
  /** The PLAYBACK variant's URL when one exists — see EventMedia.playbackUrl. */
  playbackUrl: string | null;
  playbackContentType: string | null;
  contentType: string | null;
  filename: string | null;
  size: number | null;
}

/**
 * Batch-resolves `ci.content.external_id -> ci.files` (plus that file's PREVIEW
 * variant) for GraphQL, keyed by the file id the content row carries.
 *
 * Media content rows store no `url`/`source_url` at all — the binary is only
 * reachable through `external_id`, which for `external_id_kind = 'file'` holds a
 * `ci.files.id` (there is no FK). {@link EventMediaLoader} already walks
 * event -> content -> ORIGINAL -> PREVIEW; this is the same last two hops
 * starting from a content row instead, so a page of N content rows costs two
 * queries rather than 2N.
 *
 * Keyed by file id (not content id) so it collapses naturally when several
 * content rows point at the same binary.
 */
@Injectable()
export class ContentFileLoader extends Loader<ContentFileMedia | null, string> {
  constructor(
    private readonly fileService: FileService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(ContentFileLoader.name);
  }

  protected async batchLoad(
    context: UserServiceContext,
    fileIds: readonly string[],
  ): Promise<readonly (ContentFileMedia | null)[]> {
    const ids = [...fileIds];

    const [originals, previews, playbacks] = await Promise.all([
      this.fileService.findByIds(context, ids),
      this.fileService.findVariantsByParentIds(context, ids, FileVariant.PREVIEW),
      this.fileService.findVariantsByParentIds(context, ids, FileVariant.PLAYBACK),
    ]);

    // Indexed by id rather than zipped by position, for the same reason
    // AttachmentFileLoader does: a positional zip is correct only for as long
    // as FileService keeps re-keying, and nothing here would notice if it
    // stopped — the page would just render other files' thumbnails.
    const originalById = new Map(originals.filter((file) => file != null).map((file) => [file.id, file]));
    const previewByParent = new Map(
      previews.filter((file) => file != null).map((file) => [file.parentId, file]),
    );
    const playbackByParent = new Map(
      playbacks.filter((file) => file != null).map((file) => [file.parentId, file]),
    );

    return ids.map((id) => {
      const original = originalById.get(id) ?? null;
      const preview = previewByParent.get(id) ?? null;
      const playback = playbackByParent.get(id) ?? null;

      // An external_id that resolves to neither an original nor a preview is
      // not a file reference we can render (a purged blob, or an opaque
      // source-native id that merely happens to be UUID-shaped).
      if (original == null && preview == null) {
        return null;
      }

      return {
        previewUrl: preview?.url ?? null,
        mediaUrl: original?.url ?? null,
        playbackUrl: playback?.url ?? null,
        playbackContentType: playback?.contentType ?? null,
        contentType: original?.contentType ?? null,
        filename: original?.filename ?? null,
        size: original?.size != null ? Number(original.size) : null,
      };
    });
  }
}

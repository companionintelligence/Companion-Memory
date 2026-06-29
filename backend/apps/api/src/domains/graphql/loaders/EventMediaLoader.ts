import { Injectable } from '@nestjs/common';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { FileService, FileVariant } from '@ci/domains/files';
import { ContentService } from '@ci/domains/memory';

import { Loader } from './Loader';

/**
 * A photo/video event's resolved media: the thumbnail + full-resolution signed
 * URLs and the original's dimensions/size. `null` for non-media events.
 */
export interface EventMedia {
  previewUrl: string | null;
  mediaUrl: string | null;
  contentType: string | null;
  width: number | null;
  height: number | null;
  size: number | null;
}

/**
 * Batch-resolves the media linked to a set of events for GraphQL.
 *
 * Photo/video events store their binary out-of-band: the importer's media pass
 * writes a `ci.content` row (type='media', external_id = the ORIGINAL `ci.files`
 * id) alongside the timeline event, and a thumbnail lives in that file's PREVIEW
 * variant (`parent_id` = original id). This loader walks
 *   event -> content -> ORIGINAL file -> PREVIEW file
 * with each hop batched once per request, so a page of N events costs three
 * queries, not 3N. Mirrors {@link PreviewLoader} but starts from an event id.
 */
@Injectable()
export class EventMediaLoader extends Loader<EventMedia | null, string> {
  constructor(
    private readonly contentService: ContentService,
    private readonly fileService: FileService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(EventMediaLoader.name);
  }

  protected async batchLoad(
    context: UserServiceContext,
    eventIds: readonly string[],
  ): Promise<readonly (EventMedia | null)[]> {
    const links = await this.contentService.findMediaFilesByEventIds(context, [...eventIds]);

    // One media file per event — the oldest content row wins, which is stable
    // for burst sequences that share an event.
    const fileIdByEvent = new Map<string, string>();
    const mimetypeByEvent = new Map<string, string | null>();

    for (const link of links) {
      if (link.fileId && !fileIdByEvent.has(link.eventId)) {
        fileIdByEvent.set(link.eventId, link.fileId);
        mimetypeByEvent.set(link.eventId, link.mimetype);
      }
    }

    const originalIds = [...new Set(fileIdByEvent.values())];

    const [originals, previews] = await Promise.all([
      this.fileService.findByIds(context, originalIds),
      this.fileService.findVariantsByParentIds(context, originalIds, FileVariant.PREVIEW),
    ]);

    const originalById = new Map(originals.filter((file) => file != null).map((file) => [file.id, file]));
    const previewByParent = new Map(
      previews.filter((file) => file != null).map((file) => [file.parentId, file]),
    );

    return eventIds.map((eventId) => {
      const fileId = fileIdByEvent.get(eventId);

      if (fileId == null) {
        return null;
      }

      const original = originalById.get(fileId) ?? null;
      const preview = previewByParent.get(fileId) ?? null;

      // A content link with neither a resolvable original nor a preview (e.g. the
      // file was deleted) carries no displayable media.
      if (original == null && preview == null) {
        return null;
      }

      return {
        previewUrl: preview?.url ?? null,
        mediaUrl: original?.url ?? null,
        contentType: original?.contentType ?? mimetypeByEvent.get(eventId) ?? null,
        width: original?.width ?? null,
        height: original?.height ?? null,
        size: original?.size != null ? Number(original.size) : null,
      };
    });
  }
}

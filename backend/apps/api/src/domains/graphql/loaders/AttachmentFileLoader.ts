import { Injectable } from '@nestjs/common';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { FileService, FileVariant } from '@ci/domains/files';

import { Loader } from './Loader';

/** A stored attachment resolved for display: the original plus its thumbnail. */
export interface AttachmentFile {
  filename: string | null;
  contentType: string | null;
  url: string | null;
  previewUrl: string | null;
  width: number | null;
  height: number | null;
  size: number | null;
}

/**
 * Batch-resolves `ci.files` ids to displayable media, keyed by FILE id.
 *
 * Keyed on the file rather than on the message that references it, because the
 * references are already sitting on the message row — re-reading the
 * communications to answer a field the parent already carries would be a query
 * per page for data in hand. Keying on the file also means a photo referenced by
 * several messages, or by a message and a standalone media item, is fetched
 * once per request rather than once per reference.
 *
 * Walks file -> PREVIEW variant, each hop batched once, so a page of N messages
 * with M attachments costs two queries rather than 2M. Mirrors
 * {@link EventMediaLoader}, which does the same walk starting from an event.
 */
@Injectable()
export class AttachmentFileLoader extends Loader<AttachmentFile | null, string> {
  constructor(
    private readonly fileService: FileService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(AttachmentFileLoader.name);
  }

  protected async batchLoad(
    context: UserServiceContext,
    fileIds: readonly string[],
  ): Promise<readonly (AttachmentFile | null)[]> {
    const ids = [...fileIds];

    const [originals, previews] = await Promise.all([
      this.fileService.findByIds(context, ids),
      this.fileService.findVariantsByParentIds(context, ids, FileVariant.PREVIEW),
    ]);

    const originalById = new Map(originals.filter((file) => file != null).map((file) => [file.id, file]));
    const previewByParent = new Map(
      previews.filter((file) => file != null).map((file) => [file.parentId, file]),
    );

    return ids.map((id) => {
      const original = originalById.get(id) ?? null;
      const preview = previewByParent.get(id) ?? null;

      // A reference whose file is gone — purged, or deleted by the user — is
      // not displayable. Null rather than an empty shell, so the resolver can
      // tell "no bytes" from "bytes with no thumbnail yet".
      if (original == null && preview == null) {
        return null;
      }

      return {
        filename: original?.filename ?? null,
        contentType: original?.contentType ?? null,
        url: original?.url ?? null,
        previewUrl: preview?.url ?? null,
        width: original?.width ?? null,
        height: original?.height ?? null,
        size: original?.size != null ? Number(original.size) : null,
      };
    });
  }
}

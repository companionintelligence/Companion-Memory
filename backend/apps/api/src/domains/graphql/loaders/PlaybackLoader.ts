import { Injectable } from '@nestjs/common';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { FileService, FileVariant, type SignedFile } from '@ci/domains/files';

import { Loader } from './Loader';

/**
 * The PLAYBACK variant hanging off an ORIGINAL video — the browser-playable
 * H.264 rendition VideoPlaybackService makes for codecs browsers cannot be
 * relied on to decode. Same shape as {@link PreviewLoader}; keyed by the
 * original's id. Null for photos and for videos that never needed one.
 */
@Injectable()
export class PlaybackLoader extends Loader<SignedFile | null, string> {
  constructor(
    private readonly fileService: FileService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(PlaybackLoader.name);
  }

  protected async batchLoad(
    context: UserServiceContext,
    fileIds: readonly string[],
  ): Promise<readonly (SignedFile | null)[]> {
    const playbacks = await this.fileService.findVariantsByParentIds(
      context,
      [...fileIds],
      FileVariant.PLAYBACK,
    );

    return this.rekey(fileIds, playbacks, (playback) => playback.parentId);
  }
}

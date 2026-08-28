import { Injectable } from '@nestjs/common';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { type Content, ContentService } from '@ci/domains/memory';

import { Loader } from './Loader';

/**
 * A `ci.content` row by its own id, batched per request.
 *
 * Distinct from {@link ContentFileLoader}, which starts from the FILE id a
 * content row points at: this is the hop before that one, for the several
 * places that store a bare `content_id` and no FK — a sighting's frame and crop
 * (`ci.object_observations.content_id` / `crop_content_id`), a receipt's source
 * document, a product's stock image. Each of those used to be a separate
 * round-trip issued by the tile that rendered it; batching them here is what
 * lets a page of tiles resolve its pictures in one query instead of N.
 */
@Injectable()
export class ContentLoader extends Loader<Content | null> {
  constructor(
    private readonly contentService: ContentService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(ContentLoader.name);
  }

  protected async batchLoad(
    context: UserServiceContext,
    contentIds: readonly string[],
  ): Promise<readonly (Content | null)[]> {
    this.logger.log(`Loading a batch of ${contentIds.length} content rows`);

    return this.contentService.findByIds(context, [...contentIds]);
  }
}

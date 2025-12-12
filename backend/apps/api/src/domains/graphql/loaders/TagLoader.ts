import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type UserServiceContext } from '@ci/common/types';
import { TagService, type EntityIdentifier, type TimestampedTag } from '@ci/domains/search-next';

import { Loader } from './Loader';

@Injectable()
export class TagLoader extends Loader<TimestampedTag[], EntityIdentifier> {
  constructor(
    private readonly tagService: TagService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(TagLoader.name);
  }

  protected async batchLoad(
    context: UserServiceContext,
    entityIds: readonly EntityIdentifier[],
  ): Promise<readonly TimestampedTag[][]> {
    const results = await this.tagService.getTagsForEntities(context, [...entityIds]);

    return entityIds.map((entityId) => results.get(entityId) ?? []);
  }
}

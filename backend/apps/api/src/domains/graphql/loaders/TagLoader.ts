import { Injectable } from '@nestjs/common';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import {
  TagService,
  type EntityIdentifier,
  type TaggableEntity,
  type TimestampedTag,
} from '@ci/domains/search-next';

import { Loader } from './Loader';

@Injectable()
export class TagLoader extends Loader<TimestampedTag[], EntityIdentifier<TaggableEntity>> {
  constructor(
    private readonly tagService: TagService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(TagLoader.name);
  }

  protected async batchLoad(
    context: UserServiceContext,
    entityIds: readonly EntityIdentifier<TaggableEntity>[],
  ): Promise<readonly TimestampedTag[][]> {
    const results = await this.tagService.getTagsForEntities(context, [...entityIds]);

    return entityIds.map((entityId) => results.get(entityId) ?? []);
  }
}

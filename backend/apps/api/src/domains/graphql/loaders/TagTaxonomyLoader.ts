import { Injectable } from '@nestjs/common';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { TagService } from '@ci/domains/search-next';

import { Loader } from './Loader';

export type TagTaxonomyAxis = 'directions' | 'categories' | 'directionOptOuts';
type Tag = Awaited<ReturnType<TagService['getTagDirections']>>[number];

/**
 * Batches the `directions`, `categories` and `directionOptOuts` fields of a
 * page of tags into one query per axis, instead of one per tag per field.
 * The key is `(axis, tagId)`; {@link loadFor} spells it.
 */
@Injectable()
export class TagTaxonomyLoader extends Loader<Tag[]> {
  constructor(
    private readonly tagService: TagService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(TagTaxonomyLoader.name);
  }

  loadFor(context: UserServiceContext, axis: TagTaxonomyAxis, tagId: string): Promise<Tag[]> {
    return this.load(context, `${axis}:${tagId}`);
  }

  protected async batchLoad(context: UserServiceContext, keys: readonly string[]): Promise<readonly Tag[][]> {
    const parsed = keys.map((key) => {
      const separator = key.indexOf(':');

      return { axis: key.slice(0, separator) as TagTaxonomyAxis, tagId: key.slice(separator + 1) };
    });
    const idsByAxis = new Map<TagTaxonomyAxis, string[]>();

    for (const { axis, tagId } of parsed) {
      const ids = idsByAxis.get(axis) ?? [];

      if (!ids.includes(tagId)) {
        ids.push(tagId);
      }

      idsByAxis.set(axis, ids);
    }

    this.logger.log(`Loading tag taxonomy for a batch of ${keys.length} tags`);

    const readers: Record<TagTaxonomyAxis, (ids: string[]) => Promise<Map<string, Tag[]>>> = {
      directions: (ids) => this.tagService.getTagDirectionsForTags(context, ids),
      categories: (ids) => this.tagService.getTagCategoriesForTags(context, ids),
      directionOptOuts: (ids) => this.tagService.getCategoryDirectionOptoutsForTags(context, ids),
    };
    const results = new Map<TagTaxonomyAxis, Map<string, Tag[]>>();

    await Promise.all(
      [...idsByAxis.entries()].map(async ([axis, ids]) => {
        results.set(axis, await readers[axis](ids));
      }),
    );

    return parsed.map(({ axis, tagId }) => results.get(axis)?.get(tagId) ?? []);
  }
}

import { BadRequestException, UseGuards } from '@nestjs/common';
import { Args, Query, Resolver } from '@nestjs/graphql';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { RequestContext, UserServiceContext } from '@ci/common/types';
import { toServiceContext } from '@ci/common/utils';
import { PersonService } from '@ci/domains/memory';
import {
  SearchService,
  TagService,
  type EntityIdentifier,
  type IndexableEntity,
  type TaggableEntity,
} from '@ci/domains/search-next';

import { PersonType } from '../types/PersonType';
import { SearchConnection } from '../types/SearchConnection';
import { SearchInput } from '../types/SearchInput';
import { type SearchResult } from '../types/SearchResultType';
import { Paginator } from '../utils/Paginator';

@UseGuards(JwtAuthGuard)
@Resolver()
export class SearchResolver {
  constructor(
    private readonly personService: PersonService,
    private readonly searchService: SearchService,
    private readonly tagService: TagService,
  ) {}

  @Query(() => SearchConnection)
  async search(
    @Context() context: RequestContext,
    @Args('input') input: SearchInput,
  ): Promise<SearchConnection> {
    const serviceContext = toServiceContext(context);

    if (input.query == null && (!input.tags || input.tags.length === 0)) {
      throw new BadRequestException('Must provide either query or tags');
    }

    if (input.query != null && input.tags && input.tags.length > 0) {
      throw new BadRequestException('Cannot provide both query and tags');
    }

    const results: SearchResult[] = [];

    if (input.tags && input.tags.length > 0) {
      const tagResults = await this.searchByTags(serviceContext, input.tags);

      results.push(...tagResults);
    } else if (input.query != null) {
      const queryResults = await this.searchByQuery(serviceContext, input.query);

      results.push(...queryResults);
    }

    const { slice, pageInfo, totalCount } = Paginator.paginate(results, {
      getId: (result) => result.id,
    });

    const edges = slice.map((result) => ({
      node: result,
      cursor: result.id,
    }));

    return {
      edges,
      pageInfo,
      totalCount,
    };
  }

  private async searchByQuery(context: UserServiceContext, query: string): Promise<SearchResult[]> {
    const queryResults = await this.searchService.search(context, {
      query,
      maxResults: 25,
    });

    return this.resolveEntities(context, queryResults);
  }

  private async searchByTags(context: UserServiceContext, tags: string[]): Promise<SearchResult[]> {
    if (tags.length === 0) {
      return [];
    }

    const tagResults = await this.tagService.getEntitiesForTags(context, tags);

    return this.resolveEntities(context, tagResults);
  }

  private async resolveEntities(
    context: UserServiceContext,
    results: EntityIdentifier<IndexableEntity | TaggableEntity>[],
  ): Promise<SearchResult[]> {
    const groupedByType: Map<IndexableEntity | TaggableEntity, string[]> = results.reduce((acc, result) => {
      if (!acc.has(result.type)) {
        acc.set(result.type, []);
      }

      acc.get(result.type)!.push(result.id);

      return acc;
    }, new Map());

    const peopleIds = groupedByType.get('person') || [];

    const [people] = await Promise.all([this.personService.findByIds(context, peopleIds)]);

    const personResults = people.map((entity) => PersonType.toType(entity));

    const resultMap = new Map<string, SearchResult>();

    personResults.forEach((person) => resultMap.set(makeCompositeKey('person', person.__source.id), person));

    const orderedResults = results
      .map((result) => resultMap.get(makeCompositeKey(result.type, result.id)))
      .filter((entity): entity is SearchResult => entity != null);

    return orderedResults;
  }
}

function makeCompositeKey(type: IndexableEntity | TaggableEntity, id: string): string {
  return `${type}:${id}`;
}

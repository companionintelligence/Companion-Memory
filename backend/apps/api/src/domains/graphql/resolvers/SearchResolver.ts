import { UseGuards } from '@nestjs/common';
import { Args, Query, Resolver } from '@nestjs/graphql';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { RequestContext } from '@ci/common/types';
import { toServiceContext } from '@ci/common/utils';
import { ThreadService } from '@ci/domains/conversations';
import { PersonService } from '@ci/domains/memory';
import { SearchService } from '@ci/domains/search-next';

import { PersonType } from '../types/PersonType';
import { SearchConnection } from '../types/SearchConnection';
import { ThreadType } from '../types/ThreadType';
import { Paginator } from '../utils/Paginator';
@UseGuards(JwtAuthGuard)
@Resolver()
export class SearchResolver {
  constructor(
    private readonly threadService: ThreadService,
    private readonly personService: PersonService,
    private readonly searchEgressServiceService: SearchService,
  ) {}

  @Query(() => SearchConnection)
  async search(
    @Context() context: RequestContext,

    @Args('query', { type: () => String }) query: string,
  ): Promise<SearchConnection> {
    const serviceContext = toServiceContext(context);

    const queryResult = await this.searchEgressServiceService.searchByQuery(serviceContext, query);

    const hydrated = await Promise.all(
      queryResult.map(async (result) => {
        console.log('person to hydrate', result);

        return this.personService.findById(serviceContext, result.entityId);
      }),
    );

    console.log('hydrated', hydrated);

    const [threads, people] = await Promise.all([
      this.threadService.findAll(serviceContext),
      this.personService.findAll(serviceContext),
    ]);

    const threadResults = threads.map((entity) => ThreadType.toType(entity));
    const personResults = people.map((entity) => PersonType.toType(entity));

    // Interleave results
    const results: (ThreadType | PersonType)[] = [];
    const maxLength = Math.max(threadResults.length, personResults.length);

    for (let i = 0; i < maxLength; i++) {
      if (i < threadResults.length) {
        results.push(threadResults[i]);
      }

      if (i < personResults.length) {
        results.push(personResults[i]);
      }
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
}

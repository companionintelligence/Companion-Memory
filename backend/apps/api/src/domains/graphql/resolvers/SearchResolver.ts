import { UseGuards } from '@nestjs/common';
import { Args, Query, Resolver } from '@nestjs/graphql';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { RequestContext } from '@ci/common/types';
import { ThreadService } from '@ci/domains/conversations';
import { PersonService } from '@ci/domains/memory';

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
  ) {}

  @Query(() => SearchConnection)
  async search(
    @Context() context: RequestContext,
    @Args('query', { type: () => String }) query: string,
  ): Promise<SearchConnection> {
    console.log('Executing query', query);

    const [threads, people] = await Promise.all([
      this.threadService.findAll(context),
      this.personService.findAll(context),
    ]);

    const threadResults = threads.map((entity) => ThreadType.fromEntity(entity));
    const personResults = people.map((entity) => PersonType.fromEntity(entity));

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

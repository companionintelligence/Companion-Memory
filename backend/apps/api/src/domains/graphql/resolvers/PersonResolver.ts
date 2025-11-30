import { UseGuards } from '@nestjs/common';
import { Query, Resolver, Args, ID } from '@nestjs/graphql';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { RequestContext } from '@ci/common/types';
import { PersonService } from '@ci/domains/memory';

import { GlobalUID } from '../types/GlobalUID';
import { PaginationArgs } from '../types/PaginationArgs';
import { PersonConnection } from '../types/PersonConnection';
import { PersonEdge } from '../types/PersonEdge';
import { PersonType } from '../types/PersonType';
import { Paginator } from '../utils/Paginator';

@UseGuards(JwtAuthGuard)
@Resolver(() => PersonType)
export class PersonResolver {
  constructor(private readonly personService: PersonService) {}

  @Query(() => PersonConnection)
  async people(
    @Context() context: RequestContext,
    @Args() pagination: PaginationArgs,
  ): Promise<PersonConnection> {
    const entities = await this.personService.findAll(context);

    const { slice, pageInfo, totalCount } = Paginator.paginate(entities, {
      ...pagination,
      getId: (entity) => GlobalUID.encode('person', entity.id),
    });

    const edges: PersonEdge[] = slice.map((entity) => {
      const node = PersonType.fromEntity(entity);

      return {
        node,
        cursor: node.id,
      };
    });

    return {
      edges,
      pageInfo,
      totalCount,
    };
  }

  @Query(() => PersonType, { nullable: true })
  async person(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<PersonType | null> {
    const id = GlobalUID.parse('person', gid);

    const entity = await this.personService.findOne(context, id);

    return entity ? PersonType.fromEntity(entity) : null;
  }
}

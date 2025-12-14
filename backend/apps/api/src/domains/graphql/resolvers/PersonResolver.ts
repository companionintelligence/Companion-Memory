import { UseGuards } from '@nestjs/common';
import { Mutation, Parent, Query, ResolveField, Resolver, Args, ID } from '@nestjs/graphql';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { RequestContext } from '@ci/common/types';
import { toServiceContext } from '@ci/common/utils';
import { PersonService } from '@ci/domains/memory';

import { TagLoader } from '../loaders/TagLoader';
import { CreatePersonInput } from '../types/CreatePersonInput';
import { EntityTagType } from '../types/EntityTagType';
import { GlobalUID } from '../types/GlobalUID';
import { PaginationArgs } from '../types/PaginationArgs';
import { PersonConnection } from '../types/PersonConnection';
import { PersonEdge } from '../types/PersonEdge';
import { PersonType } from '../types/PersonType';
import { RemovePersonInput } from '../types/RemovePersonInput';
import { UpdatePersonInput } from '../types/UpdatePersonInput';
import { Paginator } from '../utils/Paginator';

@UseGuards(JwtAuthGuard)
@Resolver(() => PersonType)
export class PersonResolver {
  constructor(
    private readonly personService: PersonService,
    private readonly tagLoader: TagLoader,
  ) {}

  @Mutation(() => PersonType)
  async createPerson(
    @Context() context: RequestContext,
    @Args('input') input: CreatePersonInput,
  ): Promise<PersonType> {
    const serviceContext = toServiceContext(context);

    const entity = await this.personService.create(serviceContext, {
      name: input.name,
      description: input.description,
    });

    return PersonType.toType(entity);
  }

  @Mutation(() => PersonType, { nullable: true })
  async updatePerson(
    @Context() context: RequestContext,
    @Args('input') input: UpdatePersonInput,
  ): Promise<PersonType | null> {
    const serviceContext = toServiceContext(context);

    const entity = await this.personService.update(serviceContext, input.id, {
      name: input.name,
      description: input.description,
    });

    return entity ? PersonType.toType(entity) : entity;
  }

  @Mutation(() => Boolean)
  async removePerson(
    @Context() context: RequestContext,
    @Args('input') input: RemovePersonInput,
  ): Promise<boolean> {
    const serviceContext = toServiceContext(context);

    return this.personService.remove(serviceContext, input.id);
  }

  @Query(() => PersonConnection)
  async people(
    @Context() context: RequestContext,
    @Args() pagination: PaginationArgs,
  ): Promise<PersonConnection> {
    const serviceContext = toServiceContext(context);

    const entities = await this.personService.findAll(serviceContext);

    const { slice, pageInfo, totalCount } = Paginator.paginate(entities, {
      ...pagination,
      getId: (entity) => GlobalUID.encode('person', entity.id),
    });

    const edges: PersonEdge[] = slice.map((entity) => {
      const node = PersonType.toType(entity);

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
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('person', gid);

    const entity = await this.personService.findById(serviceContext, id);

    return entity ? PersonType.toType(entity) : null;
  }

  @ResolveField(() => [EntityTagType])
  async tags(@Context() context: RequestContext, @Parent() parent: PersonType): Promise<EntityTagType[]> {
    const serviceContext = toServiceContext(context);

    const tags = await this.tagLoader.load(serviceContext, {
      type: 'person',
      id: parent.__source.id,
    });

    return tags.map((tag) => EntityTagType.toType(tag));
  }
}

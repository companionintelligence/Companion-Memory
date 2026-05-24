import { UseGuards } from '@nestjs/common';
import { Args, ID, Parent, Query, Resolver, ResolveField } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { CommunicationService } from '@ci/domains/memory';
import { type Person } from '@ci/domains/memory';

import { PersonLoader } from '../loaders/PersonLoader';
import { TagLoader } from '../loaders/TagLoader';
import { CommunicationConnection } from '../types/CommunicationConnection';
import { CommunicationEdge } from '../types/CommunicationEdge';
import { CommunicationType } from '../types/CommunicationType';
import { EntityTagType } from '../types/EntityTagType';
import { GlobalUID } from '../types/GlobalUID';
import { PaginationArgs } from '../types/PaginationArgs';
import { PersonConnection } from '../types/PersonConnection';
import { PersonEdge } from '../types/PersonEdge';
import { PersonType } from '../types/PersonType';
import { Paginator } from '../utils/Paginator';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => CommunicationType)
export class CommunicationResolver {
  constructor(
    private readonly communicationService: CommunicationService,
    private readonly personLoader: PersonLoader,
    private readonly tagLoader: TagLoader,
  ) {}

  @Query(() => CommunicationConnection)
  async communications(
    @Context() context: RequestContext,
    @Args() pagination: PaginationArgs,
  ): Promise<CommunicationConnection> {
    const serviceContext = toServiceContext(context);

    const entities = await this.communicationService.findAll(serviceContext);

    const { slice, pageInfo, totalCount } = Paginator.paginate(entities, {
      ...pagination,
      getId: (entity) => GlobalUID.encode('communication', entity.id),
    });

    const edges: CommunicationEdge[] = slice.map((entity) => {
      const node = CommunicationType.toType(entity);

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

  @Query(() => CommunicationType, { nullable: true })
  async communication(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<CommunicationType | null> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('communication', gid);

    const entity = await this.communicationService.findById(serviceContext, id);

    return entity ? CommunicationType.toType(entity) : null;
  }

  @ResolveField(() => PersonType, { nullable: true })
  async from(
    @Context() context: RequestContext,
    @Parent() parent: CommunicationType,
  ): Promise<PersonType | null> {
    const serviceContext = toServiceContext(context);

    if (parent.__source.fromEntityId == null) {
      return null;
    }

    const person = await this.personLoader.load(serviceContext, parent.__source.fromEntityId);

    return person ? PersonType.toType(person) : null;
  }

  @ResolveField(() => PersonConnection)
  async to(
    @Context() context: RequestContext,
    @Parent() parent: CommunicationType,
    @Args() pagination: PaginationArgs,
  ): Promise<PersonConnection> {
    const serviceContext = toServiceContext(context);

    const people =
      parent.__source.toEntityIds == null
        ? []
        : await this.personLoader.loadMany(serviceContext, parent.__source.toEntityIds);

    // TODO:
    //   Report errors here somehow instead of swallowing them.
    //   Consider emitting a warning log or investigate more deeply
    //   how we might convey a single error within a list.
    const filteredPeople = people.filter(
      (person): person is Person => person != null && !(person instanceof Error),
    );

    const { slice, pageInfo, totalCount } = Paginator.paginate(filteredPeople, {
      ...pagination,
      getId: (person) => GlobalUID.encode('person', person.id),
    });

    const edges: PersonEdge[] = slice.map((person) => {
      const node = PersonType.toType(person);

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

  @ResolveField(() => [EntityTagType])
  async tags(
    @Context() context: RequestContext,
    @Parent() parent: CommunicationType,
  ): Promise<EntityTagType[]> {
    const serviceContext = toServiceContext(context);

    const tags = await this.tagLoader.load(serviceContext, {
      type: 'communication',
      id: parent.__source.id,
    });

    return tags.map((tag) => EntityTagType.toType(tag));
  }
}

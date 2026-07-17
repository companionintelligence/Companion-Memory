import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Parent, Query, Resolver, ResolveField } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { MaxArraySizePipe } from '@ci/common/pipes';
import { CommunicationService, CommunicationType as CommunicationTypeEnum } from '@ci/domains/memory';
import { type Person } from '@ci/domains/memory';

import { PersonLoader } from '../loaders/PersonLoader';
import { TagLoader } from '../loaders/TagLoader';
import { CommunicationConnection } from '../types/CommunicationConnection';
import { CommunicationEdge } from '../types/CommunicationEdge';
import { CommunicationType } from '../types/CommunicationType';
import { CreateCommunicationInput } from '../types/CreateCommunicationInput';
import { EntityTagType } from '../types/EntityTagType';
import { GlobalUID } from '../types/GlobalUID';
import { PaginationArgs } from '../types/PaginationArgs';
import { PersonConnection } from '../types/PersonConnection';
import { PersonEdge } from '../types/PersonEdge';
import { PersonType } from '../types/PersonType';
import { UpdateCommunicationInput } from '../types/UpdateCommunicationInput';
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

    const { entities, hasNextPage, hasPreviousPage, totalCount } = await this.communicationService.findPage(
      serviceContext,
      {
        first: pagination.first,
        last: pagination.last,
        afterId: pagination.after ? GlobalUID.decode(pagination.after).id : null,
        beforeId: pagination.before ? GlobalUID.decode(pagination.before).id : null,
      },
    );

    const edges: CommunicationEdge[] = entities.map((entity) => {
      const node = CommunicationType.toType(entity);

      return {
        node,
        cursor: node.id,
      };
    });

    const pageInfo = {
      hasNextPage,
      hasPreviousPage,
      startCursor: edges.length > 0 ? edges[0].cursor : null,
      endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
    };

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

  /**
   * Batch, idempotent communication ingest for the importer (net-new write path
   * outside ETL). Each input dedupes on the provenance triple (user, sourceType,
   * sourceSystem, sourceId) so a re-sync returns the existing communication
   * instead of inserting a duplicate. Returns created-or-existing rows in input
   * order.
   */
  @Mutation(() => [CommunicationType])
  async createCommunications(
    @Context() context: RequestContext,
    @Args('input', { type: () => [CreateCommunicationInput] }, new MaxArraySizePipe())
    input: CreateCommunicationInput[],
  ): Promise<CommunicationType[]> {
    const serviceContext = toServiceContext(context);

    const communications = await this.communicationService.createMany(
      serviceContext,
      input.map((item) => ({
        communication_type: item.communicationType as CommunicationTypeEnum,
        time: item.time,
        content: item.content,
        preview: item.preview,
        subject: item.subject,
        // `direction` is stored verbatim; the column is plain text. Default to
        // 'inbound' when the importer omits it.
        direction: (item.direction ?? 'inbound') as 'inbound' | 'outbound',
        thread_id: item.threadId,
        from_entity_id: item.fromEntityId,
        to_entity_ids: item.toEntityIds,
        participants_metadata: item.participantsMetadata,
        attachments: item.attachments,
        source_type: item.sourceType,
        source_system: item.sourceSystem,
        source_id: item.sourceId,
      })),
    );

    return communications.map((communication) => CommunicationType.toType(communication));
  }

  @Mutation(() => CommunicationType, { nullable: true })
  async updateCommunication(
    @Context() context: RequestContext,
    @Args('input') input: UpdateCommunicationInput,
  ): Promise<CommunicationType | null> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('communication', input.id);

    const entity = await this.communicationService.update(serviceContext, id, {
      subject: input.subject,
      content: input.content ?? '',
    });

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

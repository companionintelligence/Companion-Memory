import { UseGuards } from '@nestjs/common';
import { Mutation, Parent, Query, ResolveField, Resolver, Args, ID } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ConceptService } from '@ci/domains/memory';

import { TagLoader } from '../loaders/TagLoader';
import { ConceptConnection } from '../types/ConceptConnection';
import { ConceptEdge } from '../types/ConceptEdge';
import { ConceptType } from '../types/ConceptType';
import { CreateConceptInput } from '../types/CreateConceptInput';
import { CreateConceptPayload } from '../types/CreateConceptPayload';
import { DeleteByIdInput } from '../types/DeleteByIdInput';
import { DeleteByIdPayload } from '../types/DeleteByIdPayload';
import { EntityTagType } from '../types/EntityTagType';
import { GlobalUID } from '../types/GlobalUID';
import { PaginationArgs } from '../types/PaginationArgs';
import { UpdateConceptInput } from '../types/UpdateConceptInput';
import { UpdateConceptPayload } from '../types/UpdateConceptPayload';
import { Paginator } from '../utils/Paginator';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => ConceptType)
export class ConceptResolver {
  constructor(
    private readonly conceptService: ConceptService,
    private readonly tagLoader: TagLoader,
  ) {}

  @Query(() => ConceptConnection)
  async concepts(
    @Context() context: RequestContext,
    @Args() pagination: PaginationArgs,
  ): Promise<ConceptConnection> {
    const serviceContext = toServiceContext(context);

    const entities = await this.conceptService.findAll(serviceContext);

    const { slice, pageInfo, totalCount } = Paginator.paginate(entities, {
      ...pagination,
      getId: (entity) => GlobalUID.encode('concept', entity.id),
    });

    const edges: ConceptEdge[] = slice.map((entity) => {
      const node = ConceptType.toType(entity);

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

  @Query(() => ConceptType, { nullable: true })
  async concept(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<ConceptType | null> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('concept', gid);

    const entity = await this.conceptService.findById(serviceContext, id);

    return entity ? ConceptType.toType(entity) : null;
  }

  @Mutation(() => CreateConceptPayload)
  async createConcept(
    @Context() context: RequestContext,
    @Args('input') input: CreateConceptInput,
  ): Promise<CreateConceptPayload> {
    const serviceContext = toServiceContext(context);

    const entity = await this.conceptService.create(serviceContext, {
      name: input.name,
      description: input.description,
      linkedTable: input.linkedTable,
      linkedId: input.linkedId,
    });

    if (entity == null) {
      return {
        success: false,
      };
    }

    return {
      success: true,
      concept: entity ? ConceptType.toType(entity) : undefined,
    };
  }

  /**
   * Batch, idempotent concept ingest. Each input dedupes on the external
   * provenance key (linkedTable, linkedId) so a re-sync returns the existing
   * concept instead of inserting a duplicate. Returns the created-or-existing
   * concepts in input order.
   */
  @Mutation(() => [ConceptType])
  async createConcepts(
    @Context() context: RequestContext,
    @Args('input', { type: () => [CreateConceptInput] }) input: CreateConceptInput[],
  ): Promise<ConceptType[]> {
    const serviceContext = toServiceContext(context);

    const concepts = await this.conceptService.createMany(
      serviceContext,
      input.map((item) => ({
        name: item.name,
        description: item.description,
        linkedTable: item.linkedTable,
        linkedId: item.linkedId,
      })),
    );

    return concepts.map((concept) => ConceptType.toType(concept));
  }

  @Mutation(() => UpdateConceptPayload)
  async updateConcept(
    @Context() context: RequestContext,
    @Args('input') input: UpdateConceptInput,
  ): Promise<UpdateConceptPayload> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('concept', input.id);

    const entity = await this.conceptService.update(serviceContext, id, {
      name: input.name,
      description: input.description,
    });

    if (entity == null) {
      return {
        success: false,
      };
    }

    return {
      success: true,
      concept: entity ? ConceptType.toType(entity) : undefined,
    };
  }

  @Mutation(() => DeleteByIdPayload)
  async deleteConcept(
    @Context() context: RequestContext,
    @Args('input') input: DeleteByIdInput,
  ): Promise<DeleteByIdPayload> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('concept', input.id);

    const success = await this.conceptService.remove(serviceContext, id);

    if (!success) {
      return {
        success: false,
      };
    }

    return {
      success,
      deletedId: input.id,
    };
  }

  @ResolveField(() => [EntityTagType])
  async tags(@Context() context: RequestContext, @Parent() parent: ConceptType): Promise<EntityTagType[]> {
    const serviceContext = toServiceContext(context);

    const tags = await this.tagLoader.load(serviceContext, {
      type: 'concept',
      id: parent.__source.id,
    });

    return tags.map((tag) => EntityTagType.toType(tag));
  }
}

import { UseGuards } from '@nestjs/common';
import { Parent, Query, Mutation, ResolveField, Resolver, Args, ID } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { MaxArraySizePipe } from '@ci/common/pipes';
import { ItemService } from '@ci/domains/memory';

import { ItemFileLoader } from '../loaders/ItemFileLoader';
import { TagLoader } from '../loaders/TagLoader';
import { CreateInventoryInput } from '../types/CreateInventoryInput';
import { CreateItemInput } from '../types/CreateItemInput';
import { CreateItemPayload } from '../types/CreateItemPayload';
import { DeleteByIdInput } from '../types/DeleteByIdInput';
import { DeleteByIdPayload } from '../types/DeleteByIdPayload';
import { EntityTagType } from '../types/EntityTagType';
import { FileType } from '../types/FileType';
import { GlobalUID } from '../types/GlobalUID';
import { ItemConnection } from '../types/ItemConnection';
import { ItemEdge } from '../types/ItemEdge';
import { ItemType } from '../types/ItemType';
import { PaginationArgs } from '../types/PaginationArgs';
import { UpdateItemInput } from '../types/UpdateItemInput';
import { UpdateItemPayload } from '../types/UpdateItemPayload';
import { Paginator } from '../utils/Paginator';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => ItemType)
export class ItemResolver {
  constructor(
    private readonly itemFileLoader: ItemFileLoader,
    private readonly itemService: ItemService,
    private readonly tagLoader: TagLoader,
  ) {}

  @Query(() => ItemConnection)
  async items(
    @Context() context: RequestContext,
    @Args() pagination: PaginationArgs,
  ): Promise<ItemConnection> {
    const serviceContext = toServiceContext(context);

    const entities = await this.itemService.findAll(serviceContext);

    const { slice, pageInfo, totalCount } = Paginator.paginate(entities, {
      ...pagination,
      getId: (entity) => GlobalUID.encode('item', entity.id),
    });

    const edges: ItemEdge[] = slice.map((entity) => {
      const node = ItemType.toType(entity);

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

  @Query(() => ItemType, { nullable: true })
  async item(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<ItemType | null> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('item', gid);

    const entity = await this.itemService.findById(serviceContext, id);

    return entity ? ItemType.toType(entity) : null;
  }

  @Mutation(() => CreateItemPayload)
  async createItem(
    @Context() context: RequestContext,
    @Args('input') input: CreateItemInput,
  ): Promise<CreateItemPayload> {
    const serviceContext = toServiceContext(context);

    const entity = await this.itemService.create(serviceContext, {
      name: input.name,
      description: input.description,
      category: input.category,
      brand: input.brand,
      model: input.model,
      currentValue: input.currentValue,
    });

    if (entity == null) {
      return {
        success: false,
      };
    }

    return {
      success: true,
      item: entity ? ItemType.toType(entity) : undefined,
    };
  }

  /**
   * Batch, idempotent inventory ingest for the importer. Each input dedupes on the
   * provenance triple (owner, sourceType, sourceSystem, sourceId) so a re-sync
   * returns the existing item instead of inserting a duplicate (e.g. an Amazon
   * order id mapped to identifierCodes.order_id AND sourceId). Returns the
   * created-or-existing items in input order.
   */
  @Mutation(() => [ItemType])
  async createInventoryItems(
    @Context() context: RequestContext,
    @Args('input', { type: () => [CreateInventoryInput] }, new MaxArraySizePipe())
    input: CreateInventoryInput[],
  ): Promise<ItemType[]> {
    const serviceContext = toServiceContext(context);

    const items = await this.itemService.createMany(
      serviceContext,
      input.map((item) => ({
        name: item.name,
        description: item.description,
        category: item.category,
        subcategory: item.subcategory,
        brand: item.brand,
        purchasePrice: item.purchasePrice,
        currentValue: item.currentValue,
        currency: item.currency,
        acquiredAt: item.acquiredAt,
        condition: item.condition,
        identifierCodes: item.identifierCodes,
        metadata: item.metadata,
        sourceType: item.sourceType,
        sourceSystem: item.sourceSystem,
        sourceId: item.sourceId,
      })),
    );

    return items.map((item) => ItemType.toType(item));
  }

  @Mutation(() => UpdateItemPayload)
  async updateItem(
    @Context() context: RequestContext,
    @Args('input') input: UpdateItemInput,
  ): Promise<UpdateItemPayload> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('item', input.id);

    const entity = await this.itemService.update(serviceContext, id, {
      name: input.name,
      description: input.description,
      category: input.category,
      brand: input.brand,
      model: input.model,
      currentValue: input.currentValue,
    });

    if (entity == null) {
      return {
        success: false,
      };
    }

    return {
      success: true,
      item: entity ? ItemType.toType(entity) : undefined,
    };
  }

  @Mutation(() => DeleteByIdPayload)
  async deleteItem(
    @Context() context: RequestContext,
    @Args('input') input: DeleteByIdInput,
  ): Promise<DeleteByIdPayload> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('item', input.id);

    const success = await this.itemService.remove(serviceContext, id);

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

  @ResolveField(() => FileType, { nullable: true })
  async file(@Context() context: RequestContext, @Parent() parent: ItemType): Promise<FileType | null> {
    const serviceContext = toServiceContext(context);

    if (parent.__source.sourceFileId == null) {
      return null;
    }

    const file = await this.itemFileLoader.load(serviceContext, parent.__source.sourceFileId);

    if (file == null) {
      return null;
    }

    return FileType.toType(file);
  }

  @ResolveField(() => [EntityTagType])
  async tags(@Context() context: RequestContext, @Parent() parent: ItemType): Promise<EntityTagType[]> {
    const serviceContext = toServiceContext(context);

    const tags = await this.tagLoader.load(serviceContext, {
      type: 'item',
      id: parent.__source.id,
    });

    return tags.map((tag) => EntityTagType.toType(tag));
  }
}

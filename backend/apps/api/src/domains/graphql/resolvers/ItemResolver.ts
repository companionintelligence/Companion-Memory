import { UseGuards } from '@nestjs/common';
import { Parent, Query, ResolveField, Resolver, Args, ID } from '@nestjs/graphql';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { RequestContext } from '@ci/common/types';
import { toServiceContext } from '@ci/common/utils';
import { ItemService } from '@ci/domains/memory';

import { ItemFileLoader } from '../loaders/ItemFileLoader';
import { FileType } from '../types/FileType';
import { GlobalUID } from '../types/GlobalUID';
import { ItemConnection } from '../types/ItemConnection';
import { ItemEdge } from '../types/ItemEdge';
import { ItemType } from '../types/ItemType';
import { PaginationArgs } from '../types/PaginationArgs';
import { Paginator } from '../utils/Paginator';

@UseGuards(JwtAuthGuard)
@Resolver(() => ItemType)
export class ItemResolver {
  constructor(
    private readonly itemFileLoader: ItemFileLoader,
    private readonly itemService: ItemService,
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
}

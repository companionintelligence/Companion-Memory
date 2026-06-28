import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { FileService } from '@ci/domains/files';

import { FileItemsLoader } from '../loaders/FileItemsLoader';
import { PreviewLoader } from '../loaders/PreviewLoader';
import { TagLoader } from '../loaders/TagLoader';
import { EntityTagType } from '../types/EntityTagType';
import { FileConnection } from '../types/FileConnection';
import { FileEdge } from '../types/FileEdge';
import { FileType } from '../types/FileType';
import { GlobalUID } from '../types/GlobalUID';
import { ItemConnection } from '../types/ItemConnection';
import { ItemEdge } from '../types/ItemEdge';
import { ItemType } from '../types/ItemType';
import { PaginationArgs } from '../types/PaginationArgs';
import { UpdateFileInput } from '../types/UpdateFileInput';
import { entityOwnerScope } from '../utils/entityOwnerScope';
import { Paginator } from '../utils/Paginator';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => FileType)
export class FileResolver {
  constructor(
    private readonly fileService: FileService,
    private readonly fileItemsLoader: FileItemsLoader,
    private readonly tagLoader: TagLoader,
    private readonly previewLoader: PreviewLoader,
  ) {}

  @Query(() => FileConnection)
  async files(
    @Context() context: RequestContext,
    @Args() pagination: PaginationArgs,
  ): Promise<FileConnection> {
    const serviceContext = toServiceContext(context);

    const entities = await this.fileService.findAll(serviceContext);

    const { slice, pageInfo, totalCount } = Paginator.paginate(entities, {
      ...pagination,
      getId: (entity) => GlobalUID.encode('file', entity.id),
    });

    const edges: FileEdge[] = slice.map((entity) => {
      const node = FileType.toType(entity);

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

  @Query(() => FileType, { nullable: true })
  async file(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<FileType | null> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('file', gid);

    const entity = await this.fileService.findById(serviceContext, id);

    return entity ? FileType.toType(entity) : null;
  }

  @Mutation(() => FileType, { nullable: true })
  async updateFile(
    @Context() context: RequestContext,
    @Args('input') input: UpdateFileInput,
  ): Promise<FileType | null> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('file', input.id);

    const entity = await this.fileService.update(serviceContext, id, {
      title: input.title,
      description: input.description,
    });

    return entity ? FileType.toType(entity) : null;
  }

  @ResolveField(() => String, { nullable: true })
  async previewUrl(@Context() context: RequestContext, @Parent() parent: FileType): Promise<string | null> {
    const file = parent.__source;

    if (file == null) {
      return null;
    }

    const serviceContext = entityOwnerScope(context, file.userId);

    const preview = await this.previewLoader.load(serviceContext, file.id);

    return preview ? preview.url : null;
  }

  @ResolveField(() => ItemConnection, { nullable: true })
  async items(
    @Context() context: RequestContext,
    @Parent() parent: FileType,
    @Args() pagination: PaginationArgs,
  ): Promise<ItemConnection | null> {
    const file = parent.__source;

    if (file == null) {
      return null;
    }

    const serviceContext = entityOwnerScope(context, file.userId);

    const fileId = file.id;

    const entities = await this.fileItemsLoader.load(serviceContext, fileId);

    if (entities.length === 0) {
      return null;
    }

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

  @ResolveField(() => [EntityTagType])
  async tags(@Context() context: RequestContext, @Parent() parent: FileType): Promise<EntityTagType[]> {
    const serviceContext = entityOwnerScope(context, parent.__source.userId);

    const tags = await this.tagLoader.load(serviceContext, {
      type: 'file',
      id: parent.__source.id,
    });

    return tags.map((tag) => EntityTagType.toType(tag));
  }
}

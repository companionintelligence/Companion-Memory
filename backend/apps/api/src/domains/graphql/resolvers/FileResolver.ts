import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { FileService } from '@ci/domains/files';

import { GraphqlPrivacy } from '../decorators/GraphqlPrivacy';
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

  /** Largest page one request may sign; also the page when `first` is absent. */
  private static readonly MAX_FILES_PAGE = 200;

  /**
   * Paginated in SQL (see FileService.findPage) rather than through
   * Paginator.paginate over findAll(): the load-everything-slice-later shape
   * pre-signed a URL for EVERY file in the library on EVERY page request —
   * seconds of event-loop-blocking crypto per scroll on a real library, during
   * which the whole API stalled. Forward-only, which is all the connection's
   * one consumer (the /memory/content grid) has ever used; the cursor stays
   * the file's global id, so pages issued before this change still resume.
   */
  @Query(() => FileConnection)
  async files(
    @Context() context: RequestContext,
    @Args() pagination: PaginationArgs,
  ): Promise<FileConnection> {
    if (pagination.last != null || pagination.before != null) {
      throw new Error('files: backward pagination (last/before) is not supported');
    }

    const serviceContext = toServiceContext(context);
    const limit = Math.min(pagination.first ?? FileResolver.MAX_FILES_PAGE, FileResolver.MAX_FILES_PAGE);
    const afterId = pagination.after ? GlobalUID.parse('file', pagination.after) : null;

    const { files, totalCount, hasNextPage } = await this.fileService.findPage(serviceContext, {
      limit,
      afterId,
    });

    const edges: FileEdge[] = files.map((entity) => {
      const node = FileType.toType(entity);

      return {
        node,
        cursor: node.id,
      };
    });

    return {
      edges,
      pageInfo: {
        hasNextPage,
        // `after` only ever moves forward from the start, so anything behind a
        // cursor is a previous page — the same answer the in-memory paginator
        // gave.
        hasPreviousPage: afterId != null,
        startCursor: edges.length > 0 ? edges[0].cursor : null,
        endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
      },
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
  // fileService.update() writes only title/description (UpdateFileDto = Pick<..., 'title' |
  // 'description' | 'externalUpdatedAt'>, and this resolver sends just the first two) on the row
  // matching `id`. Variants (ORIGINAL/PREVIEW/THUMBNAIL) are separate FileEntity rows linked by
  // `parentId`, so this can't reach or drop a sibling variant, and it never touches FileEntity's
  // own `deletedAt` (DeleteDateColumn) or `variant` columns — a soft-deleted row stays hidden from
  // find()/findOne() either way, and this mutation cannot flip that state.
  @GraphqlPrivacy({ destructive: false })
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

  @ResolveField(() => ItemConnection, { nullable: true, complexity: 5 })
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

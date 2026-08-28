import { UseGuards } from '@nestjs/common';
import { Args, ID, Int, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { type FindProductModelsFilter, ObjectMergeService, ProductModelService } from '@ci/domains/memory';

import { ContentLoader } from '../loaders/ContentLoader';
import { ProductIdentifierLoader } from '../loaders/ItemIdentifierLoader';
import { TagLoader } from '../loaders/TagLoader';
import { ContentType } from '../types/ContentType';
import { EntityTagType } from '../types/EntityTagType';
import { GlobalUID } from '../types/GlobalUID';
import { MergeProductModelsInput } from '../types/MergeProductModelsInput';
import { MergeProductModelsPayload, ProductMergeCountsType } from '../types/MergeProductModelsPayload';
import { ObjectIdentifierType } from '../types/ObjectIdentifierType';
import { ProductModelConnection } from '../types/ProductModelConnection';
import { ProductModelEdge } from '../types/ProductModelEdge';
import { ProductModelType } from '../types/ProductModelType';
import { decodeOffsetCursor, encodeOffsetCursor } from '../utils/offsetCursor';

const DEFAULT_PRODUCT_PAGE_SIZE = 25;

/**
 * The catalog half of the product/instance split.
 *
 * A product model is the KIND of thing — "Bose QC45" — and the units you own
 * are {@link ItemType}s that are INSTANCE_OF it. Keeping them apart is what
 * lets a GTIN identify the model (every unit shares it) while a serial
 * identifies one unit, and it is why "how many of these do I have" and "what is
 * this thing" are different questions with different answers.
 */
@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => ProductModelType)
export class ProductModelResolver {
  constructor(
    private readonly productModelService: ProductModelService,
    private readonly objectMergeService: ObjectMergeService,
    private readonly productIdentifierLoader: ProductIdentifierLoader,
    private readonly tagLoader: TagLoader,
    private readonly contentLoader: ContentLoader,
  ) {}

  /**
   * The catalog list.
   *
   * `ProductModelService.find` pages with LIMIT/OFFSET rather than a keyset —
   * the catalog is small next to the event stream and has no
   * `(created_at, id)` index to walk — so the cursor here encodes an offset.
   * One sentinel row past the page answers `hasNextPage` without a COUNT.
   */
  @Query(() => ProductModelConnection)
  async productModels(
    @Context() context: RequestContext,
    @Args('first', { type: () => Int, nullable: true }) first?: number,
    @Args('after', { type: () => String, nullable: true }) after?: string,
    @Args('query', {
      type: () => String,
      nullable: true,
      description: 'Case-insensitive substring of the title.',
    })
    query?: string,
    @Args('brand', { type: () => String, nullable: true }) brand?: string,
    @Args('category', { type: () => String, nullable: true }) category?: string,
    @Args('subcategory', { type: () => String, nullable: true }) subcategory?: string,
    @Args('productType', { type: () => String, nullable: true }) productType?: string,
    @Args('isDigital', { type: () => Boolean, nullable: true }) isDigital?: boolean,
  ): Promise<ProductModelConnection> {
    const serviceContext = toServiceContext(context);

    const limit = Math.min(Math.max(first ?? DEFAULT_PRODUCT_PAGE_SIZE, 1), 100);
    const offset = decodeOffsetCursor(after);

    const filter: FindProductModelsFilter = {
      ...(brand != null ? { brand } : {}),
      ...(category != null ? { category } : {}),
      ...(subcategory != null ? { subcategory } : {}),
      ...(productType != null ? { productType } : {}),
      ...(isDigital != null ? { isDigital } : {}),
      ...(query != null && query.trim() !== '' ? { titleContains: query } : {}),
      // One past the page, so `hasNextPage` costs a row instead of a COUNT.
      limit: limit + 1,
      offset,
    };

    const rows = await this.productModelService.find(serviceContext, filter);
    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;

    const edges: ProductModelEdge[] = page.map((product, index) => ({
      node: ProductModelType.toType(product),
      cursor: encodeOffsetCursor(offset + index + 1),
    }));

    return {
      edges,
      pageInfo: {
        hasNextPage,
        hasPreviousPage: offset > 0,
        startCursor: edges[0]?.cursor ?? null,
        endCursor: edges[edges.length - 1]?.cursor ?? null,
      },
      // No COUNT is issued; this is what the page holds, not the catalog.
      totalCount: edges.length,
    };
  }

  @Query(() => ProductModelType, { nullable: true })
  async productModel(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<ProductModelType | null> {
    const serviceContext = toServiceContext(context);

    const product = await this.productModelService.findById(serviceContext, GlobalUID.parse('product', gid));

    return product ? ProductModelType.toType(product) : null;
  }

  /**
   * Merge duplicate catalog models into one: re-points identifier claims, the
   * owned units that are instances of the sources, receipt lines and sightings,
   * folds the fields, and tombstones the sources.
   */
  @Mutation(() => MergeProductModelsPayload)
  async mergeProductModels(
    @Context() context: RequestContext,
    @Args('input') input: MergeProductModelsInput,
  ): Promise<MergeProductModelsPayload> {
    const serviceContext = toServiceContext(context);

    const sourceIds = input.sourceIds.map((gid) => GlobalUID.parse('product', gid));
    const targetId = GlobalUID.parse('product', input.targetId);

    const { target, counts } = await this.objectMergeService.mergeProductModels(
      serviceContext,
      sourceIds,
      targetId,
    );

    return {
      success: true,
      product: ProductModelType.toType(target),
      counts: ProductMergeCountsType.toType(counts),
    };
  }

  /** Codes claimed by the MODEL — a GTIN, an ASIN, an MPN. */
  @ResolveField(() => [ObjectIdentifierType])
  async identifiers(
    @Context() context: RequestContext,
    @Parent() parent: ProductModelType,
  ): Promise<ObjectIdentifierType[]> {
    const serviceContext = toServiceContext(context);

    const rows = await this.productIdentifierLoader.load(serviceContext, parent.__source.id);

    return rows.map((row) => ObjectIdentifierType.toType(row));
  }

  /**
   * The stock photo, ready to render.
   *
   * `image_content_id` is a bare `ci.content` id with no FK, so the picture was
   * a second round-trip issued by the card that displayed it. Batched here for
   * the same reason as ObjectObservationType.media: a card is a card, and a
   * catalog grid of them must not cost one request per tile.
   */
  @ResolveField(() => ContentType, { nullable: true })
  async image(
    @Context() context: RequestContext,
    @Parent() parent: ProductModelType,
  ): Promise<ContentType | null> {
    if (parent.__source.imageContentId == null) {
      return null;
    }

    const content = await this.contentLoader.load(toServiceContext(context), parent.__source.imageContentId);

    return content ? ContentType.toType(content) : null;
  }

  @ResolveField(() => [EntityTagType])
  async tags(
    @Context() context: RequestContext,
    @Parent() parent: ProductModelType,
  ): Promise<EntityTagType[]> {
    const serviceContext = toServiceContext(context);

    const tags = await this.tagLoader.load(serviceContext, {
      type: 'product',
      id: parent.__source.id,
    });

    return tags.map((tag) => EntityTagType.toType(tag));
  }
}

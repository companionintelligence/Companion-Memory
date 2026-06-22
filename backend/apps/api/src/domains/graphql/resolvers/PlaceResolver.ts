import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Parent, Query, Resolver, ResolveField } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { PlaceService } from '@ci/domains/memory';

import { TagLoader } from '../loaders/TagLoader';
import { CreatePlaceInput } from '../types/CreatePlaceInput';
import { EntityTagType } from '../types/EntityTagType';
import { GlobalUID } from '../types/GlobalUID';
import { PaginationArgs } from '../types/PaginationArgs';
import { PlaceConnection } from '../types/PlaceConnection';
import { PlaceEdge } from '../types/PlaceEdge';
import { PlaceType } from '../types/PlaceType';
import { UpdatePlaceInput } from '../types/UpdatePlaceInput';
import { Paginator } from '../utils/Paginator';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => PlaceType)
export class PlaceResolver {
  constructor(
    private readonly placeService: PlaceService,
    private readonly tagLoader: TagLoader,
  ) {}

  @Mutation(() => PlaceType)
  async createPlace(
    @Context() context: RequestContext,
    @Args('input') input: CreatePlaceInput,
  ): Promise<PlaceType> {
    const serviceContext = toServiceContext(context);

    const properties = input.properties || {};

    if (input.type) {
      properties.type = input.type;
    }

    if (input.geoFormat) {
      properties.geoFormat = input.geoFormat;
    }

    if (input.geolocation) {
      properties.geolocation = input.geolocation;
    }

    if (input.locationBoundary) {
      properties.locationBoundary = input.locationBoundary;
    }

    if (input.estimated) {
      properties.estimated = input.estimated;
    }

    if (input.tracked) {
      properties.tracked = input.tracked;
    }

    if (input.uploaded) {
      properties.uploaded = input.uploaded;
    }

    const entity = await this.placeService.create(serviceContext, {
      name: input.name,
      entity_type: 'Location',
      properties,
      description: input.description,
    });

    return PlaceType.toType(entity[0]);
  }

  @Mutation(() => PlaceType, { nullable: true })
  async updatePlace(
    @Context() context: RequestContext,
    @Args('input') input: UpdatePlaceInput,
  ): Promise<PlaceType | null> {
    const serviceContext = toServiceContext(context);

    const properties = input.properties || {};

    if (input.type) {
      properties.type = input.type;
    }

    if (input.geoFormat) {
      properties.geoFormat = input.geoFormat;
    }

    if (input.geolocation) {
      properties.geolocation = input.geolocation;
    }

    if (input.locationBoundary) {
      properties.locationBoundary = input.locationBoundary;
    }

    if (input.estimated) {
      properties.estimated = input.estimated;
    }

    if (input.tracked) {
      properties.tracked = input.tracked;
    }

    if (input.uploaded) {
      properties.uploaded = input.uploaded;
    }

    const id = GlobalUID.parse('place', input.id);

    const entity = await this.placeService.update(serviceContext, id, {
      name: input.name,
      properties,
      description: input.description,
    });

    return entity ? PlaceType.toType(entity) : entity;
  }

  @Mutation(() => Boolean)
  async removePlace(@Context() context: RequestContext, @Args('id') id: string): Promise<boolean> {
    const serviceContext = toServiceContext(context);

    return this.placeService.remove(serviceContext, id);
  }

  @Query(() => PlaceConnection)
  async places(
    @Context() context: RequestContext,
    @Args() pagination: PaginationArgs,
  ): Promise<PlaceConnection> {
    const serviceContext = toServiceContext(context);

    const entities = await this.placeService.findAll(serviceContext);

    const { slice, pageInfo, totalCount } = Paginator.paginate(entities, {
      ...pagination,
      getId: (entity) => GlobalUID.encode('place', entity.id),
    });

    const edges: PlaceEdge[] = slice.map((entity) => {
      const node = PlaceType.toType(entity);

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

  @Query(() => PlaceType, { nullable: true })
  async place(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<PlaceType | null> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('place', gid);

    const entity = await this.placeService.findById(serviceContext, id);

    return entity ? PlaceType.toType(entity) : null;
  }

  @ResolveField(() => [EntityTagType])
  async tags(@Context() context: RequestContext, @Parent() parent: PlaceType): Promise<EntityTagType[]> {
    const serviceContext = toServiceContext(context);

    const tags = await this.tagLoader.load(serviceContext, {
      type: 'place',
      id: parent.__source.id,
    });

    return tags.map((tag) => EntityTagType.toType(tag));
  }
}

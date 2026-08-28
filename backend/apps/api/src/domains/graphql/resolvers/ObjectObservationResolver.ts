import { BadRequestException, UseGuards } from '@nestjs/common';
import { Args, ID, Int, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ObjectObservationService } from '@ci/domains/memory';

import { ContentLoader } from '../loaders/ContentLoader';
import { PlaceLoader } from '../loaders/PlaceLoader';
import { ContentType } from '../types/ContentType';
import { GlobalUID } from '../types/GlobalUID';
import { ObjectObservationType } from '../types/ObjectObservationType';
import { PlaceType } from '../types/PlaceType';

const DEFAULT_REVIEW_LIMIT = 50;
const MAX_REVIEW_LIMIT = 200;

/**
 * Sightings, and the human half of resolving them.
 *
 * An observation is the WEAK claim — "a coffee mug is visible in this photo" —
 * and it is deliberately not the same statement as "I own this coffee mug".
 * Nothing in this resolver creates an owned unit; the only automatic write in
 * the whole area is linking a sighting to a unit that already exists, and
 * minting has exactly one legitimate trigger, which is a purchase.
 */
@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => ObjectObservationType)
export class ObjectObservationResolver {
  constructor(
    private readonly observationService: ObjectObservationService,
    private readonly contentLoader: ContentLoader,
    private readonly placeLoader: PlaceLoader,
  ) {}

  /**
   * The review queue: sightings nobody has confirmed and nothing has resolved,
   * newest first. Backed by `object_observations_review_idx`, the partial index
   * added for exactly this query.
   */
  @Query(() => [ObjectObservationType])
  async unresolvedObservations(
    @Context() context: RequestContext,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
    @Args('offset', { type: () => Int, nullable: true }) offset?: number,
  ): Promise<ObjectObservationType[]> {
    const serviceContext = toServiceContext(context);

    const bounded = Math.min(Math.max(limit ?? DEFAULT_REVIEW_LIMIT, 1), MAX_REVIEW_LIMIT);

    const rows = await this.observationService.findForReview(
      serviceContext,
      bounded,
      Math.max(offset ?? 0, 0),
    );

    return rows.map((row) => ObjectObservationType.toType(row));
  }

  /**
   * The frame this sighting was made in, ready to render.
   *
   * The crop wins over the full frame: it is the tighter picture of the THING,
   * which is what a review tile is asking the user to judge. The full frame is
   * the fallback for a sighting no crop was written for.
   *
   * Batched, and batched deliberately: a `ci.object_observations` row stores a
   * bare content id and no FK, so before this field every tile fetched its own
   * picture — a 24-tile review page cost 24 round-trips, plus 24 more for the
   * places below, against an `ApolloProvider` on a plain `createHttpLink` that
   * coalesces nothing. Resolving it here collapses the page to one request, and
   * the two hops behind it (content -> file -> preview variant) are themselves
   * batched by {@link ContentLoader} and ContentResolver's ContentFileLoader.
   */
  @ResolveField(() => ContentType, {
    nullable: true,
    description: 'The cropped thumbnail of the sighting, or the whole frame when there is no crop.',
  })
  async media(
    @Context() context: RequestContext,
    @Parent() parent: ObjectObservationType,
  ): Promise<ContentType | null> {
    const contentId = parent.__source.cropContentId ?? parent.__source.contentId;

    if (contentId == null) {
      return null;
    }

    const content = await this.contentLoader.load(toServiceContext(context), contentId);

    return content ? ContentType.toType(content) : null;
  }

  /** Where the sighting happened. Batched for the same reason as {@link media}. */
  @ResolveField(() => PlaceType, { nullable: true })
  async place(
    @Context() context: RequestContext,
    @Parent() parent: ObjectObservationType,
  ): Promise<PlaceType | null> {
    if (parent.__source.placeEntityId == null) {
      return null;
    }

    const place = await this.placeLoader.load(toServiceContext(context), parent.__source.placeEntityId);

    return place ? PlaceType.toType(place) : null;
  }

  /**
   * A human says this sighting IS that thing.
   *
   * The only path that sets `confirmed_by_user`, which is why it is a mutation
   * of its own rather than a flag on a generic update: downstream consumers
   * read that column as "a person looked at this", and it would stop meaning
   * that the moment a machine could write it. The resolution method becomes
   * `user` — after a person has looked, the method that matters is that a
   * person looked.
   */
  @Mutation(() => ObjectObservationType, { nullable: true })
  async confirmObservation(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
    @Args('itemId', {
      type: () => ID,
      nullable: true,
      description: 'The owned unit this sighting is of. Omit to confirm the resolution already on the row.',
    })
    itemId?: string,
    @Args('productId', { type: () => ID, nullable: true }) productId?: string,
  ): Promise<ObjectObservationType | null> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('observation', gid);

    const resolution = {
      ...(itemId !== undefined ? { resolvedObjectId: GlobalUID.parse('item', itemId) } : {}),
      ...(productId !== undefined ? { resolvedProductId: GlobalUID.parse('product', productId) } : {}),
    };

    const row = await this.observationService.confirm(
      serviceContext,
      id,
      true,
      Object.keys(resolution).length > 0 ? resolution : undefined,
    );

    if (row == null) {
      throw new BadRequestException('No such observation.');
    }

    return ObjectObservationType.toType(row);
  }

  /**
   * A human says this sighting is NOT that thing.
   *
   * Clears the link and leaves the sighting: "that is not my mug" is evidence
   * about the link, never evidence that the photo has no mug in it. Keeping the
   * observation is the whole reason sightings and possessions are separate
   * tables.
   */
  @Mutation(() => ObjectObservationType, { nullable: true })
  async rejectObservation(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<ObjectObservationType | null> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('observation', gid);

    const row = await this.observationService.confirm(serviceContext, id, false, {
      resolvedObjectId: null,
      resolvedProductId: null,
    });

    if (row == null) {
      throw new BadRequestException('No such observation.');
    }

    return ObjectObservationType.toType(row);
  }
}

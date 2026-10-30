import { UseGuards } from '@nestjs/common';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { isGeocodingConfigured } from '@ci/configuration';
import { DailyMetricsService } from '@ci/domains/daily-metrics';
import { type KnownPlaceKind, KnownPlacesService, type KnownPlaceSource } from '@ci/domains/memory';
import { TagService } from '@ci/domains/search-next';

import { GraphqlPrivacy } from '../decorators/GraphqlPrivacy';
import { KnownPlaceCandidateType } from '../types/KnownPlaceCandidateType';
import { KnownPlaceType } from '../types/KnownPlaceType';
import { UpdateKnownPlaceInput } from '../types/UpdateKnownPlaceInput';

const KNOWN_PLACE_KINDS: readonly KnownPlaceKind[] = ['home', 'work', 'school', 'social', 'other'];
const KNOWN_PLACE_SOURCES: readonly KnownPlaceSource[] = ['manual', 'inferred', 'geocoded'];

function parseKind(value: string | undefined, fallback: KnownPlaceKind): KnownPlaceKind {
  return (KNOWN_PLACE_KINDS as readonly string[]).includes(value ?? '')
    ? (value as KnownPlaceKind)
    : fallback;
}

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => KnownPlaceType)
export class KnownPlacesResolver {
  constructor(
    private readonly knownPlacesService: KnownPlacesService,
    private readonly dailyMetricsService: DailyMetricsService,
    private readonly tagService: TagService,
  ) {}

  /** The user's confirmed known places (LIVES_IN/WORKS_AT/VISITED), optionally filtered by kind. */
  @Query(() => [KnownPlaceType])
  async knownPlaces(
    @Context() context: RequestContext,
    @Args('kind', { type: () => String, nullable: true }) kind?: string,
  ): Promise<KnownPlaceType[]> {
    const serviceContext = toServiceContext(context);

    const kindFilter =
      kind && (KNOWN_PLACE_KINDS as readonly string[]).includes(kind) ? (kind as KnownPlaceKind) : undefined;

    const places = await this.knownPlacesService.getKnownPlaces(serviceContext, kindFilter);
    const refs = places.map((place) => ({ type: 'place' as const, id: place.locationId }));
    const tagsByPlace = await this.tagService.getTagsForEntities(serviceContext, refs);

    return places.map((place, index) =>
      KnownPlaceType.toType(
        place,
        (tagsByPlace.get(refs[index]) ?? []).map((tag) => tag.label),
      ),
    );
  }

  /**
   * Not-yet-confirmed Home/Work/other candidates inferred from the event stream,
   * for display as confirmable insights.
   */
  @Query(() => [KnownPlaceCandidateType])
  async knownPlaceCandidates(@Context() context: RequestContext): Promise<KnownPlaceCandidateType[]> {
    const serviceContext = toServiceContext(context);

    const candidates = await this.knownPlacesService.buildKnownPlaces(serviceContext);

    return candidates.map((candidate) => KnownPlaceCandidateType.toType(candidate));
  }

  /**
   * Whether reverse-geocoding is set up on this appliance. A GPS-only known-
   * place candidate with no name defaults its label to "Unknown place" and
   * kind to "other" (KnownPlacesService.clusterToCandidate) whether or not
   * geocoding has ever run — a client needs this fact to tell "not yet named"
   * from "genuinely unclassifiable" apart in the UI.
   */
  @Query(() => Boolean)
  geocodingConfigured(): boolean {
    return isGeocodingConfigured();
  }

  /** Confirm / update a known place, upserting the LIVES_IN/WORKS_AT/VISITED graph relationship. */
  @Mutation(() => KnownPlaceType)
  // Upserts one (kind, place) relationship; other known places are untouched.
  @GraphqlPrivacy({ destructive: false })
  async updateKnownPlace(
    @Context() context: RequestContext,
    @Args('input') input: UpdateKnownPlaceInput,
  ): Promise<KnownPlaceType> {
    const serviceContext = toServiceContext(context);

    const source =
      input.source && (KNOWN_PLACE_SOURCES as readonly string[]).includes(input.source)
        ? (input.source as KnownPlaceSource)
        : 'manual';

    const kind = parseKind(input.kind, 'other');
    const place = await this.knownPlacesService.updateKnownPlace(serviceContext, {
      knownPlaceId: input.knownPlaceId,
      label: input.label,
      kind,
      locationId: input.locationId ?? null,
      coordinates: input.coordinates ?? null,
      confidence: input.confidence,
      activeFrom: input.activeFrom,
      activeTo: input.activeTo ?? null,
      aliases: input.aliases,
      source,
    });

    if (input.tags !== undefined) {
      await this.tagService.replaceEntityTags(
        serviceContext,
        { type: 'place', id: place.locationId },
        input.tags,
      );
    }

    if (kind === 'home') {
      void this.dailyMetricsService.refreshForUser(serviceContext).catch(() => undefined);
    }

    const tags = await this.tagService.getTagsForEntity(serviceContext, {
      type: 'place',
      id: place.locationId,
    });

    return KnownPlaceType.toType(
      place,
      tags.map((tag) => tag.label),
    );
  }
}

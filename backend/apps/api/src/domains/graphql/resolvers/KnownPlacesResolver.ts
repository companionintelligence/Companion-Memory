import { UseGuards } from '@nestjs/common';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { type KnownPlaceKind, KnownPlacesService, type KnownPlaceSource } from '@ci/domains/memory';

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
  constructor(private readonly knownPlacesService: KnownPlacesService) {}

  /** The user's confirmed known places (LIVES_IN/WORKS_AT/VISITED), optionally filtered by kind. */
  @Query(() => [KnownPlaceType])
  async knownPlaces(
    @Context() context: RequestContext,
    @Args('kind', { type: () => String, nullable: true }) kind?: string,
  ): Promise<KnownPlaceType[]> {
    const serviceContext = toServiceContext(context);

    const kindFilter =
      kind && (KNOWN_PLACE_KINDS as readonly string[]).includes(kind) ? (kind as KnownPlaceKind) : undefined;

    const labels = await this.knownPlacesService.getKnownPlaces(serviceContext, kindFilter);

    return labels.map((label) => KnownPlaceType.toType(label));
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

  /** Confirm / update a known place, upserting the LIVES_IN/WORKS_AT/VISITED graph relationship. */
  @Mutation(() => KnownPlaceType)
  async updateKnownPlace(
    @Context() context: RequestContext,
    @Args('input') input: UpdateKnownPlaceInput,
  ): Promise<KnownPlaceType> {
    const serviceContext = toServiceContext(context);

    const source =
      input.source && (KNOWN_PLACE_SOURCES as readonly string[]).includes(input.source)
        ? (input.source as KnownPlaceSource)
        : 'manual';

    const label = await this.knownPlacesService.updateKnownPlace(serviceContext, {
      label: input.label,
      kind: parseKind(input.kind, 'other'),
      locationId: input.locationId ?? null,
      coordinates: input.coordinates ?? null,
      confidence: input.confidence,
      activeFrom: input.activeFrom,
      activeTo: input.activeTo ?? null,
      aliases: input.aliases,
      source,
    });

    return KnownPlaceType.toType(label);
  }
}

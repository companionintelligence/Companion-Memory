import { UseGuards } from '@nestjs/common';
import { Args, Query, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { PositionService } from '@ci/domains/position';

import { PositionTrackExtentType } from '../types/PositionTrackExtentType';
import { PositionTrackInput } from '../types/PositionTrackInput';
import { PositionTrackType } from '../types/PositionTrackType';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => PositionTrackType)
export class PositionResolver {
  constructor(private readonly positionService: PositionService) {}

  /**
   * The signed-in user's location history, as a keyset-paged, downsampled
   * trace.
   *
   * ── Why the map needed this ────────────────────────────────────────────────
   * `mapPins` answers located EVENTS, and on the QA appliance that is 121 pins.
   * `ci.position` — the actual GPS history — holds 63,044 fixes spanning
   * 2013-05-28 → 2026-08-21, and no map query read it at all. The map was not
   * broken so much as pointed at the wrong table.
   *
   * ── Why it is a separate query rather than more pins ───────────────────────
   * A fix is not a memory. It has no title to show in a popup, no detail sheet
   * to open, and no business being clustered into a numbered bubble alongside
   * things that happened. It is a line and a density — a layer of its own, on
   * top of the pins, which is how the client renders it.
   *
   * Scoping is structural, not conditional: `toServiceContext` yields a
   * {@link UserServiceContext} (a concrete `userId`, never SYSTEM_USER) and
   * `PositionService.findTrack` accepts nothing else, so there is no shape of
   * input that makes this read answer for somebody else's whereabouts. Unlike
   * `mapPins` there is deliberately no share-token path either: a saved search
   * shares memories the owner chose, and nobody has ever chosen to share
   * thirteen years of raw GPS.
   */
  @Query(() => PositionTrackType, {
    description:
      "The signed-in user's location history (ci.position) as a downsampled, keyset-paged " +
      'trace for the map. Filtered by viewport bounding box and time range.',
  })
  async positionTrack(
    @Context() context: RequestContext,
    @Args('input', { nullable: true }) input?: PositionTrackInput,
  ): Promise<PositionTrackType> {
    const serviceContext = toServiceContext(context);

    const page = await this.positionService.findTrack(serviceContext, {
      startTime: parseInstant(input?.startTime),
      endTime: parseInstant(input?.endTime),
      bbox: input?.bbox,
      first: input?.first,
      after: input?.after,
      maxPoints: input?.maxPoints,
    });

    return page;
  }

  /**
   * The signed-in user's whole `ci.position` history at a glance — first fix,
   * last fix, count — for a control (a playback scrubber) that needs to span
   * itself against the user's real history before requesting a single page
   * of {@link positionTrack}. Same scoping guarantee as that query: `context`
   * yields a concrete `userId`, never SYSTEM_USER, so there is no input shape
   * that answers for anyone but the caller. Returns null rather than a
   * zeroed extent when the user has no position history at all, so a caller
   * can tell "no track" from "a track starting at the epoch".
   */
  @Query(() => PositionTrackExtentType, {
    nullable: true,
    description: "The signed-in user's whole ci.position history (first fix, last fix, count), unpaged.",
  })
  async positionTrackExtent(
    @Context() context: RequestContext,
    @Args('input', { nullable: true }) input?: PositionTrackInput,
  ): Promise<PositionTrackExtentType | null> {
    const serviceContext = toServiceContext(context);

    return this.positionService.getTrackExtent(serviceContext, {
      startTime: parseInstant(input?.startTime),
      endTime: parseInstant(input?.endTime),
      bbox: input?.bbox,
    });
  }
}

/**
 * An unparseable date is dropped rather than thrown on: the map builds these
 * from URL params, and a hand-edited `?start=` should widen the trace, not
 * error the whole map out. Note this is stricter than `SearchResolver`, which
 * passes `new Date(input.startTime)` straight through — an Invalid Date there
 * reaches SQL and compares false against every row, silently emptying the feed.
 */
function parseInstant(value?: string | null): Date | undefined {
  if (value == null || value.length === 0) {
    return undefined;
  }

  const parsed = new Date(value);

  return isNaN(parsed.getTime()) ? undefined : parsed;
}

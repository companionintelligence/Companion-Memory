import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';

/**
 * One located event, reduced to what a map marker actually draws.
 *
 * The memory map used to borrow the explorer's paginated `search` feed, which
 * hands back 30 fully-hydrated nodes per request — roughly 350 "Load more pins"
 * presses to plot a library of ten thousand located events. Pins do not need a
 * hydrated node: they need a point, a label and enough of a timestamp to order
 * and caption them, which is what this type is. Everything else about the event
 * is fetched on demand when the user opens one (`event(id:)`).
 */
@ObjectType()
export class MapPinType {
  /** GlobalUID of the underlying event — the same id `search` returns, so a pin
   *  and an explorer row for the same event match by id. */
  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  title!: string | null;

  @Field(() => Float)
  latitude!: number;

  @Field(() => Float)
  longitude!: number;

  @Field(() => Date, { nullable: true })
  startTime!: Date | null;

  @Field(() => Date, { nullable: true })
  endTime!: Date | null;

  @Field(() => String, { nullable: true })
  eventType!: string | null;

  @Field(() => String, { nullable: true })
  locationName!: string | null;

  /**
   * `EventEntity.timeSource` — `'ingest'` marks `startTime` as the import wall
   * clock rather than a real moment (a Google Maps saved place, an undated
   * Reddit affiliation, …). The client uses this to caption the pin "Date
   * unknown" instead of a fabricated time, mirroring `getEntityTimestamp`'s
   * treatment of `EventType.timeSource` on the timeline/explorer side.
   */
  @Field(() => String, { nullable: true })
  timeSource!: string | null;
}

/** The map's whole pin set for the current filters, plus how much of it was returned. */
@ObjectType()
export class MapPinsType {
  @Field(() => [MapPinType])
  pins!: MapPinType[];

  /**
   * Located events matching the filters, ignoring the pin cap — so the UI can
   * say "10,000 of 12,431 pins" instead of silently drawing a partial world.
   */
  @Field(() => Int)
  totalCount!: number;

  /** True when the cap cut the set short (`pins.length < totalCount`). */
  @Field(() => Boolean)
  truncated!: boolean;
}

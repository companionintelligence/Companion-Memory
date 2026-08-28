import { Field, Float, Int, ObjectType } from '@nestjs/graphql';

/**
 * One point on the map's location trace.
 *
 * The map's other geographic read, {@link MapPinType}, answers located EVENTS —
 * 121 of them on the QA appliance. This one answers `ci.position`, the raw GPS
 * history: 63,044 fixes over thirteen years that no map query had ever touched,
 * which is why the map looked empty. A trace point is smaller than a pin
 * because it has less to say: where, when, and how many fixes it stands for.
 *
 * When the read is downsampled a point stands for a whole time bucket. The
 * coordinate is then the bucket's FIRST real fix — never an average of the
 * bucket, which would place the user in the middle of the ocean for any bucket
 * spanning a flight.
 */
@ObjectType()
export class PositionPointType {
  /** First fix in the bucket (the fix's own time when the read is raw). */
  @Field(() => Date)
  startTime!: Date;

  /** Last fix in the bucket (equal to `startTime` when the read is raw). */
  @Field(() => Date)
  endTime!: Date;

  @Field(() => Float)
  latitude!: number;

  @Field(() => Float)
  longitude!: number;

  /**
   * Fixes this point stands for — 1 when raw, the bucket's weight when
   * downsampled. A heat layer weights by this; a plain trace ignores it.
   */
  @Field(() => Int)
  fixCount!: number;

  /** 'still' / 'walking' / 'in_vehicle' / … as the source reported it. */
  @Field(() => String, { nullable: true })
  activityType!: string | null;

  /** Opaque keyset cursor resuming strictly after this point. */
  @Field(() => String)
  cursor!: string;
}

/** One page of the location trace, plus everything needed to ask for the next. */
@ObjectType()
export class PositionTrackType {
  @Field(() => [PositionPointType])
  points!: PositionPointType[];

  @Field(() => Boolean)
  hasNextPage!: boolean;

  /** Pass back as `input.after` to continue. Null when the page is empty. */
  @Field(() => String, { nullable: true })
  endCursor!: string | null;

  /**
   * Bucket width the server downsampled with, or null when the points are raw
   * fixes. Surfaced so the client can say how coarse the trace it is drawing
   * is, rather than implying every fix is on screen.
   */
  @Field(() => Int, { nullable: true })
  bucketSeconds!: number | null;

  /**
   * Raw fixes matching the filters, ignoring the downsample and the page cap.
   *
   * Answered on the FIRST page only — null on continuations. A COUNT(*) is a
   * second scan of the same rows and its answer cannot change between pages of
   * one walk, so charging every page for it would double the cost of the trace.
   */
  @Field(() => Int, { nullable: true })
  totalCount!: number | null;
}

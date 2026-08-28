import { Field, Int, ObjectType } from '@nestjs/graphql';

/**
 * The user's whole `ci.position` history, summarized to three numbers.
 *
 * Answers "how much history is there, and how far back does it go" without
 * paging through any of it — for a control (a playback scrubber) that needs
 * to span itself against the user's real history before the first page of
 * `positionTrack` has even been requested.
 */
@ObjectType()
export class PositionTrackExtentType {
  /** Epoch time of the earliest fix. */
  @Field(() => Date)
  start!: Date;

  /** Epoch time of the latest fix. */
  @Field(() => Date)
  end!: Date;

  @Field(() => Int)
  count!: number;
}

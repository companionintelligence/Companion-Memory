import { Field, InputType } from '@nestjs/graphql';

@InputType()
export class UpdateNoteInput {
  @Field()
  id!: string;

  @Field({ nullable: true })
  title?: string;

  @Field({ nullable: true })
  content?: string;

  /**
   * The note's `updatedAt` as the client last saw it. When it is given, the note is only
   * written if it still has that `updatedAt`. If it was changed since, nothing is
   * written and the payload carries `success: false` with the note as stored. The web
   * editor sends it when it tries a failed save again on its own, so an edit typed
   * before an outage cannot land over a newer one made somewhere else.
   */
  @Field(() => Date, { nullable: true })
  expectedUpdatedAt?: Date;
}

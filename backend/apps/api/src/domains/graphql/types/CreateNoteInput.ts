import { Field, InputType } from '@nestjs/graphql';

@InputType()
export class CreateNoteInput {
  /**
   * The note's global id, when the client minted it before the note reached
   * the server — a phone's offline replica (PowerSync) creates the row under
   * its own id and replays the create later, and the id must survive so the
   * row syncing back down is the same row. Omit it for an ordinary create.
   */
  @Field({ nullable: true })
  id?: string;

  @Field({ nullable: true })
  title?: string;

  @Field({ nullable: true })
  content?: string;
}

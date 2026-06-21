import { Field, ID, InputType } from '@nestjs/graphql';

@InputType()
export class EventMediaInput {
  // Id of a file already uploaded to ci.files (deduped by hash on upload).
  @Field(() => ID)
  fileId!: string;

  // Optional role, e.g. 'attachment' | 'photo' | 'media'.
  @Field(() => String, { nullable: true })
  role?: string;
}

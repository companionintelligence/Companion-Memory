import { Field, InputType } from '@nestjs/graphql';

@InputType()
export class UpdateNoteInput {
  @Field()
  id!: string;

  @Field({ nullable: true })
  title?: string;

  @Field({ nullable: true })
  content?: string;
}

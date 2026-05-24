import { Field, ObjectType } from '@nestjs/graphql';

import { MutationPayload } from './MutationPayload';
import { NoteType } from './NoteType';

@ObjectType()
export class CreateNotePayload extends MutationPayload {
  @Field(() => NoteType, { nullable: true })
  note?: NoteType;
}

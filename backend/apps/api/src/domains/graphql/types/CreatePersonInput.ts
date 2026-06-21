import { Field, InputType } from '@nestjs/graphql';

@InputType()
export class CreatePersonInput {
  @Field()
  name!: string;

  @Field({ nullable: true })
  description?: string;

  // External provenance key for idempotent resolve-or-create from a capture
  // source (e.g. linkedTable='ci-import-tools:contact', linkedId='dana@x.com').
  // Re-sending the same (linkedTable, linkedId) returns the existing person.
  @Field({ nullable: true })
  linkedTable?: string;

  @Field({ nullable: true })
  linkedId?: string;
}

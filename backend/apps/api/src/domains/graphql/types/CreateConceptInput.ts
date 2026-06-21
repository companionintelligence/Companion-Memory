import { Field, InputType } from '@nestjs/graphql';

@InputType()
export class CreateConceptInput {
  @Field()
  name!: string;

  @Field({ nullable: true })
  description?: string;

  // External provenance key for idempotent resolve-or-create from a capture
  // source (e.g. linkedTable='ci-import-tools:thread', linkedId='thr-1').
  // Re-sending the same (linkedTable, linkedId) returns the existing concept.
  @Field({ nullable: true })
  linkedTable?: string;

  @Field({ nullable: true })
  linkedId?: string;
}

import { Field, Int, ObjectType } from '@nestjs/graphql';

/**
 * Outcome of a bulkIngestItemRelationships batch. `inserted` is the count of new
 * item↔item edges written; `skipped` is everything deduped (already present on a
 * re-send, or a duplicate within the batch). inserted + skipped == input length.
 */
@ObjectType()
export class BulkItemRelationshipResult {
  @Field(() => Int)
  inserted!: number;

  @Field(() => Int)
  skipped!: number;
}

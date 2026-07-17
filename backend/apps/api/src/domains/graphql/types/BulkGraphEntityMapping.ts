import { Field, ID, ObjectType } from '@nestjs/graphql';

/**
 * One input-entity key from a bulkIngestGraph batch mapped to the server-side
 * ci.entities UUID it resolved to or was created as. The importer caches these
 * so later batches can reference the same entities without re-sending them.
 */
@ObjectType()
export class BulkGraphEntityMapping {
  @Field(() => String)
  key!: string;

  @Field(() => ID)
  entityId!: string;
}

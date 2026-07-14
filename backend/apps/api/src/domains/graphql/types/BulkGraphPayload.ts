import { Field, Int, ObjectType } from '@nestjs/graphql';

import { BulkGraphEntityMapping } from './BulkGraphEntityMapping';

@ObjectType()
export class BulkGraphPayload {
  @Field(() => Boolean)
  success!: boolean;

  @Field(() => Int)
  entitiesProcessed!: number;

  @Field(() => Int)
  relationshipsProcessed!: number;

  @Field(() => [String])
  errors!: string[];

  /**
   * key → ci.entities UUID for every input entity that upserted (created or
   * resolved to an existing row). Entities that failed are absent here and
   * reported in `errors`.
   */
  @Field(() => [BulkGraphEntityMapping])
  entities!: BulkGraphEntityMapping[];
}

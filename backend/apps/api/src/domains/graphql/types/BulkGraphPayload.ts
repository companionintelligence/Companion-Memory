import { Field, Int, ObjectType } from '@nestjs/graphql';

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
}

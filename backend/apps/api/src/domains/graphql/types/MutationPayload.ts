import { Field, ObjectType } from '@nestjs/graphql';

@ObjectType({ isAbstract: true })
export abstract class MutationPayload {
  @Field(() => Boolean)
  success!: boolean;
}

import { Field, ObjectType } from '@nestjs/graphql';

import { MutationPayload } from './MutationPayload';

@ObjectType()
export class StartPairingPayload extends MutationPayload {
  @Field(() => String, { nullable: true })
  pairingToken?: string;

  @Field(() => String, { nullable: true })
  pollKey?: string;

  @Field(() => String, { nullable: true })
  pairingPath?: string;

  @Field(() => String, { nullable: true })
  errorMessage?: string;
}

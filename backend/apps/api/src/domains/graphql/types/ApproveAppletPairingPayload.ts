import { Field, ObjectType } from '@nestjs/graphql';

import { MutationPayload } from './MutationPayload';

@ObjectType()
export class ApproveAppletPairingPayload extends MutationPayload {
  @Field(() => String, { nullable: true })
  deviceId?: string | null;

  @Field(() => String, { nullable: true })
  errorMessage?: string | null;
}

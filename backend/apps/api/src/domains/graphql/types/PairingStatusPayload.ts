import { Field, ObjectType } from '@nestjs/graphql';

import { MutationPayload } from './MutationPayload';

@ObjectType()
export class PairingStatusPayload extends MutationPayload {
  // PENDING | COMPLETED | EXPIRED | NOT_FOUND
  @Field(() => String)
  status!: string;

  @Field(() => String, { nullable: true })
  userId?: string | null;

  @Field(() => String, { nullable: true })
  userName?: string | null;

  @Field(() => String, { nullable: true })
  userEmail?: string | null;

  @Field(() => String, { nullable: true })
  deviceId?: string | null;

  @Field(() => String, { nullable: true })
  appletAccessToken?: string | null;

  @Field(() => String, { nullable: true })
  errorMessage?: string | null;
}

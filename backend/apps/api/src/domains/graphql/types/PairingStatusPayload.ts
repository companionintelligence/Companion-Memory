import { Field, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class PairingStatusPayload {
  @Field(() => Boolean)
  success!: boolean;

  @Field(() => String)
  status!: string;

  @Field(() => String, { nullable: true })
  userId?: string;

  @Field(() => String, { nullable: true })
  userName?: string;

  @Field(() => String, { nullable: true })
  userEmail?: string;

  @Field(() => String, { nullable: true })
  deviceId?: string;

  @Field(() => String, { nullable: true })
  appletAccessToken?: string;

  @Field(() => String, { nullable: true })
  errorMessage?: string;
}

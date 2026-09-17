import { Field, InputType } from '@nestjs/graphql';

/** Shape of the browser `PushSubscription` object, flattened for GraphQL. */
@InputType()
export class PushSubscriptionInput {
  @Field()
  endpoint!: string;

  @Field({ description: 'PushSubscription.getKey("p256dh"), base64url-encoded.' })
  p256dh!: string;

  @Field({ description: 'PushSubscription.getKey("auth"), base64url-encoded.' })
  auth!: string;

  @Field({ nullable: true })
  userAgent?: string;
}

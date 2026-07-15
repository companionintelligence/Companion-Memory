import { Field, InputType } from '@nestjs/graphql';

@InputType()
export class UpdateCurrentUserInput {
  // IANA timezone name, e.g. 'America/New_York'. Validated in the resolver.
  @Field({ nullable: true })
  timezone?: string;
}

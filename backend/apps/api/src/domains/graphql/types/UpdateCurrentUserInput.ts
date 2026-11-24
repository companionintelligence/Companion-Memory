import { Field, InputType } from '@nestjs/graphql';

import { TimeFormatEnum } from './UserType';

@InputType()
export class UpdateCurrentUserInput {
  // IANA timezone name, e.g. 'America/New_York'. Validated in the resolver.
  @Field({ nullable: true })
  timezone?: string;

  // Omitted leaves it alone. GraphQL still lets a client send an explicit null for an optional
  // field, and the column is NOT NULL, so the resolver refuses null rather than writing it.
  @Field(() => TimeFormatEnum, { nullable: true })
  timeFormat?: TimeFormatEnum | null;
}

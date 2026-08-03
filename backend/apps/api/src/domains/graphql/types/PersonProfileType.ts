import { Field, ID, ObjectType } from '@nestjs/graphql';

import { type PersonProfile } from '@ci/domains/people';

/**
 * One source-specific view of a person — "what Discord knows about Liam".
 * Read-only in the first pass; assembled under PersonType.profiles.
 */
@ObjectType()
export class PersonProfileType {
  @Field(() => ID)
  id!: string;

  @Field(() => String)
  sourceSystem!: string;

  @Field(() => String)
  remoteKey!: string;

  @Field(() => String, { nullable: true })
  displayName!: string | null;

  @Field(() => String, { nullable: true })
  handle!: string | null;

  @Field(() => String, { nullable: true })
  avatarUrl!: string | null;

  @Field(() => [String])
  emails!: string[];

  @Field(() => [String])
  phones!: string[];

  @Field(() => Boolean)
  pinnedByUser!: boolean;

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => Date)
  updatedAt!: Date;

  static toType(profile: PersonProfile): PersonProfileType {
    return {
      id: profile.id,
      sourceSystem: profile.sourceSystem,
      remoteKey: profile.remoteKey,
      displayName: profile.displayName,
      handle: profile.handle,
      avatarUrl: profile.avatarUrl,
      emails: profile.emails ?? [],
      phones: profile.phones ?? [],
      pinnedByUser: profile.pinnedByUser,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
  }
}

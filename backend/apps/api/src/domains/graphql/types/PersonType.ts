import { Field, ID, ObjectType } from '@nestjs/graphql';

import { type Person } from '@ci/domains/memory';

import { EntityTagType } from './EntityTagType';
import { GlobalUID } from './GlobalUID';
import { Node } from './Node';
import { Taggable } from './Taggable';

@ObjectType({ implements: () => [Node, Taggable] })
export class PersonType implements Node, Taggable {
  __typename = PersonType.name;

  __source!: Person;

  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  name!: string | null;

  @Field(() => String, { nullable: true })
  description!: string | null;

  @Field(() => String, { nullable: true })
  firstName!: string | null;

  @Field(() => String, { nullable: true })
  middleName!: string | null;

  @Field(() => String, { nullable: true })
  lastName!: string | null;

  /** ISO date (YYYY-MM-DD). */
  @Field(() => String, { nullable: true })
  birthDate!: string | null;

  /** True for the user's own person entity. */
  @Field(() => Boolean)
  isSelf!: boolean;

  @Field(() => String, { nullable: true })
  gender!: string | null;

  @Field(() => String, { nullable: true })
  address!: string | null;

  @Field(() => String, { nullable: true })
  streetAddress!: string | null;

  @Field(() => String, { nullable: true })
  streetAddress2!: string | null;

  @Field(() => String, { nullable: true })
  city!: string | null;

  @Field(() => String, { nullable: true })
  region!: string | null;

  @Field(() => String, { nullable: true })
  country!: string | null;

  @Field(() => String, { nullable: true })
  postalCode!: string | null;

  @Field(() => String, { nullable: true })
  avatarUrl!: string | null;

  @Field(() => [EntityTagType])
  tags!: EntityTagType[];

  static toType(person: Person): PersonType {
    return {
      __typename: PersonType.name,
      __source: person,
      id: GlobalUID.encode('person', person.id),
      name: person.name,
      description: person.description,
      firstName: person.firstName,
      middleName: person.middleName,
      lastName: person.lastName,
      birthDate: person.birthDate,
      isSelf: person.isSelf,
      gender: person.gender,
      address: person.address,
      streetAddress: person.streetAddress,
      streetAddress2: person.streetAddress2,
      city: person.city,
      region: person.region,
      country: person.country,
      postalCode: person.postalCode,
      avatarUrl: (person.properties?.avatar_url as string) ?? null,
      tags: [], // Resolved by PersonResolver
    };
  }
}

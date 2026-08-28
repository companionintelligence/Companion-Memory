import { Field, ID, ObjectType } from '@nestjs/graphql';

import { type Person } from '@ci/domains/memory';

import { EntityTagType } from './EntityTagType';
import { GlobalUID } from './GlobalUID';
import { Node } from './Node';
import { PersonAddressType } from './PersonAddressType';
import { RelationshipType } from './RelationshipType';
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
  nickname!: string | null;

  @Field(() => String, { nullable: true })
  pronouns!: string | null;

  @Field(() => String, { nullable: true })
  gender!: string | null;

  @Field(() => String, { nullable: true })
  jobTitle!: string | null;

  @Field(() => String, { nullable: true })
  organization!: string | null;

  @Field(() => String, { nullable: true })
  department!: string | null;

  @Field(() => String, { nullable: true })
  website!: string | null;

  /** Every labelled address; `addresses[0]` is the primary one. */
  @Field(() => [PersonAddressType])
  addresses!: PersonAddressType[];

  // The primary address, flattened. Predates `addresses` and is kept in sync
  // with it — prefer `addresses` for anything that renders more than one line.
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

  /**
   * First real activity inside the active search date window (event as
   * organizer/participant, or communication as from/to). Null when the browse
   * has no date filter — the unique people list is not date-grouped — or when
   * this person has no dated activity in the window. SearchResolver stamps this
   * from the identifier's sortTime; do not add a ResolveField that overwrites
   * it with first-ever, or in-window grouping is lost.
   */
  @Field(() => Date, { nullable: true })
  appearedAt!: Date | null;

  @Field(() => [EntityTagType])
  tags!: EntityTagType[];

  /** Life-graph ego edges — resolved from ci.relationships (WS5). */
  @Field(() => [RelationshipType], { nullable: true })
  outgoingRelationships?: RelationshipType[];

  @Field(() => [RelationshipType], { nullable: true })
  incomingRelationships?: RelationshipType[];

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
      nickname: person.nickname,
      pronouns: person.pronouns,
      gender: person.gender,
      jobTitle: person.jobTitle,
      organization: person.organization,
      department: person.department,
      website: person.website,
      // `?? []` because not every caller hands over a full egress Person —
      // search results and fixtures build the shape by hand.
      addresses: (person.addresses ?? []).map((address) => PersonAddressType.toType(address)),
      address: person.address,
      streetAddress: person.streetAddress,
      streetAddress2: person.streetAddress2,
      city: person.city,
      region: person.region,
      country: person.country,
      postalCode: person.postalCode,
      avatarUrl: (person.properties?.avatar_url as string) ?? null,
      appearedAt: person.appearedAt ?? null,
      tags: [], // Resolved by PersonResolver
    };
  }
}

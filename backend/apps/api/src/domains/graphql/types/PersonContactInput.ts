import { Field, InputType } from '@nestjs/graphql';

/**
 * One labelled contact method in a create/update payload — the form-shaped
 * counterpart to the single-value `addPersonIdentifier` mutation.
 *
 * Contact methods live in `ci.entity_identifiers`, because that is also the
 * index people-linking resolves against — and many people also carry a copy in
 * their properties (`emails`/`phones`, written by `createPerson` and the
 * importer). Sending `contacts` therefore RECONCILES that person's email/phone
 * identifiers against the list (adds, relabels, and drops what is missing), and
 * drops what is missing from those property copies too — the person form shows
 * the complete list, so an omission is a deletion.
 */
@InputType()
export class PersonContactInput {
  /** email | phone. */
  @Field()
  kind!: string;

  /** Raw value; normalized server-side with the shared identifier rule. */
  @Field()
  value!: string;

  /** 'home', 'work', 'mobile', ... */
  @Field({ nullable: true })
  label?: string;

  @Field({ nullable: true })
  isPrimary?: boolean;
}

import { Field, Float, ID, ObjectType } from '@nestjs/graphql';

import { PersonType } from './PersonType';

/**
 * A weak-signal (name-only) "these might be the same person" candidate.
 * Never auto-merged: the user confirms with acceptPersonDuplicateSuggestion
 * (merges B into A) or dismisses with rejectPersonDuplicateSuggestion (writes
 * a sticky distinction so the pair is never suggested again).
 */
@ObjectType()
export class PersonDuplicateSuggestionType {
  @Field(() => ID)
  id!: string;

  @Field(() => PersonType, { nullable: true })
  personA!: PersonType | null;

  @Field(() => PersonType, { nullable: true })
  personB!: PersonType | null;

  @Field(() => Float)
  confidence!: number;

  /** Why the pair was suggested, JSON-encoded (e.g. {"kind":"exact-name"}). */
  @Field(() => String)
  signals!: string;

  @Field(() => String)
  status!: string;

  @Field(() => Date)
  createdAt!: Date;
}

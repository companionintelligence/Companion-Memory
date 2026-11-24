import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';

import { GraphQLJSONObject } from '@ci/domains/graphql/scalars/JsonObjectScalar';
import { type EventCandidate } from '@ci/domains/schedule';

import { GlobalUID } from './GlobalUID';

@ObjectType({ description: 'Where a candidate came from — the "because" behind a suggestion' })
export class RationaleSourceType {
  @Field(() => String, { description: 'summary | insight | answer | item | relationship | due | action' })
  kind!: string;

  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  note?: string;
}

@ObjectType({ description: 'A proposed activity — the "possible" layer of the schedule' })
export class ScheduleCandidateType {
  __typename = ScheduleCandidateType.name;

  @Field(() => ID)
  id!: string;

  @Field(() => String)
  title!: string;

  @Field(() => String, { nullable: true })
  description!: string | null;

  @Field(() => String, { description: 'The sentence shown to the user. Never empty.' })
  rationale!: string;

  @Field(() => [RationaleSourceType])
  rationaleSources!: RationaleSourceType[];

  @Field(() => Date)
  windowStart!: Date;

  @Field(() => Date)
  windowEnd!: Date;

  @Field(() => String, { description: 'exact | day | week | month | season' })
  timeFlex!: string;

  @Field(() => Int, { nullable: true })
  durationMinutes!: number | null;

  @Field(() => String, { nullable: true })
  l0Class!: string | null;

  @Field(() => Int, { nullable: true })
  energyCost!: number | null;

  @Field(() => Float, { nullable: true, description: 'Best-slot score; null until the solver runs' })
  fitScore!: number | null;

  @Field(() => String)
  status!: string;

  @Field(() => String, { nullable: true })
  generator!: string | null;

  @Field(() => Float, { nullable: true })
  confidence!: number | null;

  @Field(() => GraphQLJSONObject, {
    nullable: true,
    description: "Saved how-you'd-do-it compose for this card, when the user has personalized it",
  })
  personalization!: Record<string, unknown> | null;

  static toType(source: EventCandidate): ScheduleCandidateType {
    return {
      __typename: ScheduleCandidateType.name,
      id: GlobalUID.encode('schedule-candidate', source.id),
      title: source.title,
      description: source.description,
      rationale: source.rationale,
      rationaleSources: (source.rationaleSources ?? []).map((entry) => ({
        kind: entry.kind,
        id: entry.id,
        note: entry.note,
      })),
      windowStart: source.windowStart,
      windowEnd: source.windowEnd,
      timeFlex: source.timeFlex,
      durationMinutes: source.durationMinutes,
      l0Class: source.l0Class,
      energyCost: source.energyCost,
      fitScore: source.fitScore,
      status: source.status,
      generator: source.generator,
      confidence: source.confidence,
      personalization: source.personalization,
    };
  }
}

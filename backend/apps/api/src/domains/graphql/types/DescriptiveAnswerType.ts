import { Field, Float, Int, ObjectType } from '@nestjs/graphql';

import type { DescriptiveAnswer , AnswerProvenance , QuestionSpec } from '@ci/domains/insights';

@ObjectType({ description: 'Provenance for a deterministically computed descriptive answer' })
export class DescriptiveAnswerProvenanceType {
  @Field(() => String)
  metric!: string;

  @Field(() => String)
  aggregate!: string;

  @Field(() => String)
  timeframe!: string;

  @Field(() => String)
  from!: string;

  @Field(() => String)
  to!: string;

  @Field(() => Int)
  daysWithData!: number;

  @Field(() => Int)
  daysInRange!: number;

  @Field(() => Float)
  meanCoverage!: number;

  @Field(() => [String])
  sources!: string[];

  static toType(source: AnswerProvenance): DescriptiveAnswerProvenanceType {
    return {
      metric: source.metric,
      aggregate: source.aggregate,
      timeframe: source.timeframe,
      from: source.dateRange.from,
      to: source.dateRange.to,
      daysWithData: source.daysWithData,
      daysInRange: source.daysInRange,
      meanCoverage: source.meanCoverage,
      sources: [...source.sources],
    };
  }
}

@ObjectType({
  description:
    'Compute-then-narrate answer: value is always deterministic from daily_metrics; answer is phrasing only',
})
export class DescriptiveAnswerType {
  @Field(() => String)
  key!: string;

  @Field(() => String)
  category!: string;

  @Field(() => String)
  question!: string;

  @Field(() => Float, { nullable: true })
  value!: number | null;

  @Field(() => String, { nullable: true })
  unit?: string;

  @Field(() => String)
  timeframe!: string;

  @Field(() => String)
  answer!: string;

  @Field(() => DescriptiveAnswerProvenanceType)
  provenance!: DescriptiveAnswerProvenanceType;

  static toType(source: DescriptiveAnswer): DescriptiveAnswerType {
    return {
      key: source.key,
      category: source.category,
      question: source.question,
      value: source.value,
      unit: source.unit,
      timeframe: source.timeframe,
      answer: source.answer,
      provenance: DescriptiveAnswerProvenanceType.toType(source.provenance),
    };
  }
}

@ObjectType({ description: 'A catalog question the descriptive engine can answer' })
export class DescriptiveQuestionType {
  @Field(() => String)
  key!: string;

  @Field(() => String)
  category!: string;

  @Field(() => String)
  question!: string;

  @Field(() => String)
  metric!: string;

  @Field(() => String)
  timeframe!: string;

  static toType(source: QuestionSpec): DescriptiveQuestionType {
    return {
      key: source.key,
      category: source.category,
      question: source.question,
      metric: source.metric,
      timeframe: source.timeframe.label,
    };
  }
}

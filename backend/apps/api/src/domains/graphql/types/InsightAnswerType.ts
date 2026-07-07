import { Field, Float, Int, ObjectType } from '@nestjs/graphql';

import type { DescriptiveAnswer } from '@ci/domains/insights';

/**
 * Where an insight answer's number came from: which metric/aggregate over which
 * date range, how much of the window had data, and the raw capture tables the
 * metric derives from (citations).
 */
@ObjectType({ description: 'Provenance of a computed insight answer' })
export class InsightProvenanceType {
  @Field(() => String, { description: 'Feature-store metric the answer reads' })
  metric!: string;

  @Field(() => String, { description: 'How the daily series was collapsed (sum, avg, ...)' })
  aggregate!: string;

  @Field(() => String, { description: 'Human timeframe label, e.g. "the last 7 days"' })
  timeframe!: string;

  @Field(() => String, { description: 'Window start, YYYY-MM-DD (inclusive)' })
  fromDate!: string;

  @Field(() => String, { description: 'Window end, YYYY-MM-DD (inclusive)' })
  toDate!: string;

  @Field(() => Int, { description: 'Days in the window that actually had data' })
  daysWithData!: number;

  @Field(() => Int, { description: 'Total days in the window' })
  daysInRange!: number;

  @Field(() => Float, { description: 'Mean per-day coverage of the metric (0..1)' })
  meanCoverage!: number;

  @Field(() => [String], { description: 'Raw capture tables the metric derives from' })
  sources!: string[];
}

/**
 * A compute-then-narrate answer: `value` is always the deterministically
 * computed number (null when there is no data); `answer` is only the phrasing.
 */
@ObjectType({ description: 'A computed + narrated descriptive insight answer' })
export class InsightAnswerType {
  @Field(() => String, { description: 'Stable question key, e.g. "rel.messages_week"' })
  key!: string;

  @Field(() => String, { description: 'Life-domain category, e.g. "Relationships"' })
  category!: string;

  @Field(() => String, { description: 'The question being answered' })
  question!: string;

  @Field(() => Float, {
    nullable: true,
    description: 'Deterministically computed value (null = not enough data)',
  })
  value!: number | null;

  @Field(() => String, { nullable: true, description: 'Unit of the value, e.g. "km"' })
  unit!: string | null;

  @Field(() => String, { description: 'Human timeframe label' })
  timeframe!: string;

  @Field(() => String, { description: 'The narrated sentence' })
  answer!: string;

  @Field(() => InsightProvenanceType)
  provenance!: InsightProvenanceType;

  static toType(source: DescriptiveAnswer): InsightAnswerType {
    return {
      key: source.key,
      category: source.category,
      question: source.question,
      value: source.value,
      unit: source.unit ?? null,
      timeframe: source.timeframe,
      answer: source.answer,
      provenance: {
        metric: source.provenance.metric,
        aggregate: source.provenance.aggregate,
        timeframe: source.provenance.timeframe,
        fromDate: source.provenance.dateRange.from,
        toDate: source.provenance.dateRange.to,
        daysWithData: source.provenance.daysWithData,
        daysInRange: source.provenance.daysInRange,
        meanCoverage: source.provenance.meanCoverage,
        sources: [...source.provenance.sources],
      },
    };
  }
}

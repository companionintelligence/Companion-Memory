import { Field, Float, Int, ObjectType } from '@nestjs/graphql';

import type { MetricAnomaly, MetricCorrelation, MetricSuggestion } from '@ci/domains/daily-metrics';
import { GraphQLJSONObject } from '@ci/domains/graphql/scalars/JsonObjectScalar';

@ObjectType({
  description:
    'A pairwise / lagged association over daily_metrics. Language is hypothesis ("associated with"), never cause.',
})
export class MetricCorrelationType {
  @Field(() => String)
  id!: string;

  @Field(() => String)
  metricA!: string;

  @Field(() => String)
  metricB!: string;

  @Field(() => Int)
  lagDays!: number;

  @Field(() => Int)
  windowDays!: number;

  @Field(() => Int)
  n!: number;

  @Field(() => Float, { nullable: true })
  pearson!: number | null;

  @Field(() => Float, { nullable: true })
  spearman!: number | null;

  @Field(() => Float, { nullable: true })
  pValue!: number | null;

  @Field(() => Float, { nullable: true })
  qValue!: number | null;

  @Field(() => Float, { nullable: true })
  effect!: number | null;

  @Field(() => Boolean)
  robust!: boolean;

  @Field(() => Float)
  novelty!: number;

  @Field(() => Float, { nullable: true })
  coverageMean!: number | null;

  static toType(source: MetricCorrelation): MetricCorrelationType {
    return {
      id: source.id,
      metricA: source.metricA,
      metricB: source.metricB,
      lagDays: source.lagDays,
      windowDays: source.windowDays,
      n: source.n,
      pearson: source.pearson,
      spearman: source.spearman,
      pValue: source.pValue,
      qValue: source.qValue,
      effect: source.effect,
      robust: source.robust,
      novelty: source.novelty,
      coverageMean: source.coverageMean,
    };
  }
}

@ObjectType({ description: 'A dated metric or behavioral anomaly. Computed, not LLM-invented.' })
export class MetricAnomalyType {
  @Field(() => String)
  id!: string;

  @Field(() => String)
  metric!: string;

  @Field(() => String)
  date!: string;

  @Field(() => String)
  detector!: string;

  @Field(() => Float, { nullable: true })
  value!: number | null;

  @Field(() => Float, { nullable: true })
  baseline!: number | null;

  @Field(() => Float)
  score!: number;

  @Field(() => String)
  direction!: string;

  @Field(() => Float)
  coverage!: number;

  @Field(() => GraphQLJSONObject)
  metadata!: Record<string, unknown>;

  static toType(source: MetricAnomaly): MetricAnomalyType {
    return {
      id: source.id,
      metric: source.metric,
      date: source.date,
      detector: source.detector,
      value: source.value,
      baseline: source.baseline,
      score: source.score,
      direction: source.direction,
      coverage: source.coverage,
      metadata: source.metadata,
    };
  }
}

@ObjectType({
  description: 'An evidence-linked suggestion. Never emitted without a correlation or anomaly FK.',
})
export class MetricSuggestionType {
  @Field(() => String)
  id!: string;

  @Field(() => String)
  key!: string;

  @Field(() => String)
  title!: string;

  @Field(() => String)
  text!: string;

  @Field(() => Int, { nullable: true })
  priority!: number | null;

  @Field(() => GraphQLJSONObject)
  evidence!: Record<string, unknown>;

  @Field(() => String, { nullable: true })
  acceptedAt!: string | null;

  @Field(() => String, { nullable: true })
  dismissedAt!: string | null;

  static toType(source: MetricSuggestion): MetricSuggestionType {
    return {
      id: source.id,
      key: source.key,
      title: source.title,
      text: source.text,
      priority: source.priority,
      evidence: { ...source.evidence },
      acceptedAt: source.acceptedAt?.toISOString() ?? null,
      dismissedAt: source.dismissedAt?.toISOString() ?? null,
    };
  }
}

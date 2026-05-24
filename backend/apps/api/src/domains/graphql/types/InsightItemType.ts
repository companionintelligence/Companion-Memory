import { Field, Float, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class InsightItemType {
  @Field(() => String)
  title!: string;

  @Field(() => String)
  summaryText!: string;

  @Field(() => [String!]!)
  keyActions!: string[];

  @Field(() => Float)
  relevanceScore!: number;

  @Field(() => [String!]!)
  tags!: string[];

  @Field(() => [String!], { nullable: true })
  relatedEntityIds?: string[];

  static fromContent(insight: Record<string, unknown>): InsightItemType {
    return {
      title: (insight.title as string) || '',
      summaryText: (insight.summary_text as string) || (insight.summaryText as string) || '',
      keyActions: (insight.key_actions as string[]) || (insight.keyActions as string[]) || [],
      relevanceScore: Number(insight.relevance_score ?? insight.relevanceScore ?? 0),
      tags: (insight.tags as string[]) || [],
      relatedEntityIds: (insight.related_entity_ids as string[]) || (insight.relatedEntityIds as string[]),
    };
  }
}

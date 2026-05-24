import { Field, ID, ObjectType } from '@nestjs/graphql';

import { type Question } from '@ci/domains/intelligence';

import { GlobalUID } from './GlobalUID';
import { Node } from './Node';

@ObjectType({ implements: () => [Node] })
export class QuestionType implements Node {
  __typename = QuestionType.name;

  __source!: Question;

  @Field(() => ID)
  id!: string;

  @Field(() => String)
  category!: string;

  @Field(() => String)
  text!: string;

  // @Field(() => [String], { nullable: true })
  // contextTags?: (string | null)[];

  @Field(() => String, { nullable: true })
  questionType?: string | null;

  @Field(() => Boolean, { nullable: true })
  isSeedQuestion?: boolean | null;

  // @Field(() => Boolean, { nullable: true })
  // isActive?: boolean | null;

  @Field(() => Boolean, { nullable: true })
  createdByLlm!: boolean | null;

  // @Field(() => String, { nullable: true })
  // frequencyRecommendation!: string | null;

  // @Field(() => Float)
  // timesAsked!: number | null;
  //
  // @Field(() => Float)
  // timesAnswered!: number | null;

  // @Field(() => String, { nullable: true })
  // isPrivateTo!: string | null;

  static toType(question: Question): QuestionType {
    return {
      __typename: QuestionType.name,
      __source: question,
      id: GlobalUID.encode('question', question.id),
      category: question.category,
      text: question.text,
      // contextTags: question.contextTags,
      questionType: question.questionType,
      isSeedQuestion: question.isSeedQuestion,
      // isActive: question.isActive,
      createdByLlm: question.createdByLlm,
      // frequencyRecommendation: question.frequencyRecommendation,
      // timesAsked: question.timesAsked,
      // timesAnswered: question.timesAnswered,
      // isPrivateTo: question.isPrivateTo || null,
    };
  }
}

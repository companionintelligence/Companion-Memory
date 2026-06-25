import { UseGuards } from '@nestjs/common';
import { Mutation, Query, Resolver, Args, ID } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { QuestionService } from '@ci/domains/intelligence';

import { CreateQuestionInput } from '../types/CreateQuestionInput';
import { GlobalUID } from '../types/GlobalUID';
import { PaginationArgs } from '../types/PaginationArgs';
import { QuestionConnection } from '../types/QuestionConnection';
import { QuestionEdge } from '../types/QuestionEdge';
import { QuestionType } from '../types/QuestionType';
import { UpdateQuestionInput } from '../types/UpdateQuestionInput';
import { Paginator } from '../utils/Paginator';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => QuestionType)
export class QuestionResolver {
  constructor(private readonly questionService: QuestionService) {}

  @Mutation(() => QuestionType)
  async createQuestion(
    @Context() context: RequestContext,
    @Args('input') input: CreateQuestionInput,
  ): Promise<QuestionType> {
    const serviceContext = toServiceContext(context);

    const entity = await this.questionService.create(serviceContext, {
      text: input.text,
      category: input.category,
    });

    return QuestionType.toType(entity);
  }

  /**
   * Batch equivalent of N {@link createQuestion} calls in one round-trip.
   * Returns the created questions in input order.
   */
  @Mutation(() => [QuestionType])
  async createQuestions(
    @Context() context: RequestContext,
    @Args('input', { type: () => [CreateQuestionInput] }) input: CreateQuestionInput[],
  ): Promise<QuestionType[]> {
    const serviceContext = toServiceContext(context);

    const questions = await this.questionService.createMany(
      serviceContext,
      input.map((item) => ({
        text: item.text,
        category: item.category,
      })),
    );

    return questions.map((question) => QuestionType.toType(question));
  }

  @Mutation(() => QuestionType, { nullable: true })
  async updateQuestion(
    @Context() context: RequestContext,
    @Args('input') input: UpdateQuestionInput,
  ): Promise<QuestionType | null> {
    const serviceContext = toServiceContext(context);

    const entity = await this.questionService.update(serviceContext, input.id, {
      text: input.text,
      subcategory: input.category,
    });

    return entity ? QuestionType.toType(entity) : entity;
  }

  @Mutation(() => Boolean)
  async removeQuestion(@Context() context: RequestContext, @Args('id') id: string): Promise<boolean> {
    const serviceContext = toServiceContext(context);

    return this.questionService.remove(serviceContext, id);
  }

  @Query(() => QuestionConnection)
  async questions(
    @Context() context: RequestContext,
    @Args() pagination: PaginationArgs,
  ): Promise<QuestionConnection> {
    const serviceContext = toServiceContext(context);

    const entities = await this.questionService.findAll(serviceContext);

    const { slice, pageInfo, totalCount } = Paginator.paginate(entities, {
      ...pagination,
      getId: (entity) => GlobalUID.encode('question', entity.id),
    });

    const edges: QuestionEdge[] = slice.map((entity) => {
      const node = QuestionType.toType(entity);

      return {
        node,
        cursor: node.id,
      };
    });

    return {
      edges,
      pageInfo,
      totalCount,
    };
  }

  @Query(() => QuestionType, { nullable: true })
  async question(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<QuestionType | null> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('question', gid);

    const entity = await this.questionService.findById(serviceContext, id);

    return entity ? QuestionType.toType(entity) : null;
  }
}

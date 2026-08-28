import {
  Controller,
  Get,
  Post,
  HttpStatus,
  Param,
  Res,
  UseGuards,
  HttpCode,
  NotFoundException,
  Patch,
  Delete,
  Body,
  Query,
} from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { LoggerService } from '@ci/common/logging';
import { ValidationPipe } from '@ci/common/pipes';
import { EventService } from '@ci/domains/events';

import { Question } from '../entities/QuestionEntity';
import { QuestionService, type QuestionCataloguePage } from '../services/QuestionService';
import {
  type CreateQuestionDto,
  type QuestionCatalogueQueryDto,
  type UpdateQuestionDto,
  createQuestionSchema,
  questionCatalogueQuerySchema,
  skipFeedQuestionSchema,
  updateQuestionSchema,
} from '../types';

type CreateQuestionInput = z.infer<typeof createQuestionSchema>;
type UpdateQuestionInput = z.infer<typeof updateQuestionSchema>;
type SkipFeedQuestionInput = z.infer<typeof skipFeedQuestionSchema>;

@Controller('questions')
export class QuestionsController {
  constructor(
    private readonly eventService: EventService,
    private readonly questionService: QuestionService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(QuestionsController.name);
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Post()
  async create(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(createQuestionSchema)) input: CreateQuestionInput,
  ): Promise<Question> {
    const serviceContext = toServiceContext(context);

    const dto: CreateQuestionDto = {
      text: input.text,
      // `subcategory` is the legacy spelling of the same field.
      category: input.category ?? input.subcategory,
      answerTier: input.answerTier ?? null,
    };

    return await this.questionService.create(serviceContext, dto);
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get()
  findAll(@Context() context: RequestContext): Promise<Question[]> {
    const serviceContext = toServiceContext(context);

    return this.questionService.findAll(serviceContext);
  }

  /**
   * The browsable catalogue: paged, filtered, searched, each row carrying the
   * caller's answer when it has one. `GET /questions` returns every active row
   * at once with no filters, which is unusable at catalogue size.
   *
   * Declared ahead of `:id` — Nest matches routes in declaration order, so a
   * later static path would be swallowed by the parameterised one.
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get('catalogue')
  findCatalogue(
    @Context() context: RequestContext,
    @Query(new ValidationPipe(questionCatalogueQuerySchema)) query: QuestionCatalogueQueryDto,
  ): Promise<QuestionCataloguePage> {
    const serviceContext = toServiceContext(context);

    return this.questionService.findCatalogue(serviceContext, query);
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get('unanswered')
  async findOneUnanswered(@Context() context: RequestContext, @Res() res: Response) {
    const serviceContext = toServiceContext(context);

    const question = await this.questionService.findOneUnanswered(serviceContext);
    if (!question) {
      return res.status(HttpStatus.NO_CONTENT).send();
    }

    return res.status(HttpStatus.OK).json(question);
  }

  /**
   * "Skip" on the reflection prompt. `findOneUnanswered` deterministically
   * returns the same front-of-queue row every time, so a client that only
   * refetches after Skip gets the identical question back — this moves it to
   * the back first. `presentationId` is the `feed_queue_id` the earlier
   * `unanswered` response carried.
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Post('unanswered/skip')
  @HttpCode(HttpStatus.NO_CONTENT)
  async skipUnanswered(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(skipFeedQuestionSchema)) body: SkipFeedQuestionInput,
  ): Promise<void> {
    const serviceContext = toServiceContext(context);

    await this.questionService.skipFrontFeedQuestion(serviceContext.userId, body.presentationId);
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get(':id')
  findById(@Context() context: RequestContext, @Param('id') id: string): Promise<Question | null> {
    const serviceContext = toServiceContext(context);

    return this.questionService.findById(serviceContext, id);
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Patch(':id')
  async update(
    @Context() context: RequestContext,
    @Param('id') questionId: string,
    @Body(new ValidationPipe(updateQuestionSchema)) data: UpdateQuestionInput,
  ): Promise<Question | null> {
    const serviceContext = toServiceContext(context);

    const dto: UpdateQuestionDto = {
      ...(data.text !== undefined && { text: data.text }),
      ...((data.category ?? data.subcategory) !== undefined && {
        category: data.category ?? data.subcategory,
      }),
      ...(data.answerTier !== undefined && { answerTier: data.answerTier }),
      ...(data.isActive !== undefined && { isActive: data.isActive }),
    };

    const question = await this.questionService.update(serviceContext, questionId, dto);

    if (!question) {
      throw new NotFoundException('Question not found');
    }

    return question;
  }

  /**
   * Hard delete, own private reflections only. A shared catalogue row is not
   * deletable by anybody through this endpoint — ci.answers and ci.feed_queue
   * cascade from ci.questions, so it would take other people's answers with it.
   * Retiring a shared reflection is `PATCH { isActive: false }`, which forks.
   *
   * The refusal is a 404 rather than a 403, and the service's `false` is the
   * only thing consulted: a visibility pre-check here is what previously let
   * this endpoint answer 204 while deleting nothing, since the writer applies a
   * stricter rule than `findById` does.
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Context() context: RequestContext, @Param('id') questionId: string): Promise<void> {
    const serviceContext = toServiceContext(context);

    const removed = await this.questionService.remove(serviceContext, questionId);

    if (!removed) {
      throw new NotFoundException('Question not found');
    }
  }
}

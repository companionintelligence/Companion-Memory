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
} from '@nestjs/common';
import type { Response } from 'express';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { LoggerService } from '@ci/common/logging';
import { ValidationPipe } from '@ci/common/pipes';
import { EventService } from '@ci/domains/events';

import { Question } from '../entities/QuestionEntity';
import { QuestionService } from '../services/QuestionService';
import {
  type CreateQuestionDto,
  type UpdateQuestionDto,
  createQuestionSchema,
  updateQuestionSchema,
} from '../types';

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
    @Body(new ValidationPipe(createQuestionSchema)) input: CreateQuestionDto,
  ): Promise<Question> {
    const serviceContext = toServiceContext(context);

    return await this.questionService.create(serviceContext, input);
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get()
  findAll(@Context() context: RequestContext): Promise<Question[]> {
    const serviceContext = toServiceContext(context);

    return this.questionService.findAll(serviceContext);
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
    @Body(new ValidationPipe(updateQuestionSchema)) data: UpdateQuestionDto,
  ): Promise<Question | null> {
    const serviceContext = toServiceContext(context);

    const question = await this.questionService.update(serviceContext, questionId, data);

    if (!question) {
      throw new NotFoundException('Question not found');
    }

    return question;
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Context() context: RequestContext, @Param('id') questionId: string): Promise<void> {
    const serviceContext = toServiceContext(context);

    const question = await this.questionService.findById(serviceContext, questionId);

    if (!question) {
      throw new NotFoundException('Question not found');
    }

    const removal = this.questionService.remove(serviceContext, questionId);

    if (!removal) {
      throw new NotFoundException();
    }
  }
}

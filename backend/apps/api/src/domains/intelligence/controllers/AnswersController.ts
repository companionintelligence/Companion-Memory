import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
  Delete,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';

import { AnswerService } from '../services/AnswerService';
import { type CreateAnswerDto, type UpdateAnswerDto, createAnswerSchema, updateAnswerSchema } from '../types';

@Controller('answers')
export class AnswersController {
  constructor(private readonly answerService: AnswerService) {}

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Post()
  async create(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(createAnswerSchema)) data: CreateAnswerDto,
  ) {
    const serviceContext = toServiceContext(context);

    return this.answerService.create(serviceContext, data);
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get()
  findAll(@Context() context: RequestContext) {
    const serviceContext = toServiceContext(context);

    return this.answerService.findAll(serviceContext);
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get(':id')
  findOne(@Context() context: RequestContext, @Param('id') id: string) {
    const serviceContext = toServiceContext(context);

    return this.answerService.findById(serviceContext, id);
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Patch(':id')
  async update(
    @Context() context: RequestContext,
    @Param('id') id: string,
    @Body(new ValidationPipe(updateAnswerSchema)) data: UpdateAnswerDto,
  ) {
    const serviceContext = toServiceContext(context);

    const result = await this.answerService.update(serviceContext, id, data);

    if (!result) {
      throw new NotFoundException();
    }

    return result;
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Context() context: RequestContext, @Param('id') answerId: string): Promise<void> {
    const serviceContext = toServiceContext(context);

    const answer = await this.answerService.findById(serviceContext, answerId);

    if (!answer) {
      throw new NotFoundException('Answer not found');
    }

    const removal = await this.answerService.remove(serviceContext, answerId);

    if (!removal) {
      throw new NotFoundException();
    }
  }
}

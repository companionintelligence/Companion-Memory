import { Controller, Get, Param, UseGuards } from '@nestjs/common';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import type { RequestContext } from '@ci/common/types';

import { AnswerService } from '../services/AnswerService';

@Controller('answers')
export class AnswersController {
  constructor(private readonly questionService: AnswerService) {}

  @UseGuards(JwtAuthGuard)
  @Get()
  findAll(@Context() context: RequestContext) {
    return this.questionService.findAll(context);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  findOne(@Context() context: RequestContext, @Param('id') id: string) {
    return this.questionService.findOne(context, id);
  }
}

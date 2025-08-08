import { Controller, Get, Param, UseGuards } from '@nestjs/common';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import type { RequestContext } from '@ci/common/types';

import { ActionService } from '../services/ActionService';

@Controller('actions')
export class ActionsController {
  constructor(private readonly actionService: ActionService) {}

  @UseGuards(JwtAuthGuard)
  @Get()
  findAll(@Context() context: RequestContext) {
    return this.actionService.findAll(context);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  findOne(@Context() context: RequestContext, @Param('id') id: string) {
    return this.actionService.findOne(context, id);
  }
}

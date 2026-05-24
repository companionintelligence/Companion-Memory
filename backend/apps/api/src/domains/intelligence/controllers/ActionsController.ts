import { Controller, Get, Param, UseGuards } from '@nestjs/common';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';

import { ActionService } from '../services/ActionService';

@Controller('actions')
export class ActionsController {
  constructor(private readonly actionService: ActionService) {}

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get()
  findAll(@Context() context: RequestContext) {
    const serviceContext = toServiceContext(context);

    return this.actionService.findAll(serviceContext);
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get(':id')
  findOne(@Context() context: RequestContext, @Param('id') id: string) {
    const serviceContext = toServiceContext(context);

    return this.actionService.findById(serviceContext, id);
  }
}

import { Controller, InternalServerErrorException, Post, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '@ci/common/guards';
import { LoggerService } from '@ci/common/services';
import { Events, type EventPayloads, EventService, OnEvent } from '@ci/domains/events';

@Controller('jobs')
export class JobsController {
  private logger = new LoggerService(JobsController.name);

  constructor(private readonly eventService: EventService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  async enqueue() {
    const result = await this.eventService.send(Events.API_ENQUEUE, {
      foo: 'test',
      bar: 'test',
    });

    if (result == null) {
      throw new InternalServerErrorException('Failed to enqueue job');
    }

    return {
      id: result,
    };
  }

  @OnEvent(Events.API_ENQUEUE)
  handleApiEnqueueEvent(payload: EventPayloads[Events.API_ENQUEUE]) {
    this.logger.log('Processed event from listener', {
      foo: payload.foo,
      bar: payload.bar,
    });
  }
}

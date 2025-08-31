import { 
  Controller, 
  Get, 
  Post, 
  Put, 
  Delete, 
  Param, 
  Query, 
  Body,
  UseGuards, 
  InternalServerErrorException 
} from '@nestjs/common';

import { JwtAuthGuard } from '@ci/common/guards';
import { LoggerService } from '@ci/common/services';
import { Events, type EventPayloads, EventService, OnEvent } from '@ci/domains/events';
import { JobsService } from '../services/JobsService';

@Controller('jobs')
export class JobsController {
  private logger = new LoggerService(JobsController.name);

  constructor(
    private readonly eventService: EventService,
    private readonly jobsService: JobsService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Get()
  async getJobs() {
    const jobs = await this.jobsService.getJobs();
    const stats = await this.jobsService.getQueueStats();
    return {
      jobs,
      stats,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Get('stats')
  async getQueueStats() {
    return this.jobsService.getQueueStats();
  }

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

  @UseGuards(JwtAuthGuard)
  @Put(':id/complete')
  async completeJob(@Param('id') id: string, @Body() body?: any) {
    const success = await this.jobsService.updateJobStatus(id, 'completed');
    if (!success) {
      throw new InternalServerErrorException('Failed to complete job');
    }
    return { success: true };
  }

  @UseGuards(JwtAuthGuard)
  @Put(':id/fail')
  async failJob(@Param('id') id: string, @Body() body?: any) {
    const success = await this.jobsService.updateJobStatus(id, 'failed');
    if (!success) {
      throw new InternalServerErrorException('Failed to fail job');
    }
    return { success: true };
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  async deleteJob(@Param('id') id: string) {
    const success = await this.jobsService.deleteJob(id);
    if (!success) {
      throw new InternalServerErrorException('Failed to delete job');
    }
    return { success: true };
  }

  @OnEvent(Events.API_ENQUEUE)
  handleApiEnqueueEvent(payload: EventPayloads[Events.API_ENQUEUE]) {
    this.logger.log('Processed event from listener', {
      foo: payload.foo,
      bar: payload.bar,
    });
  }
}

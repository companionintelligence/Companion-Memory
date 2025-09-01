import { Controller, Get, Post, Delete, Param, Query, UseGuards, InternalServerErrorException } from '@nestjs/common';

import { JwtAuthGuard } from '@ci/common/guards';
import { LoggerService } from '@ci/common/services';
import { Events, type EventPayloads, EventService, OnEvent } from '@ci/domains/events';

@Controller('jobs')
export class JobsController {
  private logger = new LoggerService(JobsController.name);

  constructor(private readonly eventService: EventService) {}

  @UseGuards(JwtAuthGuard)
  @Get()
  async getJobs(@Query('queue') queue?: string, @Query('limit') limit = '100') {
    try {
      const jobs = await this.eventService.getJobs(queue, parseInt(limit));
      
      return {
        jobs: jobs.map(job => ({
          id: job.id,
          name: job.name,
          data: job.data,
          state: job.state || this.determineJobState(job),
          priority: job.priority || 0,
          createdOn: job.createdOn,
          startedOn: job.startedOn,
          completedOn: job.completedOn,
          failedReason: job.failedReason,
          retryCount: job.retryCount || 0,
          expireIn: job.expireIn,
          queue: job.name || queue || 'default'
        })),
        total: jobs.length
      };
    } catch (error) {
      this.logger.error('Failed to fetch jobs', error as Error);
      throw new InternalServerErrorException('Failed to fetch jobs');
    }
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  async getJob(@Param('id') id: string) {
    try {
      const job = await this.eventService.getJobById(id);
      
      if (!job) {
        return { error: 'Job not found' };
      }
      
      return {
        job: {
          id: job.id,
          name: job.name,
          data: job.data,
          state: job.state || this.determineJobState(job),
          priority: job.priority || 0,
          createdOn: job.createdOn,
          startedOn: job.startedOn,
          completedOn: job.completedOn,
          failedReason: job.failedReason,
          retryCount: job.retryCount || 0,
          expireIn: job.expireIn,
        }
      };
    } catch (error) {
      this.logger.error('Failed to fetch job', error as Error);
      throw new InternalServerErrorException('Failed to fetch job');
    }
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
  @Delete(':id')
  async cancelJob(@Param('id') id: string) {
    try {
      const result = await this.eventService.cancelJob(id);
      return { success: result };
    } catch (error) {
      this.logger.error('Failed to cancel job', error as Error);
      throw new InternalServerErrorException('Failed to cancel job');
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/resume')
  async resumeJob(@Param('id') id: string) {
    try {
      const result = await this.eventService.resumeJob(id);
      return { success: result };
    } catch (error) {
      this.logger.error('Failed to resume job', error as Error);
      throw new InternalServerErrorException('Failed to resume job');
    }
  }

  private determineJobState(job: any): string {
    if (job.completedOn) return 'completed';
    if (job.failedReason) return 'failed';
    if (job.startedOn) return 'active';
    return 'created';
  }

  @OnEvent(Events.API_ENQUEUE)
  handleApiEnqueueEvent(payload: EventPayloads[Events.API_ENQUEUE]) {
    this.logger.log('Processed event from listener', {
      foo: payload.foo,
      bar: payload.bar,
    });
  }
}

import { Controller, InternalServerErrorException, Post, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '@ci/common/guards';
import { LoggerService } from '@ci/common/services';
import { Events, type EventPayloads, EventService, OnEvent } from '@ci/domains/events';
import { FileParsingService } from '@ci/domains/files/services/FileParsingService';

@Controller('jobs')
export class JobsController {
  private logger = new LoggerService(JobsController.name);

  constructor(
    private readonly eventService: EventService,
    private readonly fileParsingService: FileParsingService,
  ) {}

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

  @OnEvent(Events.FILE_UPLOAD)
  async handleFileUploadEvent(payload: EventPayloads[Events.FILE_UPLOAD]) {
    this.logger.log('Processing file upload event', {
      fileId: payload.fileId,
      jobId: (payload as any).jobId,
    });

    try {
      await this.fileParsingService.parseFile(payload.fileId);
      this.logger.log('File parsing completed successfully', {
        fileId: payload.fileId,
      });
    } catch (error) {
      this.logger.error('File parsing failed', {
        fileId: payload.fileId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}

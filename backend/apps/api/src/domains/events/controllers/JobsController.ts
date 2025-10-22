import { Controller, Get, UseGuards } from '@nestjs/common';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { RequestContext } from '@ci/common/types';

import { JobDashboardDto, JobMonitorService } from '../services/JobMonitorService';

@Controller('events/jobs')
export class JobsController {
  constructor(private readonly jobMonitorService: JobMonitorService) {}

  @UseGuards(JwtAuthGuard)
  @Get('dashboard')
  getDashboard(@Context() context: RequestContext): Promise<JobDashboardDto> {
    return this.jobMonitorService.getDashboard(context);
  }
}

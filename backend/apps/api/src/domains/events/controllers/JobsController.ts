import { Controller, Get, UseGuards } from '@nestjs/common';

import { Context, type RequestContext } from '@ci/common/context/';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';

import { JobDashboardDto, JobMonitorService } from '../services/JobMonitorService';

@Controller('jobs')
export class JobsController {
  constructor(private readonly jobMonitorService: JobMonitorService) {}

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get('dashboard')
  getDashboard(@Context() context: RequestContext): Promise<JobDashboardDto> {
    return this.jobMonitorService.getDashboard(context);
  }
}

import { Controller, ForbiddenException, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { Context, type RequestContext } from '@ci/common/context/';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';

import { JobDashboardDto, JobMonitorService } from '../services/JobMonitorService';
import {
  JobCategoryHistoryDto,
  JobHistoryDto,
  JobListDto,
  JobQueryService,
} from '../services/JobQueryService';
import { JOB_CATEGORIES, JOB_TYPES } from '../taxonomy';

function isLoopback(request: Request): boolean {
  const ip = request.socket.remoteAddress ?? '';

  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

@Controller('jobs')
export class JobsController {
  constructor(
    private readonly jobMonitorService: JobMonitorService,
    private readonly jobQueryService: JobQueryService,
  ) {}

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get('dashboard')
  getDashboard(@Context() context: RequestContext): Promise<JobDashboardDto> {
    return this.jobMonitorService.getDashboard(context);
  }

  /**
   * Fire every Nest `@Cron` (or one named job) the way the scheduler would.
   *
   * Loopback-only: operators `docker exec` into the api container and curl
   * localhost. Authenticated remote callers use the Jobs UI / JWT surface
   * instead of an open stampede endpoint on the public host.
   */
  @Post('crons/run')
  runCrons(
    @Req() request: Request,
    @Query('name') name?: string,
  ): {
    fired: string[];
    skipped: string[];
    errors: { name: string; error: string }[];
  } {
    if (!isLoopback(request)) {
      throw new ForbiddenException('POST /jobs/crons/run is only allowed from inside the api container');
    }

    const names = name?.trim() ? [name.trim()] : undefined;

    return this.jobMonitorService.fireCronJobs(names);
  }

  /**
   * The queryable job list behind the dashboard table.
   *
   * All filters are optional and compose. `state` accepts pg-boss's own states
   * plus the synthetic `dead-letter`, which selects the DLQ copies rather than a
   * state — they are stored as `created`, so without it they are unfindable.
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get()
  list(
    @Context() context: RequestContext,
    @Query('state') state?: string,
    @Query('queue') queue?: string,
    @Query('category') category?: string,
    @Query('type') type?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<JobListDto> {
    return this.jobQueryService.list(context, {
      state,
      queue,
      category,
      type,
      search,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  /**
   * Time series for the charts, out of `ci.job_metrics`.
   *
   * Not derivable from pg-boss: its tables hold roughly 36 hours of working set
   * and are pruned continuously, so anything older exists only because the
   * collector sampled it.
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get('history')
  history(
    @Context() context: RequestContext,
    @Query('hours') hours?: string,
    @Query('queue') queue?: string,
  ): Promise<JobHistoryDto> {
    return this.jobQueryService.history(context, {
      windowHours: hours ? Number(hours) : undefined,
      queue,
    });
  }

  /**
   * Job volume by category over time.
   *
   * A separate route from `history` rather than a mode of it: that series is
   * per-queue and comes only from `ci.job_metrics`, while this one is keyed on
   * the taxonomy and is stitched from two stores — live `pgboss.job` for the
   * ~36 hours it still holds, the sampled `ci.job_category_metrics` for
   * anything older. The response says which via `source`.
   *
   * A queue could never have been folded into a category here: pg-boss
   * rewrites the queue name on the copy it makes of a dead-lettered job (43% of
   * rows on a live appliance), so only the event name in the payload survives.
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get('history/categories')
  categoryHistory(
    @Context() context: RequestContext,
    @Query('hours') hours?: string,
  ): Promise<JobCategoryHistoryDto> {
    return this.jobQueryService.categoryHistory(context, {
      windowHours: hours ? Number(hours) : undefined,
    });
  }

  /**
   * The job taxonomy: what every event name means and which part of the
   * appliance it belongs to. Served so the UI's labels and its category filter
   * come from one source rather than a second copy in the frontend.
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get('types')
  types(): {
    categories: string[];
    types: Record<string, { label: string; category: string; description: string; interactive: boolean }>;
  } {
    return {
      categories: Object.values(JOB_CATEGORIES),
      types: Object.fromEntries(
        Object.entries(JOB_TYPES).map(([event, descriptor]) => [
          event,
          {
            label: descriptor.label,
            category: descriptor.category,
            description: descriptor.description,
            interactive: Boolean(descriptor.interactive),
          },
        ]),
      ),
    };
  }
}

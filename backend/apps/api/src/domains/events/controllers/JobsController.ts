import { Body, Controller, ForbiddenException, Get, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';

import { Context, type RequestContext } from '@ci/common/context/';
import { READ_CAPABILITY, RequireCapability, WRITE_CAPABILITY } from '@ci/common/decorators';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { MAX_CONCURRENCY } from '@ci/common/job-controls';
import { ValidationPipe } from '@ci/common/pipes';

import { JobControlsDto, JobControlsService } from '../services/JobControlsService';
import { JobDashboardDto, JobMonitorService } from '../services/JobMonitorService';
import {
  JobCategoryHistoryDto,
  JobHistoryDto,
  JobListDto,
  JobQueryService,
} from '../services/JobQueryService';
import { JOB_CATEGORIES, JOB_TYPES } from '../taxonomy';

/**
 * A concurrency field, where `null` is a real value and absence is a different
 * one.
 *
 * `null` means "reset this to the shipped default"; omitting the key means
 * "leave whatever is there alone". Collapsing the two would make it impossible
 * to change a queue's mode without also wiping its cap, and impossible to undo a
 * cap at all. `.nullable()` accepts the first; the schema being non-strict about
 * missing keys gives the second.
 */
const concurrencyField = z.number().int().min(1).max(MAX_CONCURRENCY).nullable().optional();

const jobControlsSchema = z.object({
  global: z
    .object({
      concurrency: concurrencyField,
      perQueueConcurrency: concurrencyField,
      // No `disabled`: a global switch that DROPPED every non-interactive job
      // would put a silent, appliance-wide hole in the memory system, and heat
      // — the reason anyone reaches for this — is solved by pausing.
      nonInteractive: z.enum(['enabled', 'paused']).optional(),
    })
    .optional(),
  queues: z
    .array(
      z.object({
        name: z.string().min(1).max(128),
        mode: z.enum(['enabled', 'paused', 'disabled']).optional(),
        concurrency: concurrencyField,
      }),
    )
    .max(200)
    .optional(),
  crons: z
    .array(
      z.object({
        name: z.string().min(1).max(256),
        // `paused` is deliberately absent: a tick that is not taken is simply
        // not taken, so there is nothing for a schedule to be paused INTO.
        mode: z.enum(['enabled', 'disabled']),
      }),
    )
    .max(200)
    .optional(),
});

type JobControlsBody = z.infer<typeof jobControlsSchema>;

function isLoopback(request: Request): boolean {
  const ip = request.socket.remoteAddress ?? '';

  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

@Controller('jobs')
export class JobsController {
  constructor(
    private readonly jobMonitorService: JobMonitorService,
    private readonly jobQueryService: JobQueryService,
    private readonly jobControlsService: JobControlsService,
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
   * The persisted operator controls, and everything needed to render them
   * honestly: current mode and cap per queue and per schedule, the shipped
   * defaults, the ceiling each cap is bounded by, what is on each queue, and
   * which handful of jobs refuse to be switched off.
   *
   * Appliance-wide, not per-user — the worker loop and the `@Cron` wrapper that
   * enforce these have no user in scope, and a per-user cap could not shrink a
   * semaphore that is shared by everyone's work anyway.
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @RequireCapability(READ_CAPABILITY)
  @Get('controls')
  controls(): Promise<JobControlsDto> {
    return this.jobControlsService.get();
  }

  /**
   * Change them.
   *
   * A PUT that behaves like a PATCH, deliberately: the body names only the
   * controls it wants to change, because a true replace would mean the Jobs page
   * had to send every one of ~90 rows to toggle one switch — and would silently
   * reset anything a second operator changed in between.
   *
   * `write`, not `full`: nothing here deletes anything, and everything is
   * reversible by sending the opposite value. Validation is total before the
   * first write, so a body naming one unknown queue changes nothing rather than
   * applying the valid half of itself.
   *
   * Returns the recomputed state rather than an ack — see `JobControlsService`
   * for why "what you asked for" and "what the appliance will do" are routinely
   * different numbers.
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @RequireCapability(WRITE_CAPABILITY)
  @Put('controls')
  updateControls(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(jobControlsSchema)) body: JobControlsBody,
  ): Promise<JobControlsDto> {
    return this.jobControlsService.update(body, context.userId ?? null);
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

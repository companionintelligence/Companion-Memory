import { Body, Controller, Get, Post, Put, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { Context, type RequestContext } from '@ci/common/context/';
import { FULL_CAPABILITY, READ_CAPABILITY, RequireCapability, WRITE_CAPABILITY } from '@ci/common/decorators';
import { ApplianceAdminGuard, JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';

import { JobControlsDto, JobControlsService } from '../services/JobControlsService';
import { JobDashboardDto, JobMonitorService } from '../services/JobMonitorService';
import {
  JobCategoryHistoryDto,
  JobHistoryDto,
  JobListDto,
  JobQueryService,
  type TerminalJobClearDto,
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
 *
 * Only the type is checked here. The range (whole numbers, 1 to
 * `MAX_CONCURRENCY`) is `JobControlsService.checkConcurrency`'s, which
 * says what the range is and why. Checking it here as well answered 100 with a
 * bare "Validation failed", the only text the Jobs page shows, before the
 * service's explanation could run.
 */
const concurrencyField = z.number().nullable().optional();

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

/**
 * The Jobs dashboard's REST surface.
 *
 * Everything here is APPLIANCE-WIDE rather than per-account: `JobMonitorService`
 * and `JobQueryService` read `pgboss.job` / `ci.job_metrics` with no tenancy
 * predicate, so any authenticated principal sees every account's job metadata.
 * On the single-owner appliance this ships as that is the intended view, but it
 * is not confined to one — and no guard here can confine it, because the scoping
 * that would has to happen in the queries.
 *
 * {@link AdminOnlyGuard} is deliberately NOT applied, despite this being exactly
 * the operator-shaped surface it was written for — but the reason has changed,
 * and the old one is worth recording because it was cited widely. It used to be
 * that no application code ever set `ci.users.role`: the column's only writer
 * was a one-shot backfill (`20260825233952_add_role_to_users_backfill_admin`)
 * promoting the earliest EXISTING row at migration time, which on a fresh
 * install runs before anyone has signed up and so promoted nobody. Gating these
 * routes then would have answered the owner's own Jobs page with a 403 they
 * could not clear.
 *
 * `UserService.claimApplianceIfUnowned` now promotes the account that claims an
 * unowned appliance, so that objection is gone. {@link ApplianceAdminGuard} stays
 * here: it admits a non-admin only on an appliance with no live account at all,
 * and refuses everyone else who is not a live admin, including the members an
 * owner leaves behind (see that guard).
 *
 * What the guards CAN do here, and do, is keep the routes that ACT — `POST
 * jobs/crons/run`, which fires every cron, and `POST jobs/clear-terminal`,
 * which deletes the dead-letter/failed queues — the most strongly gated routes
 * on the controller. Every read below therefore states its capability floor
 * explicitly instead of leaving it unstated: `read` is rank 0, so it narrows no
 * key that reaches these routes today, but it means `full` on the acting routes
 * sits at the top of a ladder that is declared end to end rather than above
 * silence.
 */

const clearTerminalSchema = z.object({
  scope: z.enum(['dead-letter', 'failed']),
});

type ClearTerminalBody = z.infer<typeof clearTerminalSchema>;

@Controller('jobs')
export class JobsController {
  constructor(
    private readonly jobMonitorService: JobMonitorService,
    private readonly jobQueryService: JobQueryService,
    private readonly jobControlsService: JobControlsService,
  ) {}

  @UseGuards(JwtOrApiKeyAuthGuard)
  @RequireCapability(READ_CAPABILITY)
  @Get('dashboard')
  getDashboard(@Context() context: RequestContext): Promise<JobDashboardDto> {
    return this.jobMonitorService.getDashboard(context);
  }

  /**
   * Fire every Nest `@Cron` (or one named job) the way the scheduler would.
   *
   * `full`, not `write`, because the set this fans out over is not curated: it is
   * every schedule the process has registered, and that set includes
   * `AccountPurgeCron.purgeDueAccounts`, which permanently deletes accounts past
   * their grace period. Gating on the *narrowest* thing this can fire would be
   * backwards — the capability has to cover the widest, and a per-cron
   * destructive/non-destructive registry would fail open the day someone adds a
   * schedule and forgets to classify it.
   *
   * This used to be guarded by a loopback check on `request.socket.remoteAddress`
   * instead of by auth, on the theory that operators reach it by `docker exec` +
   * curl. That check could not hold: `remoteAddress` is the IMMEDIATE PEER, so
   * any reverse proxy in front of the API makes every request look local, and
   * this repo ships two that dial the API on localhost — the `make dev` Caddy
   * route at `<project>.localhost`, and the Vite dev server's own `/api` proxy
   * (`API_PROXY_TARGET`), which binds `0.0.0.0` and allows `.ts.net` hosts. Any
   * caller on the network could stampede every cron on the appliance.
   *
   * Nor was there an honest version of the check to fall back to. `X-Forwarded-For`
   * is only meaningful behind a proxy that overwrites it, and `express` here runs
   * `trust proxy = 1` globally, which makes `req.ip` attacker-controlled on a
   * DIRECT connection — a spoofable header check reading as a network-location
   * control is worse than none. The guard is the real control, so it is the only
   * one left.
   */
  @UseGuards(JwtOrApiKeyAuthGuard, ApplianceAdminGuard)
  @RequireCapability(FULL_CAPABILITY)
  @Post('crons/run')
  runCrons(@Query('name') name?: string): {
    fired: string[];
    skipped: string[];
    errors: { name: string; error: string }[];
  } {
    const names = name?.trim() ? [name.trim()] : undefined;

    return this.jobMonitorService.fireCronJobs(names);
  }

  /**
   * Clear terminal jobs named by the Health card — harvested dead-letter rows,
   * or failed origin rows that have already exhausted retries.
   *
   * `full`, not `write`, and the distinction is this repo's own: `write` is
   * defined in `ApiKeyCapability.ts` as "read + mutating tools, but **nothing
   * that deletes**". This route is a hard DELETE. It shipped on `write`, which
   * is also the level every new api key is minted at by default
   * (`DEFAULT_API_KEY_CAPABILITY`), so the broadest, least-considered grant on
   * the appliance reached the one button that destroys rows. Deleting is what
   * `full` exists to name — the same reasoning `crons/run` above already
   * carries.
   *
   * {@link ApplianceAdminGuard} is the other half, and is not redundant with
   * it. `@RequireCapability` is enforced only for api-key principals — see
   * `enforceApiKeyCapability`, which returns early when `apiKeyScopes` is
   * undefined — so on its own it says nothing about a signed-in session, which
   * is how a Jobs page open in any user's browser could clear the appliance.
   * The capability covers the key axis, the guard covers the principal axis,
   * and each is the only control in the case the other does not see.
   */
  @UseGuards(JwtOrApiKeyAuthGuard, ApplianceAdminGuard)
  @RequireCapability(FULL_CAPABILITY)
  @Post('clear')
  clearTerminal(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(clearTerminalSchema)) body: ClearTerminalBody,
  ): Promise<TerminalJobClearDto> {
    return this.jobQueryService.clearTerminal(context, body.scope);
  }

  /**
   * The queryable job list behind the dashboard table.
   *
   * All filters are optional and compose. `state` accepts pg-boss's own states
   * plus the synthetic `dead-letter`, which selects the DLQ copies rather than a
   * state — they are stored as `created`, so without it they are unfindable.
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @RequireCapability(READ_CAPABILITY)
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
  @RequireCapability(READ_CAPABILITY)
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
  @RequireCapability(READ_CAPABILITY)
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
   * {@link ApplianceAdminGuard} all the same, for the reason spelled out on
   * `clear` above: these controls are APPLIANCE-WIDE — pausing a queue or
   * disabling a schedule stops that work for everyone on the box — and the
   * capability decorator governs api keys only, so without the guard any
   * signed-in user could switch off the memory system for the household.
   *
   * Returns the recomputed state rather than an ack — see `JobControlsService`
   * for why "what you asked for" and "what the appliance will do" are routinely
   * different numbers.
   */
  @UseGuards(JwtOrApiKeyAuthGuard, ApplianceAdminGuard)
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
  @RequireCapability(READ_CAPABILITY)
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

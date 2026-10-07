import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { READ_CAPABILITY, RequireCapability, WRITE_CAPABILITY } from '@ci/common/decorators';
import { ApplianceAdminGuard, JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';

import {
  type DeadLetterBulkReplayResult,
  type DeadLetterReplayResult,
  MAX_DEAD_LETTER_PAGE,
  MAX_RUN_PAGE,
  type PipelineDeadLetterView,
  type PipelineRunDetail,
  type PipelineRunSummary,
  PipelineRunService,
} from '../services/PipelineRunService';
import { PipelineStateService, type ReleaseQuarantinedResult } from '../services/PipelineStateService';
import type { StageCoverage } from '../types';

/**
 * A query-string boolean.
 *
 * NOT `z.coerce.boolean()`, which is `Boolean(value)` and therefore maps the
 * string `"false"` to `true` — so `?activeOnly=false` would filter to active
 * runs only, the exact opposite of what it says. An explicit enum makes the
 * accepted spellings reviewable and rejects anything else with a 400 instead of
 * guessing.
 */
const queryBoolean = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const runsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_RUN_PAGE).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  /** Only runs that have not been finalized — i.e. the one this user can't start another past. */
  activeOnly: queryBoolean.optional(),
});

type RunsQuery = z.infer<typeof runsQuerySchema>;

const deadLettersQuerySchema = z.object({
  /**
   * Filter by originating queue. Bound as a parameter, never interpolated, so an
   * arbitrary string is safe; bounded in length only to keep a pathological
   * value out of the query log.
   */
  queue: z.string().min(1).max(128).optional(),

  /** Filter by stage id. Letters from plain queue handlers carry no stage and are excluded by this. */
  stage: z.string().min(1).max(128).optional(),

  /** `true` → only already-replayed, `false` → only the replay queue, absent → both. */
  replayed: queryBoolean.optional(),

  limit: z.coerce.number().int().min(1).max(MAX_DEAD_LETTER_PAGE).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

type DeadLettersQuery = z.infer<typeof deadLettersQuerySchema>;

/**
 * `POST /api/pipeline/dead-letters/replay` — the bulk form.
 *
 * A selector is REQUIRED. There is deliberately no "replay everything" spelling:
 * a real backlog is mostly one or two config errors repeated, and blind replay
 * re-runs them against the same broken config, re-fails, and writes a fresh
 * letter per attempt. Making the caller name a class of failure IS the safety
 * property, so an empty body is a 400 rather than a very expensive no-op.
 *
 * `ids` is capped at the same ceiling as a list page: the batch an operator can
 * see is the batch they can act on, and every claimed letter carries a verbatim
 * payload back onto the bus.
 */
const replayDeadLettersSchema = z
  .object({
    ids: z.array(z.string().uuid()).min(1).max(MAX_DEAD_LETTER_PAGE).optional(),
    eventName: z.string().min(1).max(256).optional(),

    /**
     * ISO-8601 instant. Bare `z.coerce.date()` also accepts `"nonsense"` and
     * yields an Invalid Date, which would bind as NULL and silently WIDEN the
     * selector to every letter; the refinement rejects that with a 400 instead.
     */
    failedAfter: z.coerce
      .date()
      .refine((value) => !Number.isNaN(value.getTime()), { message: 'failedAfter is not a date' })
      .optional(),

    limit: z.coerce.number().int().min(1).max(MAX_DEAD_LETTER_PAGE).optional(),
  })
  .refine((body) => body.ids != null || body.eventName != null || body.failedAfter != null, {
    message:
      'Name the letters to replay: pass ids, and/or eventName and/or failedAfter. ' +
      'Replaying every dead letter is not offered — most of a backlog is one config error, ' +
      'and re-emitting it just re-fails.',
  });

type ReplayDeadLettersBody = z.infer<typeof replayDeadLettersSchema>;

/**
 * `POST /api/pipeline/quarantine/release` — un-park quarantined rows by reason.
 *
 * Both fields are optional and they are not the same kind of optional. Omitting
 * `stage` genuinely means "every stage", because a reason means the same thing
 * wherever it is written. Omitting `reasons` falls back to
 * `TRANSIENT_FAILURE_REASONS` — a DECLARED list, reviewable in a diff, not
 * "everything" — so the default call is exactly "undo what a provider outage did
 * under the old policy" and nothing wider. There is deliberately no spelling
 * that releases every quarantined row: that re-runs whatever is actually broken
 * across the whole ledger, and the reasons the operator can see in
 * `GET /api/pipeline/state` are the ones they can act on.
 */
const releaseQuarantineSchema = z.object({
  reasons: z.array(z.string().min(1).max(256)).min(1).max(50).optional(),
  stage: z.string().min(1).max(128).optional(),
});

type ReleaseQuarantineBody = z.infer<typeof releaseQuarantineSchema>;

/** `GET /api/pipeline/state`. */
export interface PipelineStateResponse {
  stages: StageCoverage[];
}

/** `GET /api/pipeline/runs`. */
export interface PipelineRunsResponse {
  runs: PipelineRunSummary[];
}

/** `GET /api/pipeline/dead-letters`. */
export interface PipelineDeadLettersResponse {
  deadLetters: PipelineDeadLetterView[];
}

/** `POST /api/pipeline/dead-letters/replay`. */
export type PipelineDeadLettersReplayResponse = DeadLetterBulkReplayResult;

/** `POST /api/pipeline/quarantine/release`. */
export type PipelineQuarantineReleaseResponse = ReleaseQuarantinedResult;

/**
 * The operator's window onto the pipeline: what has been processed, what is
 * running, what died, and the three buttons that steer it.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * Until this controller there was NO HTTP surface on this domain at all. The
 * ledger, the runs, the shards and the dead letters were all written and none of
 * them were readable: `IngestStatusService` counts the depth of one pg-boss
 * queue and `JobMonitorService` reads `pgboss.archive`, so neither can say
 * whether any particular row was ever processed — which is how `ci.content` sat
 * at zero embedded rows unnoticed. Every operational question ("is my import
 * finished?", "what failed?", "how do I stop this?") had a psql query for an
 * answer.
 *
 * ── Auth ───────────────────────────────────────────────────────────────────
 *
 * `JwtOrApiKeyAuthGuard` at the class level, matching `MaintenanceController`,
 * the neighbouring operator surface. No `@RequireScopes`: scope enforcement is
 * DENY-BY-DEFAULT, so a scope-limited api key (the memory-scoped chat agent, an
 * MCP key) cannot reach an un-annotated route at all — which is the correct
 * answer for a control plane. Granting it a scope would be the change that
 * opened it up.
 *
 * `@RequireCapability` is the second axis and does apply here, because it also
 * binds empty-scope (legacy, full-access) keys: reads need `read`, and the three
 * control routes plus replay need `write`, so a key the settings UI calls
 * read-only cannot cancel somebody's import. None of these are `full` —
 * `full` is for destructive operations, and nothing here deletes anything.
 *
 * `:id` is not validated in this file: `IdFormatGuard` is registered as a global
 * `APP_GUARD` and 404s any route parameter ending in `id` that is not a uuid, so
 * a malformed id never reaches a `::uuid` cast.
 *
 * ── Scoping ────────────────────────────────────────────────────────────────
 *
 * Every route is user-scoped in the service, by `user_id` in SQL rather than by
 * filtering after the fact. These tables hold verbatim payloads.
 *
 * The one widening is a dead letter that names no user (`user_id` NULL): it is
 * listed and replayable for the appliance admin only, by the rule
 * {@link ApplianceAdminGuard} applies to the Jobs controls. See
 * `unattributedScope` below.
 *
 * Public URLs stay `/api/pipeline/...`. The gateway rewrites `/api/(.*)` to
 * `/$1` before Nest, so this controller is `pipeline`, matching `JobsController`.
 */
@Controller('pipeline')
@UseGuards(JwtOrApiKeyAuthGuard)
export class PipelineController {
  constructor(
    private readonly pipelineRunService: PipelineRunService,
    // The ledger itself, injected alongside the run service because
    // `PipelineStateService` is the ONLY writer of `ci.pipeline_state` and the
    // quarantine release is a ledger write. Routing it through the run service
    // would put a second writer one delegation away from that invariant.
    private readonly pipelineStateService: PipelineStateService,
    // Asked, not applied: every caller may list and replay their OWN letters,
    // so the guard only decides whether NULL-user letters join them.
    private readonly applianceAdminGuard: ApplianceAdminGuard,
  ) {}

  /**
   * Whether this caller also sees the dead letters that name no user.
   *
   * The appliance admin's call, by the same rule as the Jobs controls
   * (`ApplianceAdminGuard.admits`): an admin, or anyone on an appliance that has
   * no admin yet. A household member and a non-admin's API key see only their
   * own letters. The admin probe fails closed; a probe that cannot answer reads
   * as "no", which costs the admin a page of system failures until it can,
   * rather than showing every account somebody's payload.
   */
  private async unattributedScope(request: { user?: { role?: string } }): Promise<boolean> {
    try {
      return await this.applianceAdminGuard.admits(request.user);
    } catch {
      return false;
    }
  }

  /**
   * Per-stage ledger coverage: `done` / `skipped` / `failed` / `pending`
   * (plus `running`, `quarantined` and `stale`) and the stage's CURRENT version.
   *
   * This is the "is my import finished?" answer that has never existed. Read it
   * with two cautions, both of which the numbers themselves state:
   *
   *  - `total` counts LEDGER ROWS, not eligible source rows. A stage that has
   *    never run reports `total: 0` and `coverage: 0`, which is honest but is
   *    not the same as "0 % of your files". Eligibility needs the stage's source
   *    table and applicability predicate, which is the sweep's business.
   *  - `stale` is what a version bump would re-open: rows recorded below
   *    `stageVersion`, regardless of whether they came out `done`, `skipped` or
   *    `quarantined`. It is the number to look at before bumping a stage that
   *    bills an external provider.
   */
  @Get('state')
  @RequireCapability(READ_CAPABILITY)
  async getState(@Context() context: RequestContext): Promise<PipelineStateResponse> {
    const stages = await this.pipelineRunService.stageState(toServiceContext(context));

    return { stages };
  }

  /** This user's runs, newest first, each with its shard tally. */
  @Get('runs')
  @RequireCapability(READ_CAPABILITY)
  async listRuns(
    @Context() context: RequestContext,
    @Query(new ValidationPipe(runsQuerySchema)) query: RunsQuery,
  ): Promise<PipelineRunsResponse> {
    const runs = await this.pipelineRunService.listRuns(toServiceContext(context), {
      limit: query.limit,
      offset: query.offset,
      activeOnly: query.activeOnly,
    });

    return { runs };
  }

  /**
   * One run, expanded to its shards.
   *
   * The `cursor` on each shard is the keyset position — the last source id
   * handed out. Two reads a minute apart showing the same cursor on a `running`
   * shard is what "stuck" looks like, and `leaseExpired` says whether anything
   * still owns it.
   */
  @Get('runs/:id')
  @RequireCapability(READ_CAPABILITY)
  getRun(@Context() context: RequestContext, @Param('id') runId: string): Promise<PipelineRunDetail> {
    return this.pipelineRunService.getRun(toServiceContext(context), runId);
  }

  /**
   * Stop planning new work; let in-flight slices drain.
   *
   * Writes `desired_state` only. Nothing reaches into pg-boss to delete queued
   * jobs — that operation always races a worker that has already claimed one.
   * The control tick reads the intent between batches, so the effect is visible
   * within roughly one slice rather than instantly, and a 200 here means "the
   * intent is recorded", not "everything has stopped".
   */
  @Post('runs/:id/pause')
  @HttpCode(200)
  @RequireCapability(WRITE_CAPABILITY)
  pauseRun(@Context() context: RequestContext, @Param('id') runId: string): Promise<PipelineRunSummary> {
    return this.pipelineRunService.setDesiredState(toServiceContext(context), runId, 'paused');
  }

  /** Resume a paused run. Refused on a cancelled one — cancel is one-way. */
  @Post('runs/:id/resume')
  @HttpCode(200)
  @RequireCapability(WRITE_CAPABILITY)
  resumeRun(@Context() context: RequestContext, @Param('id') runId: string): Promise<PipelineRunSummary> {
    return this.pipelineRunService.setDesiredState(toServiceContext(context), runId, 'running');
  }

  /**
   * Cancel a run.
   *
   * Records the intent; the control tick marks shards cancelled and FINALIZES
   * the run. The run therefore stays active — `finishedAt` null, so this user
   * cannot start another one — until that happens, which is the schema's own
   * contract ("a cancelled run stays active until a worker finalizes it") and
   * what stops a cancel from orphaning in-flight batches.
   */
  @Post('runs/:id/cancel')
  @HttpCode(200)
  @RequireCapability(WRITE_CAPABILITY)
  cancelRun(@Context() context: RequestContext, @Param('id') runId: string): Promise<PipelineRunSummary> {
    return this.pipelineRunService.setDesiredState(toServiceContext(context), runId, 'cancelled');
  }

  /**
   * Dead letters, newest first, filterable by queue and stage.
   *
   * Each row carries its payload verbatim and its full error. That is what makes
   * the list usable and is also why the page is small — see
   * `MAX_DEAD_LETTER_PAGE`.
   */
  @Get('dead-letters')
  @RequireCapability(READ_CAPABILITY)
  async listDeadLetters(
    @Context() context: RequestContext,
    @Req() request: { user?: { role?: string } },
    @Query(new ValidationPipe(deadLettersQuerySchema)) query: DeadLettersQuery,
  ): Promise<PipelineDeadLettersResponse> {
    const deadLetters = await this.pipelineRunService.listDeadLetters(toServiceContext(context), {
      queue: query.queue,
      stage: query.stage,
      replayed: query.replayed,
      limit: query.limit,
      offset: query.offset,
      includeUnattributed: await this.unattributedScope(request),
    });

    return { deadLetters };
  }

  /**
   * Re-emit MANY dead letters' preserved payloads in one call.
   *
   * Declared BEFORE `dead-letters/:id/replay` so route order can never make
   * `replay` read as an `:id` — the two patterns differ in segment count today,
   * but the ordering costs nothing and removes the question.
   *
   * Same WRITE capability and same user scoping as the single-id route, and the
   * same claim: `replayed_at IS NULL`, stamped before the emit, in ONE statement
   * for the whole batch. A double-submit therefore claims nothing the second
   * time — the guard is the database's, not the button's.
   *
   * 200 even when some letters failed: partial failure is the normal outcome of
   * a batch, and the response body says exactly which letters went back on the
   * bus, which failed and why, and which were skipped because they had already
   * been replayed. A blanket 500 would hide the ones that succeeded. Only a
   * malformed request (400 — including an empty selector) fails the call itself.
   */
  @Post('dead-letters/replay')
  @HttpCode(200)
  @RequireCapability(WRITE_CAPABILITY)
  async replayDeadLetters(
    @Context() context: RequestContext,
    @Req() request: { user?: { role?: string } },
    @Body(new ValidationPipe(replayDeadLettersSchema)) body: ReplayDeadLettersBody,
  ): Promise<PipelineDeadLettersReplayResponse> {
    return this.pipelineRunService.replayDeadLetters(toServiceContext(context), {
      ids: body.ids,
      eventName: body.eventName,
      failedAfter: body.failedAfter,
      limit: body.limit,
      includeUnattributed: await this.unattributedScope(request),
    });
  }

  /**
   * Re-emit one dead letter's preserved payload and stamp `replayed_at`.
   *
   * The payload goes back on the bus BYTE FOR BYTE — payload fidelity is the
   * whole reason the reaper stores it verbatim rather than logging a summary,
   * and this is the endpoint that cashes that in. 409 when the letter has
   * already been replayed (`replayed_at` is the idempotency flag that keeps a
   * replay-all from looping) and 400 when it carries no event name to re-emit
   * under.
   */
  @Post('dead-letters/:id/replay')
  @HttpCode(200)
  @RequireCapability(WRITE_CAPABILITY)
  async replayDeadLetter(
    @Context() context: RequestContext,
    @Req() request: { user?: { role?: string } },
    @Param('id') letterId: string,
  ): Promise<DeadLetterReplayResult> {
    return this.pipelineRunService.replayDeadLetter(toServiceContext(context), letterId, {
      includeUnattributed: await this.unattributedScope(request),
    });
  }

  /**
   * Send quarantined rows back to the sweep, selected by the reason they carry.
   *
   * Quarantine's only other exit is a stage-version bump, which re-opens the
   * entire corpus — on a metered stage, a bill for every row in the table in
   * order to retry a few thousand. This releases exactly the rows whose recorded
   * reason the operator names, which is the difference between "the geocode
   * provider was down for twenty minutes last night" costing one retry per
   * affected fix and costing nothing at all because nobody could justify the
   * bump.
   *
   * `write`, not `full`: a released row goes back to `failed` with a due gate —
   * the ordinary state of a row awaiting retry — and if the cause is still there
   * it re-quarantines on its own. Nothing is deleted and nothing is
   * irreversible, so the blast radius of a wrong call is one more attempt per
   * row.
   *
   * 200 with a count, never a 404 for "nothing matched": zero released is a
   * legitimate and common answer (the reason was already clean), and it is a
   * different thing from a request that could not be understood.
   */
  @Post('quarantine/release')
  @HttpCode(200)
  @RequireCapability(WRITE_CAPABILITY)
  releaseQuarantine(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(releaseQuarantineSchema)) body: ReleaseQuarantineBody,
  ): Promise<PipelineQuarantineReleaseResponse> {
    return this.pipelineStateService.releaseQuarantined(toServiceContext(context).userId, {
      reasons: body.reasons,
      stage: body.stage,
    });
  }
}

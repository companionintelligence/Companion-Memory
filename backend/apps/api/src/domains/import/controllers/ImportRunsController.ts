import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { Context, type RequestContext } from '@ci/common/context';
import { READ_CAPABILITY, RequireCapability } from '@ci/common/decorators';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { UserService } from '@ci/domains/user';

import { IMPORT_STAGE_KINDS, type ImportStageKindName } from '../constants';
import { recognizePathWithinRoots, type PathRecognition } from '../datasources/recognizePath';
import { allDataSources } from '../datasources/registry';
import type { ImportRun } from '../entities/ImportRunEntity';
import type { ImportStage } from '../entities/ImportStageEntity';
import {
  buildActiveSnapshot,
  idleSnapshot,
  type ActiveImportSnapshot,
} from '../services/activeImportSnapshot';
import {
  DataSourceCatalogService,
  type DataSourceSummary,
  type BundleCatalogEntry,
  type SourceCatalogEntry,
} from '../services/DataSourceCatalogService';
import { ImportRetentionService, type DiscardedRun } from '../services/ImportRetentionService';
import { ImportRunService } from '../services/ImportRunService';
import { ObjectCountService, type ObjectCountEntry } from '../services/ObjectCountService';
import { isStageStalled } from '../services/stageLiveness';
import { importRootsCallerFor } from '../sources/importRoots';

/** A run as the progress UI reads it. */
export interface RunSummary {
  id: string;
  label: string | null;
  source: string;
  /**
   * The services this run turned out to contain, most rows first — what the run
   * list names it, since the label is only the uploaded archive's filename.
   * Empty until the parse stage has run.
   */
  dataSources: string[];
  /**
   * The importer(s) the user's service card stood for when this run was
   * started from the wizard — see ImportRunEntity.declaredSources. Null when
   * nothing was declared.
   */
  declaredSources: string[] | null;
  status: string;
  percent: number;
  /** Stage kinds this run intends to execute, so the bar can be drawn on the first poll. */
  requestedStages: string[];
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  /**
   * Rows this run actually WROTE into `ci.*` — the push stage's `detail.pushed`.
   *
   * Deliberately not the push stage's `processed`, which is a progress number
   * that also counts rows already present, rows that failed, and entity
   * resolutions. Present on the LIST only: it is one grouped query for the
   * whole page, which is what lets a caller report a run's yield without
   * fetching every run's stages. Zero for a run that has not pushed yet.
   */
  records?: number;
  /**
   * A stage of this run is `running` but has stopped heartbeating — see
   * {@link StageSummary.stalled}. The run's own `status` is a cache written on
   * transitions, so without this it goes on reading `running` for as long as
   * recovery takes. On the list and the detail; absent where neither computed it.
   */
  stalled?: boolean;
}

/** One box of the stage bar. */
export interface StageSummary {
  id: string;
  seq: number;
  kind: string;
  status: string;
  phase: string | null;
  processed: number;
  /** Null means "not yet countable" — the UI must draw an indeterminate bar, not 0%. */
  total: number | null;
  weight: number;
  /**
   * Throughput the runner measured, in units of `processed` per second.
   *
   * Written to `import_stages.items_per_sec` since the table was created and
   * dropped by this mapper until now, so no surface could show it — which is
   * why "is that parse slow, or is it just big?" had no answer short of a psql
   * session. The observed 13-source batch spanned 6/s (a contact list), 250/s
   * (Facebook), 366/s (a push) and 555/s (a 704k-item Takeout parse): a range
   * that says a great deal about where an import's hour went, for one number.
   */
  itemsPerSec: number | null;
  etaSeconds: number | null;
  durationMs: number | null;
  error: string | null;
  detail: Record<string, unknown>;
  /**
   * Also dropped until now. Without them "how long has this stage been going?"
   * is unanswerable for anything still RUNNING — `durationMs` is only written
   * when a stage finishes, so a stage in its 46th minute reported null.
   */
  startedAt: Date | null;
  finishedAt: Date | null;
  /**
   * The claim's last sign of life. A running stage is touched by its worker's
   * heartbeat and every progress write, so this is "when did anything last
   * happen here" — the number that tells a slow stage from an abandoned one.
   */
  heartbeatAt: Date;
  /**
   * `running`, and silent past `IMPORT_STAGE_STALLED_SECONDS`: its worker is
   * gone or wedged. Until this existed that read as a plain `running`, progress
   * frozen and no error, for as long as recovery took to notice. If the worker
   * is gone, the orphan reaper retries the stage within minutes, and
   * `detail.interrupted` then says what happened.
   */
  stalled: boolean;
}

export interface RunDetail extends RunSummary {
  stages: StageSummary[];
}

export interface StartRunBody {
  /** The staged upload to import. */
  dropId?: string;
  label?: string;
  /**
   * Stage kinds to run, in order. Omit for the whole import.
   *
   * The useful narrowing is `['unpack']` alone: it expands the archive without
   * committing to an import, so a caller can ask what is inside before deciding.
   */
  stages?: string[];
  /**
   * The importer name(s) the user's chosen service card covers — what makes
   * the picker's "imported" mark trustworthy. Validated against the importer
   * registry; omit when the upload carries no such intent (generic drops).
   */
  declaredSources?: string[];
}

/** A run whose parsed rows are waiting for a push, with what is waiting. */
export interface UnpushedRunSummary extends RunSummary {
  pendingItems: number;
  pendingEntities: number;
}

export interface StartPushBody {
  /** Restrict the push to these runs. Omit to push everything unpushed. */
  runIds?: string[];
}

export interface RecognizeBody {
  /** Absolute path on the appliance: the caller's own inbox, or a configured import root (administrator only). */
  path?: string;
}

/**
 * The user-facing surface of an import.
 *
 * Separate from `/jobs`, which renders pg-boss for an operator. These two answer
 * different questions for different people — "is my Google Takeout finished?"
 * against "what is the queue doing?" — and merging them would make both worse.
 */
@Controller('import')
export class ImportRunsController {
  constructor(
    private readonly runs: ImportRunService,
    private readonly catalog: DataSourceCatalogService,
    private readonly retention: ImportRetentionService,
    private readonly users: UserService,
    private readonly objectCounts: ObjectCountService,
  ) {}

  /**
   * What this appliance can import.
   *
   * Includes importers marked `stub`: someone looking for their export should
   * learn the appliance knows the format and has not implemented it yet, rather
   * than concluding it is unsupported.
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get('sources')
  listSources(): DataSourceSummary[] {
    return this.catalog.list();
  }

  /**
   * Every AUTHORED source, for the wizard's picker — where `sources` above is
   * keyed by importer, this is keyed by service: sources sharing one parser
   * each get a row, and a source whose importer is not written yet appears
   * with `importerReady: false` instead of being invisible. Order is the
   * curated array order; the frontend must not re-sort it.
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get('sources/catalog')
  sourceCatalog(): SourceCatalogEntry[] {
    return this.catalog.catalog();
  }

  /**
   * The export bundles — Google Takeout, Meta Accounts Center, Amazon Privacy
   * Central — each ONE download that covers several of the catalog's sources.
   * The wizard shows a bundle as one picker button and one export card in
   * place of its members' own. Authored beside the guides so every export
   * instruction the wizard shows comes from the backend.
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get('sources/bundles')
  sourceBundles(): BundleCatalogEntry[] {
    return this.catalog.bundles();
  }

  /**
   * How much of each memory kind this user's imports have actually put in
   * `ci.*`, per importer — what the picker's tiles show under "24K Mail",
   * "1.2M Photos". Read from the live tables themselves, never from run
   * history; see {@link ObjectCountService} for why that distinction matters
   * and what it does and does not compute.
   *
   * Scoped to the caller by construction (every query below is `WHERE user_id
   * = $1` / `WHERE owner_user_id = $1`) — there is no cross-user aggregate to
   * accidentally expose.
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get('sources/object-counts')
  async objectCountsForCaller(@Context() context: RequestContext): Promise<ObjectCountEntry[]> {
    const userId = requireUserId(context);

    return this.objectCounts.countsForUser(userId);
  }

  /**
   * What every parser makes of a path the appliance can already see.
   *
   * The read-before-you-commit question, and the one thing the rest of this
   * controller cannot answer: everywhere else an archive is opaque bytes until a
   * run unpacks it, so `runs/:runId/recognized` reports what the parse stage
   * found — after the import. This answers first, which is what makes
   * `ci recognize` (and the identical `import.recognize_path` MCP tool,
   * which shares the implementation) able to say "that folder is a Google
   * Takeout" before anything is written.
   *
   * POST, not GET, because the argument is a filesystem path: a query string
   * ends up in access logs and proxy history, and the reply is not cacheable
   * anyway — the folder it describes changes.
   *
   * Confined to the caller's own inbox, plus `CI_IMPORT_ROOTS` for the
   * administrator, exactly as the MCP tool is. A path outside them answers
   * `allowed: false` with the remedy rather than 4xx: "not permitted, upload
   * instead" is a state the caller renders, not a fault.
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Post('recognize')
  // POST for the reasons above, but a pure read ("before anything is written").
  @RequireCapability(READ_CAPABILITY)
  async recognize(@Context() context: RequestContext, @Body() body: RecognizeBody): Promise<PathRecognition> {
    if (!body?.path) {
      throw new BadRequestException('path is required');
    }

    // The caller's account scopes which inbox subtree they may read — their
    // own — and only the administrator reaches the configured roots.
    const userId = requireUserId(context);
    const user = await this.users.findById({ userId }, userId);

    return recognizePathWithinRoots(body.path, importRootsCallerFor(user));
  }

  /** Start importing a staged upload. */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Post('runs')
  async start(@Context() context: RequestContext, @Body() body: StartRunBody): Promise<RunDetail> {
    const userId = requireUserId(context);

    if (!body?.dropId) {
      throw new BadRequestException('dropId is required');
    }

    const { run, stages } = await this.runs.startRun(
      { userId },
      {
        dropId: body.dropId,
        label: body.label,
        source: 'api',
        stages: parseStages(body.stages),
        declaredSources: parseDeclaredSources(body.declaredSources),
      },
    );

    return { ...toRunSummary(run), stages: stages.map(toStageSummary) };
  }

  /**
   * This user's runs, newest first, keyset-paged.
   *
   * `beforeCreatedAt` + `beforeId` (both or neither) are the last row of the
   * page already shown; the response is runs strictly older than it. Cursor
   * rather than offset because a Takeout session creates runs WHILE history is
   * being read — an offset page shifts under new rows, a cursor cannot. The
   * response stays a bare array: a page shorter than `limit` is the last one.
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get('runs')
  async list(
    @Context() context: RequestContext,
    @Query('limit') limit?: string,
    @Query('beforeCreatedAt') beforeCreatedAt?: string,
    @Query('beforeId') beforeId?: string,
  ): Promise<RunSummary[]> {
    const userId = requireUserId(context);
    const parsed = limit == null ? undefined : Number(limit);
    const runs = await this.runs.listRuns(
      { userId },
      {
        // A positive whole number, or the default. `-1` reached the query as
        // a negative LIMIT and answered 500.
        limit: Number.isInteger(parsed) && (parsed as number) > 0 ? parsed : undefined,
        before: parseBeforeCursor(beforeCreatedAt, beforeId),
      },
    );

    return runs.map((run) => ({ ...toRunSummary(run), records: run.records, stalled: run.stalled }));
  }

  /**
   * The runs the Sync card offers: parse finished, nothing pushed yet.
   *
   * MUST stay declared above `runs/:runId` — route registration follows
   * declaration order, and below it Express would match `unpushed` as a runId.
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get('runs/unpushed')
  async listUnpushed(@Context() context: RequestContext): Promise<UnpushedRunSummary[]> {
    const userId = requireUserId(context);
    const unpushed = await this.runs.listUnpushed({ userId });

    return unpushed.map(({ run, pendingItems, pendingEntities }) => ({
      ...toRunSummary(run),
      pendingItems,
      pendingEntities,
    }));
  }

  /**
   * Everything in flight right now, with stages, queue positions and errors.
   *
   * THE endpoint to poll while an import runs, and the one to curl when an
   * import looks wrong. It exists because per-run detail polling does not scale
   * to the shape people actually run — a batch import of an inbox is one run per
   * top-level folder, so the 13-source corpus this was built against meant 13
   * requests every two seconds, each with its own re-render clock, and still no
   * answer to "why has that one not moved in an hour?"
   *
   * What it adds over `runs/:runId` × N, all of it computed rather than guessed:
   *
   *  - `runs[].unit` — WHICH source each run is importing. Thirteen runs of one
   *    batch share a label and have empty `dataSources` until they parse, so
   *    until now the list showed thirteen identical rows.
   *  - `stages[].queueState` — `waiting` (enqueued, needs the slot) against
   *    `blocked` (its own run has not got there yet). Both are `status:
   *    'queued'` in the database, and conflating them is exactly why a normal
   *    51-minute wait is indistinguishable from a stall.
   *  - `stages[].queuePosition` / `queue.concurrency` — how many are ahead of it
   *    and how many can run at once.
   *  - `elapsedMs` everywhere, live.
   *
   * MUST stay declared above `runs/:runId`: route registration follows
   * declaration order, and below it Express matches `active` as a run id — the
   * same trap `runs/unpushed` documents.
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get('runs/active')
  async active(@Context() context: RequestContext): Promise<ActiveImportSnapshot> {
    const userId = requireUserId(context);
    const batch = await this.runs.activeBatch({ userId });

    // Not a 404 and not an empty array: "nothing is importing" is a state every
    // caller renders (by rendering nothing), and making it an error would put an
    // error banner on a page whose only sin is that the import already finished.
    if (batch == null) {
      return idleSnapshot();
    }

    return buildActiveSnapshot(batch);
  }

  /** One run, with its stage bar. The poll target for ONE run someone opened. */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get('runs/:runId')
  async get(@Context() context: RequestContext, @Param('runId') runId: string): Promise<RunDetail> {
    const userId = requireUserId(context);
    const detail = await this.runs.getRunDetail({ userId }, runId);

    if (detail == null) {
      throw new NotFoundException(`No import run ${runId}`);
    }

    const stages = detail.stages.map(toStageSummary);

    return { ...toRunSummary(detail.run), stalled: stages.some((stage) => stage.stalled), stages };
  }

  /**
   * What a run found in the upload.
   *
   * Answerable once `unpack` has finished, because that is when there is a tree
   * to look at — the staged upload itself is an opaque archive. Reads what
   * the parse stage recorded rather than re-scanning, so asking twice costs
   * nothing and the answer matches what actually got imported.
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get('runs/:runId/recognized')
  async recognized(
    @Context() context: RequestContext,
    @Param('runId') runId: string,
  ): Promise<{ recognized: DataSourceSummary[]; pending: boolean }> {
    const userId = requireUserId(context);
    const detail = await this.runs.getRunDetail({ userId }, runId);

    if (detail == null) {
      throw new NotFoundException(`No import run ${runId}`);
    }

    const parse = detail.stages.find((stage) => stage.kind === 'parse');
    const names = Array.isArray(parse?.detail?.recognized)
      ? (parse.detail.recognized as unknown[]).filter((name): name is string => typeof name === 'string')
      : [];

    return {
      recognized: names
        .map((name) => this.catalog.find(name))
        .filter((source): source is DataSourceSummary => source != null),
      // The honest "ask again later": the parse has not run, so an empty list
      // here means unknown rather than nothing.
      pending: parse == null || parse.status === 'queued' || parse.status === 'running',
    };
  }

  /** Stop a run the user no longer wants. */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Post('runs/:runId/cancel')
  async cancel(
    @Context() context: RequestContext,
    @Param('runId') runId: string,
  ): Promise<{ cancelled: boolean }> {
    const userId = requireUserId(context);
    const cancelled = await this.runs.cancel({ userId }, runId);

    if (!cancelled) {
      throw new NotFoundException(`No import run ${runId} still in flight`);
    }

    return { cancelled };
  }

  /**
   * Throw away a parse the user has decided against, and everything it staged.
   *
   * The counterpart to Sync, and the reason a pushable run is no longer
   * immortal. Retention refuses by age to delete a run whose parse is still on
   * offer — those staged rows are the only surviving copy of it — so the only
   * thing that can end such a run is its owner saying so. Until this route
   * existed the nightly sweep reported those runs under `push_pending` and
   * named an action nobody could take.
   *
   * `?confirm=discard` is mandatory and the reply itemises the loss, because
   * there is no undo: an abandoned 780k-item parse is ~640 MB of `staged_items`
   * and the archive it came from was purged at 24h. A DELETE that fires on a
   * mistyped URL is not a thing this endpoint should be.
   *
   * It itemises the SURVIVALS too, and the caller is expected to show them. A
   * discard destroys the parse, not the import: an archive the appliance still
   * holds goes back to the uploads list, and the photos the media stage already
   * stored stay in the user's memory because nothing can prove after the fact
   * that this run is the only thing that put them there. "Discarded" on its own
   * would be read as "nothing left behind", which is false in both directions.
   *
   * Refusals are specific by design — 404 for a run that is not this user's,
   * 409 naming which rule stopped it — since "no" without a reason on a
   * destructive route reads as a bug. See
   * {@link ImportRetentionService.discardRun} for what it will and will not
   * take.
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Delete('runs/:runId')
  async discard(
    @Context() context: RequestContext,
    @Param('runId') runId: string,
    @Query('confirm') confirm?: string,
  ): Promise<DiscardedRun> {
    const userId = requireUserId(context);

    if (confirm !== 'discard') {
      throw new BadRequestException(
        'Discarding an import run permanently deletes the parse it staged, and there is no undo. ' +
          'Pass ?confirm=discard to proceed.',
      );
    }

    const discarded = await this.retention.discardRun({ userId }, runId);

    if (discarded == null) {
      throw new NotFoundException(`No import run ${runId}`);
    }

    return discarded;
  }

  /**
   * Re-run a stage that failed.
   *
   * The counterpart to the worker NOT retrying on its own: a redelivered job
   * no-ops so a transient blip cannot silently re-unpack a 40GB archive,
   * which leaves asking for it as a deliberate act.
   */
  /**
   * The wizard's Sync: push everything staged and never pushed.
   *
   * An empty answer is `{ runs: [] }`, not an error — "nothing to sync" is a
   * state the Sync card renders, not a fault. Progress after this call is the
   * ordinary run poll; nothing here is worth a second live surface.
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Post('push')
  async startPush(
    @Context() context: RequestContext,
    @Body() body?: StartPushBody,
  ): Promise<{ runs: RunSummary[] }> {
    const userId = requireUserId(context);
    const started = await this.runs.startPush({ userId }, { runIds: parseRunIds(body?.runIds) });

    return { runs: started.map(({ run }) => toRunSummary(run)) };
  }

  /**
   * Push the rows a completed push could not write.
   *
   * The counterpart to the stage retry below, for the other kind of failure: a
   * push that mostly worked leaves its casualties at `push_status = 'failed'`,
   * where nothing looks at them again — the push reads only `pending`, Sync
   * skips a run that already has a push stage, and a stage retry refuses a
   * stage that completed. This resets those rows and re-queues the push.
   *
   * It also re-drives a push that ran and FAILED — with its rows still
   * pending (how a push ends when the database stays away past its wait, or
   * crashes under one of its statements), or after every row settled — so `ci push --run <id> --retry-failed` is one
   * command for every shape of "this run's push did not finish".
   *
   * `{ items: 0, entities: 0, requeued: false }` is a fine answer, not an
   * error: it means there was nothing stranded, which is what the caller
   * wanted to be true. A 409, with the reason and the way forward, for a run
   * with a stage still working (resetting rows under a running push would
   * hand them to two writers), a run whose stages ahead of the push did not
   * complete (cancelled mid-parse), and a push that never ran.
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Post('runs/:runId/push/retry')
  async retryFailedPush(
    @Context() context: RequestContext,
    @Param('runId') runId: string,
  ): Promise<{ items: number; entities: number; requeued: boolean }> {
    const userId = requireUserId(context);
    const result = await this.runs.retryFailedPush({ userId }, runId);

    if (result == null) {
      throw new NotFoundException(`No import run ${runId}`);
    }

    return result;
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Post('runs/:runId/stages/:stageId/retry')
  async retryStage(
    @Context() context: RequestContext,
    @Param('runId') runId: string,
    @Param('stageId') stageId: string,
  ): Promise<{ requeued: boolean }> {
    const userId = requireUserId(context);
    const requeued = await this.runs.retryStage({ userId }, runId, stageId);

    if (!requeued) {
      throw new NotFoundException(
        `No failed or cancelled stage ${stageId} on run ${runId} — only those can be re-run`,
      );
    }

    return { requeued };
  }
}

function requireUserId(context: RequestContext): string {
  if (!context.userId) {
    throw new BadRequestException('An authenticated user is required');
  }

  return context.userId;
}

/**
 * Validate a caller-supplied stage list against the closed vocabulary.
 *
 * A typo would otherwise create a stage no runner can execute, which the worker
 * fails loudly but only after the run has started — better to refuse it here,
 * where the caller can still fix it.
 */
/**
 * Validate a caller-supplied run-id filter as UUID-shaped.
 *
 * The service binds these to a `$n::uuid[]` cast, where a typo becomes a
 * Postgres syntax error — a 500 wearing the wrong blame. Refusing here names
 * the offending values while the caller can still fix them, the same bargain
 * `parseStages` makes.
 */
function parseRunIds(runIds: string[] | undefined): string[] | undefined {
  if (runIds == null) {
    return undefined;
  }

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const invalid = runIds.filter((id) => !UUID.test(id));

  if (invalid.length > 0) {
    throw new BadRequestException(`Not import run ids: ${invalid.join(', ')}`);
  }

  return runIds;
}

function parseStages(stages: string[] | undefined): ImportStageKindName[] | undefined {
  if (stages == null) {
    return undefined;
  }

  const invalid = stages.filter((stage) => !(IMPORT_STAGE_KINDS as readonly string[]).includes(stage));

  if (invalid.length > 0) {
    throw new BadRequestException(
      `Unknown import stage(s): ${invalid.join(', ')}. Valid stages: ${IMPORT_STAGE_KINDS.join(', ')}`,
    );
  }

  return stages as ImportStageKindName[];
}

/**
 * Validate a declared-source list against the importer registry.
 *
 * Strict, because these strings become the picker's "you imported this"
 * evidence: an unknown name would sit in the column forever, crediting
 * nothing (harmless) or — worse — colliding with an importer added later
 * (a claim nobody made). Deduplicated and capped so a buggy caller cannot
 * grow the column without bound.
 */
function parseDeclaredSources(declared: string[] | undefined): string[] | undefined {
  if (declared == null) {
    return undefined;
  }

  if (!Array.isArray(declared) || declared.some((name) => typeof name !== 'string')) {
    throw new BadRequestException('declaredSources must be an array of importer names');
  }

  const known = new Set(allDataSources().map((source) => source.name));
  const unique = [...new Set(declared)];
  const invalid = unique.filter((name) => !known.has(name));

  if (invalid.length > 0) {
    throw new BadRequestException(`Unknown declared source(s): ${invalid.join(', ')}`);
  }

  if (unique.length > 64) {
    throw new BadRequestException('declaredSources: too many entries');
  }

  return unique.length > 0 ? unique : undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The pagination cursor, validated strictly: both halves or neither, a real
 * timestamp, a real uuid. Query params bypass `IdFormatGuard` (it reads route
 * params), and `beforeId` reaches a `::uuid` cast — a malformed value must be
 * a 400 here, not a 500 there.
 */
function parseBeforeCursor(
  beforeCreatedAt: string | undefined,
  beforeId: string | undefined,
): { createdAt: Date; id: string } | undefined {
  if (beforeCreatedAt == null && beforeId == null) {
    return undefined;
  }

  if (beforeCreatedAt == null || beforeId == null) {
    throw new BadRequestException('beforeCreatedAt and beforeId must be provided together');
  }

  const createdAt = new Date(beforeCreatedAt);

  if (Number.isNaN(createdAt.getTime())) {
    throw new BadRequestException('beforeCreatedAt must be a valid timestamp');
  }

  if (!UUID_RE.test(beforeId)) {
    throw new BadRequestException('beforeId must be a uuid');
  }

  return { createdAt, id: beforeId };
}

function toRunSummary(run: ImportRun): RunSummary {
  return {
    id: run.id,
    label: run.label,
    source: run.source,
    dataSources: run.dataSources,
    declaredSources: run.declaredSources,
    status: run.status,
    percent: run.percent,
    requestedStages: run.requestedStages,
    error: run.error,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

function toStageSummary(stage: ImportStage): StageSummary {
  return {
    id: stage.id,
    seq: stage.seq,
    kind: stage.kind,
    status: stage.status,
    phase: stage.phase,
    processed: Number(stage.processed),
    total: stage.total == null ? null : Number(stage.total),
    weight: stage.weight,
    itemsPerSec: stage.itemsPerSec,
    etaSeconds: stage.etaSeconds,
    durationMs: stage.durationMs == null ? null : Number(stage.durationMs),
    error: stage.error,
    detail: stage.detail ?? {},
    startedAt: stage.startedAt,
    finishedAt: stage.finishedAt,
    heartbeatAt: stage.updatedAt,
    stalled: isStageStalled(stage),
  };
}

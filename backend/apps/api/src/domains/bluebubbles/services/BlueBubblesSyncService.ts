import crypto from 'node:crypto';

import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import {
  BlueBubblesApiClient,
  BlueBubblesAPIImporter,
  downloadAttachments,
  IMPORT_STAGE_KINDS,
  ImportRunService,
  ImportScratchService,
  mapBlueBubblesMessageToGraph,
  MediaStage,
  PushStage,
  StagedWriter,
  type BlueBubblesMessage,
  type ImportStageKindName,
  type StageRunContext,
} from '@ci/domains/import';
import { UserService } from '@ci/domains/user';

import { BlueBubblesConfigEntity } from '../entities/BlueBubblesConfigEntity';

import { BlueBubblesConfigService, SYNC_HEARTBEAT_MS } from './BlueBubblesConfigService';

/**
 * The stage kinds a BlueBubbles sync run declares.
 *
 * DERIVED from {@link IMPORT_STAGE_KINDS} rather than restated, minus the one
 * kind a connector genuinely has no work for: there is no archive to unpack
 * when the source is a REST API. Restating the list is exactly how this broke —
 * the hand-written copy said `['parse', 'push']`, so `media` never ran, and
 * since `MediaStage` is the only writer of `AttachmentFileIds` (the only key
 * `toCommunicationInput` reads for attachments), every BlueBubbles attachment
 * was downloaded over HTTP, written to disk, and then never uploaded,
 * catalogued or reclaimed. `ci.communications.attachments` was empty for every
 * BlueBubbles message on the live corpus. A kind added to the import spine now
 * joins this run automatically, which is the property `DEFAULT_STAGES` has and
 * this list did not.
 */
const BLUEBUBBLES_STAGES: readonly ImportStageKindName[] = IMPORT_STAGE_KINDS.filter(
  (kind) => kind !== 'unpack',
);

/**
 * How often a running pass samples what it has staged.
 *
 * Two jobs in one write. It is the PROGRESS the Import Runs UI shows — nothing
 * called `recordProgress` during a multi-hour BlueBubbles parse, so the bar sat
 * at 0% for the whole run, which `ParseStage` explains is worse than no counter
 * because it reads as a hang. It is also the stage HEARTBEAT: `recordProgress`
 * stamps `updated_at`, which is the only thing standing between a healthy live
 * pass and `ImportRunService.resumeInterrupted`, whose ten-minute staleness
 * sweep would otherwise reclaim it and re-queue its stages onto pg-boss.
 *
 * Matches `ParseStage`'s own sample interval for the same reason it chose it.
 */
const PROGRESS_SAMPLE_MS = 2_000;

/**
 * How long live webhook deliveries are gathered before one run ingests them.
 *
 * Every delivery used to mint a FULL import run of its own: an `import_runs`
 * row, a stage row per kind, begin/complete per stage, `finishRun`, four
 * `refreshRunRollup` calls, a cursor MAX() over `staged_items`, a whole
 * `PushStage.run` — including the `pg_database_size` that PushStage's own
 * comment says must not be per-batch — and three pg-boss sweep enqueues. A
 * thousand-message burst was a thousand runs and ~3,000 sweep requests, none of
 * them serialized. Coalescing turns that burst into one run.
 *
 * Two seconds because the unit is a person's messages: it is short enough that
 * a text is in `ci.*` before anyone could look for it, and long enough that a
 * group chat going off collapses into a single run rather than thirty.
 */
const WEBHOOK_COALESCE_MS = 2_000;

/** Backoff before retrying a flush that lost the sync claim to a bulk pass. */
const WEBHOOK_CLAIM_RETRY_MS = 30_000;

/**
 * Live messages held in memory awaiting a flush, at most.
 *
 * The queue is deliberately lossy at the ceiling rather than unbounded. A
 * dropped live message is not lost data: the backstop cron re-fetches from the
 * backfill cursor and finds it, which is the same guarantee that covers a
 * webhook the network ate or a process that restarted with a full queue. An
 * unbounded queue behind a claim held by a multi-hour backfill is not
 * recoverable in the same way — it is the appliance running out of memory.
 */
const WEBHOOK_QUEUE_MAX = 2_000;

/**
 * Drives BlueBubbles ingestion into `ci.*`, in-process, for both of its
 * callers: {@link runSync} (a bulk backfill/poll pass, from
 * `BlueBubblesSyncCron` or the settings page's "Sync now") and
 * {@link ingestWebhookMessage} (live messages, from
 * `BlueBubblesWebhookController`). Both stage their graphs the same way
 * `ParseStage` does and run the same in-process `MediaStage`/`PushStage` — see
 * the shared {@link runIngest} below.
 *
 * Deliberately does NOT go through the full pg-boss claim/heartbeat stage graph
 * archive imports use (`ImportRunService.startRun` + the pg-boss-driven
 * `ImportStageListener`) — that machinery exists for a 40GB archive whose
 * `unpack`/`parse` can run for hours and must survive a process restart. A
 * BlueBubbles ingest is a sequence of REST calls (or, for a webhook delivery,
 * zero — the messages are already in hand); running it synchronously,
 * in-process, from the caller is simpler and sufficient.
 *
 * A `ci_import.import_runs` row (+ its stage rows) is still written per pass,
 * for audit visibility in the existing Import Runs UI — through
 * `ImportRunService.createInProcessRun`, so the stage list and its weights come
 * from the same place every other run's do — and so this reuses that service's
 * existing stage-transition bookkeeping (`beginStage`/`recordProgress`/
 * `completeStage`/`failStage`/`finishRun`) rather than reimplementing the
 * run/percent rollup.
 *
 * ## One pass at a time, appliance-wide
 *
 * Every entry point goes through {@link withSyncClaim}. The claim is a row in
 * the database, not a field on this instance, because the cron is registered in
 * both the api and the worker process and "Sync now" adds callers on top — see
 * `BlueBubblesConfigService.claimSync`.
 */
@Injectable()
export class BlueBubblesSyncService implements OnModuleDestroy {
  /** Live deliveries awaiting a coalesced flush. See {@link WEBHOOK_COALESCE_MS}. */
  private readonly webhookQueue: BlueBubblesMessage[] = [];

  private webhookFlushTimer: NodeJS.Timeout | null = null;

  private webhookFlushing = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly configService: BlueBubblesConfigService,
    private readonly importRunService: ImportRunService,
    private readonly scratchService: ImportScratchService,
    private readonly mediaStage: MediaStage,
    private readonly pushStage: PushStage,
    private readonly userService: UserService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(BlueBubblesSyncService.name);
  }

  onModuleDestroy(): void {
    if (this.webhookFlushTimer != null) {
      clearTimeout(this.webhookFlushTimer);
      this.webhookFlushTimer = null;
    }
  }

  /** Run one sync pass. No-ops quietly when BlueBubbles isn't configured/enabled. */
  async runSync(): Promise<void> {
    const config = await this.configService.getOrCreate();

    // The password belongs in this gate with the rest of the connection, not
    // one layer down. It used to be checked only inside `apiImport`, which
    // logged at ERROR and returned — so an appliance with a host, a port and
    // `enabled` but no stored password wrote an error to the log every ten
    // minutes forever. Not being configured yet is a state, not a failure.
    if (!this.isConfigured(config)) {
      return;
    }

    await this.withSyncClaim(config, 'BlueBubbles sync', () =>
      this.runIngest(config, 'BlueBubbles sync', {
        advanceCursor: true,
        recordsConnectionHealth: true,
        populate: (writer, scratchDir) =>
          new BlueBubblesAPIImporter().apiImport(this.settingsFor(config), {
            pipeline: writer,
            mediaStoreDir: scratchDir,
            log: (level, msg, meta) => this.forwardLog(level, msg, meta),
          }),
      }),
    );
  }

  /**
   * Queue one message the webhook just delivered — the live-ingestion
   * counterpart to {@link runSync}'s bulk backfill/poll.
   *
   * Queued rather than ingested here: see {@link WEBHOOK_COALESCE_MS} for what
   * a run per message cost. The flush shares the exact mapping
   * ({@link mapBlueBubblesMessageToGraph}) and the same run/stage/push
   * machinery the bulk importer uses, so a message that arrives via webhook is
   * indistinguishable downstream from one a sync pass would have found.
   *
   * The chat each message belongs to is read off the webhook payload's own
   * embedded `chats[0]` (BlueBubbles includes it on `new-message` /
   * `updated-message` events) rather than fetched fresh — a full `queryChats()`
   * directory lookup per live message would be one more round trip for every
   * text the appliance receives, for a participant list the payload already
   * carries.
   */
  async ingestWebhookMessage(message: BlueBubblesMessage): Promise<void> {
    const config = await this.configService.getOrCreate();

    if (!this.isConfigured(config)) {
      return;
    }

    if (this.webhookQueue.length >= WEBHOOK_QUEUE_MAX) {
      this.logger.warn('BlueBubbles webhook queue is full; dropping a live message to the backstop poll', {
        queued: this.webhookQueue.length,
      });

      return;
    }

    this.webhookQueue.push(message);
    this.scheduleWebhookFlush(WEBHOOK_COALESCE_MS);
  }

  /** Arm the coalescing timer, unless one is already armed. */
  private scheduleWebhookFlush(delayMs: number): void {
    if (this.webhookFlushTimer != null) {
      return;
    }

    this.webhookFlushTimer = setTimeout(() => {
      this.webhookFlushTimer = null;
      void this.flushWebhookQueue();
    }, delayMs);

    // The appliance must be able to shut down with messages still queued; the
    // backstop poll re-fetches whatever a shutdown drops.
    this.webhookFlushTimer.unref?.();
  }

  /**
   * Ingest everything queued since the last flush, as ONE run.
   *
   * A flush that cannot take the sync claim — a bulk backfill is running — puts
   * its batch back at the FRONT of the queue and tries again later, rather than
   * running a second concurrent push into `ci.*`. Order is preserved so a reply
   * cannot be staged before the message it answers.
   */
  private async flushWebhookQueue(): Promise<void> {
    if (this.webhookFlushing || this.webhookQueue.length === 0) {
      return;
    }

    this.webhookFlushing = true;

    try {
      const config = await this.configService.getOrCreate();

      if (!this.isConfigured(config)) {
        this.webhookQueue.length = 0;

        return;
      }

      const batch = this.webhookQueue.splice(0, this.webhookQueue.length);
      const client = new BlueBubblesApiClient({
        host: config.host,
        port: config.port,
        useHttps: config.useHttps,
        password: config.password,
      });

      const ran = await this.withSyncClaim(config, 'BlueBubbles webhook', () =>
        this.runIngest(config, `BlueBubbles webhook (${batch.length})`, {
          // The live high-water mark must never move the BACKFILL cursor: a
          // message delivered before the backfill has caught up would otherwise
          // pin it at "now" and skip the whole history behind it, forever, under
          // a `completed` run with no error. See recordSyncCursor.
          advanceCursor: false,
          // Never: this path does not authenticate outbound, so it has no
          // standing to say the connection is healthy. See the option's doc.
          recordsConnectionHealth: false,
          populate: async (writer, scratchDir) => {
            for (const message of batch) {
              const graph = mapBlueBubblesMessageToGraph(message, message.chats?.[0]);

              await downloadAttachments(graph, message, client, scratchDir, (level, msg, meta) =>
                this.forwardLog(level, msg, meta),
              );
              writer.push(graph);
            }
          },
        }),
      );

      if (!ran) {
        this.webhookQueue.unshift(...batch);
        this.scheduleWebhookFlush(WEBHOOK_CLAIM_RETRY_MS);
      }
    } catch (err) {
      // `runIngest` records its own failures onto the run and the config row;
      // this only covers what happens before it can (a dead pool, say).
      this.logger.error(
        'BlueBubbles webhook flush failed',
        err instanceof Error ? err : new Error(String(err)),
      );
    } finally {
      this.webhookFlushing = false;

      if (this.webhookQueue.length > 0) {
        this.scheduleWebhookFlush(WEBHOOK_COALESCE_MS);
      }
    }
  }

  /** Is there enough saved for a sync to be attempted at all? */
  private isConfigured(config: BlueBubblesConfigEntity): boolean {
    return config.enabled && Boolean(config.host) && Boolean(config.port) && Boolean(config.password);
  }

  /**
   * Hold the appliance-wide sync claim for the length of `work`, heartbeating
   * so a long pass is never mistaken for a dead one.
   *
   * Returns false when the claim is already held — the caller decides whether
   * that means "skip this tick" (the cron) or "try again shortly" (a webhook
   * flush). See `BlueBubblesConfigService.claimSync` for why this cannot be an
   * in-process flag.
   */
  private async withSyncClaim(
    config: BlueBubblesConfigEntity,
    label: string,
    work: () => Promise<void>,
  ): Promise<boolean> {
    const token = crypto.randomUUID();

    if (!(await this.configService.claimSync(config.id, token))) {
      this.logger.log(`${label} skipped: another BlueBubbles sync pass holds the claim`);

      return false;
    }

    const heartbeat = setInterval(() => {
      void this.configService.heartbeatSync(config.id, token).catch(() => undefined);
    }, SYNC_HEARTBEAT_MS);

    try {
      await work();
    } finally {
      clearInterval(heartbeat);
      await this.configService.releaseSync(config.id, token).catch(() => undefined);
    }

    return true;
  }

  /**
   * Shared run/stage lifecycle for one ingest pass — a bulk {@link runSync} or
   * a coalesced batch of webhook deliveries. `populate` is the only thing that
   * differs between the two.
   *
   * ## Why the cursor moves where it does
   *
   * AFTER the push, never before. It used to advance between parse and push,
   * and `recordSyncCursor` is a ratchet, so a push that then failed left those
   * messages staged but never written to `ci.*` with every recovery path shut:
   * `retryFailedPush` only resets rows already marked `failed` (these were
   * `pending`), `pushableRunSql` excludes any run that has a push stage at any
   * status, and the cursor had moved past them so no later sync would re-fetch
   * them. Permanent, silent data loss. Advancing only once the rows are in
   * `ci.*` makes the worst case a re-fetch, which the staging dedup absorbs.
   */
  private async runIngest(
    config: BlueBubblesConfigEntity,
    label: string,
    options: {
      advanceCursor: boolean;
      /**
       * Whether this pass's outcome is evidence about the OUTBOUND connection.
       *
       * Only a pass that actually authenticated against the BlueBubbles server
       * may touch `connection_status` / `last_error`. A webhook flush never
       * does — the payload arrives in hand, and the one call it does make
       * (`downloadAttachments`) swallows its own failures — so letting it
       * report health re-opened exactly the hole C2 closed: one inbound text
       * after a 401'd backfill stamped `connected` and cleared the error,
       * leaving the config row claiming a working sync that was in fact
       * rejected. Inbound liveness has its own field, `last_webhook_received_at`.
       */
      recordsConnectionHealth: boolean;
      populate: (writer: StagedWriter, scratchDir: string) => Promise<void>;
    },
  ): Promise<void> {
    const userId = await this.resolveOwnerUserId();

    if (!userId) {
      this.logger.warn('BlueBubbles ingest skipped: no onboarded user to attribute messages to');

      return;
    }

    const { runId, stages } = await this.importRunService.createInProcessRun({
      userId,
      label,
      source: 'connections',
      stages: BLUEBUBBLES_STAGES,
      declaredSources: ['bluebubbles'],
    });
    const stageIdByKind = new Map(stages.map((stage) => [stage.kind, stage.id]));
    // A REAL scratch directory, keyed by run like every other import's. This
    // used to be `os.tmpdir()` — the hazard `ParseStage` calls out by name:
    // `/tmp` is tmpfs on a stock appliance, so a large backfill's attachments
    // would consume RAM until the machine died, and nothing sweeps it. It is
    // also what `MediaStage` requires: it refuses to open a path outside the
    // run's scratch tree.
    const scratchDir = await this.scratchService.ensureDir(userId, runId);

    try {
      const parseError = await this.runParse(config, runId, stageIdByKind.get('parse')!, {
        userId,
        label,
        scratchDir,
        recordsConnectionHealth: options.recordsConnectionHealth,
        populate: options.populate,
      });

      if (parseError === 'fatal') {
        return;
      }

      await this.runStage(this.mediaStage, { userId, runId, stageId: stageIdByKind.get('media')!, scratchDir });
      await this.runStage(this.pushStage, { userId, runId, stageId: stageIdByKind.get('push')!, scratchDir });

      // Only now: the rows are in `ci.*`.
      if (options.advanceCursor) {
        await this.advanceCursor(runId, config.id);
      }

      await this.importRunService.finishRun(runId);

      if (options.recordsConnectionHealth) {
        await this.configService.recordConnectionResult(
          config.id,
          parseError == null ? 'connected' : 'error',
          parseError,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (options.recordsConnectionHealth) {
        await this.configService.recordConnectionResult(config.id, 'error', message);
      }

      this.logger.error(`${label} failed`, { error: message, runId });
    } finally {
      await this.reclaimScratch(userId, runId);
    }
  }

  /**
   * Fetch and stage, and decide what a failure part-way through means.
   *
   * Returns `null` on success, `'fatal'` when the stage failed having staged
   * nothing, or the error message when it staged something first.
   *
   * That split is the whole point. `apiImport` used to log a failed page fetch
   * and `break`, so it RESOLVED normally: the run completed both stages,
   * `finishRun` wrote `completed`, and `recordConnectionResult(...,
   * 'connected', null)` then CLEARED `last_error`. On the live appliance that
   * produced 167 runs marked `completed` and a config row reading `connected` /
   * no error — including a run where the server answered 401.
   *
   *  - Nothing staged means nothing worked: an auth rejection, an unreachable
   *    Mac. The run FAILS and the connection says why. This is what tells
   *    "fetched nothing because there is nothing" apart from "fetched nothing
   *    because the server rejected us" — the first path completes with zero
   *    rows and no error, this one does not.
   *  - Something staged means a pass that died part-way — the Mac slept at page
   *    300 of 434. Those rows are real and are pushed; the stage is `partial`
   *    (so the run rolls up `partial`, not `completed`) and the connection
   *    records the error. The cursor then advances only over what actually
   *    landed, which is safe because the fetch loop ENFORCES ascending order
   *    rather than assuming it: `apiImport` throws the moment the server hands
   *    back a message older than the previous one, so whatever is staged is
   *    always a contiguous prefix. Without that check this branch would be a
   *    fresh instance of the C1 hazard — a ratcheting cursor moved past rows
   *    that were never fetched. The next pass resumes where this one stopped.
   */
  private async runParse(
    config: BlueBubblesConfigEntity,
    runId: string,
    stageId: string,
    context: {
      userId: string;
      label: string;
      scratchDir: string;
      recordsConnectionHealth: boolean;
      populate: (writer: StagedWriter, scratchDir: string) => Promise<void>;
    },
  ): Promise<string | 'fatal' | null> {
    await this.importRunService.beginStage(stageId);

    const writer = new StagedWriter(this.dataSource.manager, {
      userId: context.userId,
      runId,
      dataSource: 'bluebubbles',
    });
    // Sampled WHILE the pass runs, not read off its return value: see
    // PROGRESS_SAMPLE_MS. `total` stays null because a BlueBubbles pass
    // discovers its size as it pages, exactly like a parse over a tree.
    const ticker = setInterval(() => {
      const live = writer.totals;

      void this.importRunService
        .recordProgress(stageId, { processed: live.items + live.entities, total: null, phase: 'fetching' })
        .catch(() => undefined);
    }, PROGRESS_SAMPLE_MS);

    let failure: Error | null = null;

    try {
      await context.populate(writer, context.scratchDir);
    } catch (err) {
      failure = err instanceof Error ? err : new Error(String(err));
    } finally {
      clearInterval(ticker);
    }

    try {
      // Always, even after a failure: rows the pass already pushed still have
      // to land, and `writer.totals` is only honest once they have.
      await writer.settled();
    } catch (err) {
      failure ??= err instanceof Error ? err : new Error(String(err));
    }

    const staged = writer.totals;
    const processed = staged.items + staged.entities;

    if (failure != null && processed === 0) {
      await this.importRunService.failStage(stageId, failure.message);

      if (context.recordsConnectionHealth) {
        await this.configService.recordConnectionResult(config.id, 'error', failure.message);
      }

      this.logger.error(`${context.label}: fetch failed before anything was staged`, {
        error: failure.message,
        runId,
      });

      return 'fatal';
    }

    await this.importRunService.completeStage(stageId, {
      processed,
      total: processed,
      partial: failure != null,
      detail: {
        items: staged.items,
        entities: staged.entities,
        drops: staged.drops,
        ...(failure != null && { error: failure.message }),
      },
    });

    if (failure != null) {
      this.logger.warn(`${context.label}: fetch stopped part-way; pushing what was staged`, {
        error: failure.message,
        runId,
        staged: processed,
      });
    }

    return failure?.message ?? null;
  }

  /**
   * Run one in-process stage against this run, with the same claim/progress
   * bookkeeping the pg-boss listener gives an archive import's stages.
   *
   * A throw propagates: `failStage` fails the run, and the stages behind it
   * stay `queued`, which is what makes the Import Runs UI's "retry stage"
   * action a real recovery path — `MediaStage` and `PushStage` need nothing
   * from this service, so the generic listener can re-run either of them.
   */
  private async runStage(
    stage: MediaStage | PushStage,
    context: { userId: string; runId: string; stageId: string; scratchDir: string },
  ): Promise<void> {
    await this.importRunService.beginStage(context.stageId);

    const runContext: StageRunContext = {
      userId: context.userId,
      runId: context.runId,
      stageId: context.stageId,
      scratchDir: context.scratchDir,
      progress: (update) => this.importRunService.recordProgress(context.stageId, update),
    };

    try {
      await this.importRunService.completeStage(context.stageId, await stage.run(runContext));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      await this.importRunService.failStage(context.stageId, message);

      throw err;
    }
  }

  /**
   * Free the run's scratch tree — but only once nothing still needs it.
   *
   * `hasUnstoredMedia` is the same invariant the archive path reclaims under:
   * a staged row whose bytes exist ONLY here (a media stage that failed, or
   * never ran) must keep them, or a retry has nothing to upload. Best-effort;
   * the retention sweep is the backstop.
   */
  private async reclaimScratch(userId: string, runId: string): Promise<void> {
    try {
      if (await this.importRunService.hasUnstoredMedia(runId)) {
        return;
      }

      await this.scratchService.reclaim(userId, runId);
    } catch (err) {
      this.logger.debug('Could not reclaim the BlueBubbles run scratch directory', {
        runId,
        error: (err as Error).message,
      });
    }
  }

  /** Forward a datasource/pipeline log call to this service's own logger, level for level. */
  private forwardLog(
    level: 'debug' | 'info' | 'warn' | 'error',
    msg: string,
    meta?: Record<string, unknown>,
  ): void {
    switch (level) {
      case 'debug':
        this.logger.debug(msg, meta);
        break;
      case 'info':
        this.logger.log(msg, meta);
        break;
      case 'warn':
        this.logger.warn(msg, meta);
        break;
      case 'error':
        this.logger.error(msg, meta);
        break;
    }
  }

  /**
   * The user newly-pulled BlueBubbles messages are attributed to.
   *
   * BlueBubbles config is appliance-wide (no `user_id` column — see
   * `BlueBubblesConfigEntity`), so unlike a per-user connection sync there is
   * no owning user recorded anywhere to read. The first onboarded account is
   * the right answer on the personal, single-tenant appliance this feature is
   * built for; a multi-user appliance wanting per-user attribution is a
   * follow-up, not a gap this sync silently mishandles (it simply no-ops
   * without a user to attribute to).
   *
   * "First" means oldest, and `findAllOnboarded` now orders by `created_at` to
   * make that true. Without an ORDER BY the row order is whatever Postgres
   * happens to return, so on a two-account appliance consecutive syncs could
   * file the same corpus under different users.
   */
  private async resolveOwnerUserId(): Promise<string | null> {
    const [owner] = await this.userService.findAllOnboarded();

    return owner?.id ?? null;
  }

  private settingsFor(config: BlueBubblesConfigEntity): { getSetting(key: string): string | undefined } {
    const values: Record<string, string | undefined> = {
      host: config.host,
      port: String(config.port),
      useHttps: String(config.useHttps),
      password: config.password,
      hasPrivateApi: String(config.hasPrivateApi),
      lastSyncCursor: config.lastSyncCursor ? String(config.lastSyncCursor.getTime()) : undefined,
    };

    return { getSetting: (key: string) => values[key] };
  }

  /** Bump `last_sync_cursor` to the newest message this pass actually staged. */
  private async advanceCursor(runId: string, configId: string): Promise<void> {
    const rows = await this.dataSource.query<Array<{ max: Date | null }>>(
      `SELECT MAX(occurred_at) AS max
         FROM ci_import.staged_items
        WHERE run_id = $1::uuid AND data_source = 'bluebubbles'`,
      [runId],
    );

    const max = rows[0]?.max;

    if (max) {
      await this.configService.recordSyncCursor(configId, max);
    }
  }
}

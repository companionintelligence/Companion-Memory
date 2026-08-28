import os from 'node:os';

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import {
  BlueBubblesApiClient,
  BlueBubblesAPIImporter,
  downloadAttachments,
  IMPORT_STAGE_WEIGHTS,
  ImportRunService,
  mapBlueBubblesMessageToGraph,
  PushStage,
  StagedWriter,
  type BlueBubblesMessage,
  type ImportStageKindName,
} from '@ci/domains/import';
import { UserService } from '@ci/domains/user';

import { BlueBubblesConfigEntity } from '../entities/BlueBubblesConfigEntity';

import { BlueBubblesConfigService } from './BlueBubblesConfigService';

/** The stage kinds a BlueBubbles sync run declares — see the class doc below. */
const BLUEBUBBLES_STAGES: readonly ImportStageKindName[] = ['parse', 'push'];

/**
 * Drives BlueBubbles ingestion into `ci.*`, in-process, for both of its
 * callers: {@link runSync} (a bulk backfill/poll pass, from
 * `BlueBubblesSyncCron` or the settings page's "Sync now") and
 * {@link ingestWebhookMessage} (one live message, from
 * `BlueBubblesWebhookController`). Both stage their graphs the same way
 * `ParseStage` does and push through the same in-process `PushStage.run` —
 * see the shared {@link runIngest} below.
 *
 * Deliberately does NOT go through the full pg-boss claim/heartbeat stage
 * graph archive imports use (`ImportRunService.startRun` + the pg-boss-driven
 * `ImportStageListener`) — that machinery exists for a 40GB archive whose
 * `unpack`/`parse` can run for hours and must survive a process restart. A
 * BlueBubbles ingest is a handful of REST calls (or, for a webhook delivery,
 * zero — the message is already in hand); running it synchronously,
 * in-process, from the caller is simpler and sufficient.
 *
 * A minimal `ci_import.import_runs` row (+ two stage rows) is still written
 * per call, for audit visibility in the existing Import Runs UI — and so this
 * reuses `ImportRunService`'s existing stage-transition bookkeeping
 * (`beginStage`/`recordProgress`/`completeStage`/`failStage`/`finishRun`)
 * rather than reimplementing the run/percent rollup.
 */
@Injectable()
export class BlueBubblesSyncService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly configService: BlueBubblesConfigService,
    private readonly importRunService: ImportRunService,
    private readonly pushStage: PushStage,
    private readonly userService: UserService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(BlueBubblesSyncService.name);
  }

  /** Run one sync pass. No-ops quietly when BlueBubbles isn't configured/enabled. */
  async runSync(): Promise<void> {
    const config = await this.configService.getOrCreate();

    if (!config.enabled || !config.host || !config.port) {
      return;
    }

    await this.runIngest(config, 'BlueBubbles sync', (writer) =>
      new BlueBubblesAPIImporter().apiImport(this.settingsFor(config), {
        pipeline: writer,
        mediaStoreDir: os.tmpdir(),
        log: (level, msg, meta) => this.forwardLog(level, msg, meta),
      }),
    );
  }

  /**
   * Ingest one message the webhook just delivered — the live-ingestion
   * counterpart to {@link runSync}'s bulk backfill/poll. Shares the exact
   * mapping ({@link mapBlueBubblesMessageToGraph}) the bulk importer uses, and
   * the same run/stage/push machinery via {@link runIngest}, so a message
   * that arrives via webhook is indistinguishable downstream from one a sync
   * pass would have found — right down to landing in its own tiny audit run.
   *
   * The chat this message belongs to is read off the webhook payload's own
   * embedded `chats[0]` (BlueBubbles includes it on `new-message` /
   * `updated-message` events) rather than fetched fresh — a full
   * `queryChats()` directory lookup per live message would be one more round
   * trip for every text the appliance receives, for a participant list the
   * payload already carries.
   */
  async ingestWebhookMessage(message: BlueBubblesMessage): Promise<void> {
    const config = await this.configService.getOrCreate();

    if (!config.enabled || !config.host || !config.port) {
      return;
    }

    const client = new BlueBubblesApiClient({
      host: config.host,
      port: config.port,
      useHttps: config.useHttps,
      password: config.password,
    });

    await this.runIngest(config, 'BlueBubbles webhook', async (writer) => {
      const graph = mapBlueBubblesMessageToGraph(message, message.chats?.[0]);

      await downloadAttachments(graph, message, client, os.tmpdir(), (level, msg, meta) =>
        this.forwardLog(level, msg, meta),
      );
      writer.push(graph);
    });
  }

  /**
   * Shared run/stage lifecycle for one ingest attempt — a bulk {@link runSync}
   * pass or one {@link ingestWebhookMessage} delivery. `populate` is the only
   * thing that differs between the two: everything else (the audit run/stage
   * rows, cursor advancement, connection-result recording) is identical.
   */
  private async runIngest(
    config: BlueBubblesConfigEntity,
    label: string,
    populate: (writer: StagedWriter) => Promise<void>,
  ): Promise<void> {
    const userId = await this.resolveOwnerUserId();

    if (!userId) {
      this.logger.warn('BlueBubbles ingest skipped: no onboarded user to attribute messages to');

      return;
    }

    const runId = await this.createRun(userId, label);
    const [parseStageId, pushStageId] = await Promise.all([
      this.createStage(runId, 0, 'parse'),
      this.createStage(runId, 1, 'push'),
    ]);

    let staged: { items: number; entities: number };

    try {
      await this.importRunService.beginStage(parseStageId);

      const writer = new StagedWriter(this.dataSource.manager, { userId, runId, dataSource: 'bluebubbles' });

      await populate(writer);
      await writer.settled();

      staged = { items: writer.totals.items, entities: writer.totals.entities };

      await this.importRunService.completeStage(parseStageId, {
        processed: staged.items + staged.entities,
        total: staged.items + staged.entities,
        detail: { items: staged.items, entities: staged.entities, drops: writer.totals.drops },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // failStage also marks the run itself failed, so there is nothing more
      // to close out here — the push stage never starts.
      await this.importRunService.failStage(parseStageId, message);
      await this.configService.recordConnectionResult(config.id, 'error', message);
      this.logger.error(`${label}: parse phase failed`, {
        error: message,
        runId,
      });

      return;
    }

    await this.advanceCursor(runId, config.id);

    try {
      await this.importRunService.beginStage(pushStageId);

      const outcome = await this.pushStage.run({
        userId,
        runId,
        stageId: pushStageId,
        scratchDir: os.tmpdir(),
        progress: (update) => this.importRunService.recordProgress(pushStageId, update),
      });

      await this.importRunService.completeStage(pushStageId, outcome);
      await this.importRunService.finishRun(runId);
      await this.configService.recordConnectionResult(config.id, 'connected', null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      await this.importRunService.failStage(pushStageId, message);
      await this.configService.recordConnectionResult(config.id, 'error', message);
      this.logger.error(`${label}: push phase failed`, {
        error: message,
        runId,
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

  private async createRun(userId: string, label: string): Promise<string> {
    const rows = await this.dataSource.query<Array<{ id: string }>>(
      `INSERT INTO ci_import.import_runs (user_id, label, source, status, requested_stages, declared_sources)
            VALUES ($1::uuid, $2, 'connections', 'queued', $3::text[], $4::text[])
         RETURNING id`,
      [userId, label, [...BLUEBUBBLES_STAGES], ['bluebubbles']],
    );

    return rows[0].id;
  }

  private async createStage(runId: string, seq: number, kind: ImportStageKindName): Promise<string> {
    const rows = await this.dataSource.query<Array<{ id: string }>>(
      `INSERT INTO ci_import.import_stages (run_id, seq, kind, status, weight)
            VALUES ($1::uuid, $2, $3, 'queued', $4)
         RETURNING id`,
      [runId, seq, kind, IMPORT_STAGE_WEIGHTS[kind]],
    );

    return rows[0].id;
  }
}

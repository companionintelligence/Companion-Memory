import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import { EventService } from '@ci/domains/events';
import { QuestionService } from '@ci/domains/intelligence';

import { SmartRotationWorkEvent } from '../events';
import {
  SMART_ROTATION_BACKLOG_THRESHOLD,
  SMART_ROTATION_QUEUE,
  SMART_ROTATION_USERS_PER_TICK,
  type SmartRotationWorkType,
} from '../types';

/**
 * Meta-controller for background intelligence. Each work type keeps its own
 * staggered cron; `smart.rotation` is the umbrella flag. Cadence is enforced
 * by schedule + PGBoss singleton keys, not a separate state table.
 */
@Injectable()
export class SmartRotationService {
  private readonly userCursors = new Map<SmartRotationWorkType, number>();

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly questionService: QuestionService,
    private readonly eventService: EventService,
    private readonly featureService: FeatureService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(SmartRotationService.name);
  }

  async isEnabled(): Promise<boolean> {
    return this.featureService.isFeatureEnabled('smart.rotation');
  }

  /** Round-robin a batch of users and enqueue work for the given type. */
  async runScheduledWork(
    workType: SmartRotationWorkType,
    usersPerTick: number = SMART_ROTATION_USERS_PER_TICK,
  ): Promise<number> {
    if (!(await this.isEnabled())) {
      return 0;
    }

    if (this.shouldSkipForBacklog(workType) && (await this.isBacklogHigh())) {
      this.logger.warn('Skipping smart rotation work — queue backlog too high', { workType });

      return 0;
    }

    const userIds = await this.questionService.listFeedQueueUserIds();

    if (userIds.length === 0) {
      return 0;
    }

    const batch = this.nextUserBatch(workType, userIds, usersPerTick);
    let enqueued = 0;

    for (const userId of batch) {
      const didEnqueue = await this.enqueueWork(userId, workType);

      if (didEnqueue) {
        enqueued += 1;
      }
    }

    if (enqueued > 0) {
      this.logger.log('Smart rotation scheduled work enqueued', { workType, enqueued, users: batch.length });
    }

    return enqueued;
  }

  async enqueueWork(userId: string, workType: SmartRotationWorkType): Promise<boolean> {
    const jobIds = await this.eventService.send(
      SmartRotationWorkEvent,
      { userId, workType },
      {
        queue: SMART_ROTATION_QUEUE,
        singletonKey: `smart-rotation:${userId}:${workType}`,
        priority: this.workTypePriority(workType),
      },
    );

    return jobIds.length > 0;
  }

  /** Low-priority work types are skipped when the default queue is backlogged. */
  private shouldSkipForBacklog(workType: SmartRotationWorkType): boolean {
    return workType === 'answer_infer' || workType === 'question_feed';
  }

  /** Graph growth and schedule work outrank inference when queues are busy. */
  private workTypePriority(workType: SmartRotationWorkType): number {
    switch (workType) {
      case 'graph_link':
      case 'graph_enrich':
      case 'context_prompt':
      case 'hydrate_answers':
      case 'hydrate_inventory':
        return 5;
      case 'schedule_sync':
      case 'summaries':
      case 'insights':
        return 2;
      case 'answer_infer':
      case 'question_feed':
        return -2;
      default:
        return 0;
    }
  }

  private nextUserBatch(workType: SmartRotationWorkType, userIds: string[], size: number): string[] {
    if (userIds.length === 0) {
      return [];
    }

    const cursor = this.userCursors.get(workType) ?? 0;
    const batch: string[] = [];
    const count = Math.min(size, userIds.length);

    for (let i = 0; i < count; i += 1) {
      batch.push(userIds[(cursor + i) % userIds.length]);
    }

    this.userCursors.set(workType, (cursor + count) % userIds.length);

    return batch;
  }

  private async isBacklogHigh(): Promise<boolean> {
    type Row = { count: string };
    const rows = (await this.dataSource.query(
      `
      SELECT COUNT(*)::text AS count
      FROM pgboss.job
      WHERE state = 'created'
        AND name IN ('default', $1);
      `,
      [SMART_ROTATION_QUEUE],
    )) as Row[];

    const count = Number.parseInt(rows[0]?.count ?? '0', 10);

    return count >= SMART_ROTATION_BACKLOG_THRESHOLD;
  }
}

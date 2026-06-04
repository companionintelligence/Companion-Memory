/**
 * MemoryCompactionCron
 *
 * Runs every 5 minutes (feature-flagged: 'agent.memory.compaction').
 * Fetches all unprocessed agent memory fragments across all users, groups
 * them by user, and delegates each user's batch to MemoryCompactionService.
 *
 * Design constraints:
 * - At most 100 fragments per cron tick to bound latency.
 * - Per-user failures are caught and logged so one user can't block others.
 * - Fragments at least 2 minutes old are eligible (lets write bursts settle).
 */

import { Injectable } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';

import { SYSTEM_USER, type ServiceContext, toServiceContext } from '@ci/common/context';
import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';

import type { AgentMemory } from '../entities/AgentMemoryEntity';
import { AgentMemoryService } from '../services/AgentMemoryService';
import { MemoryCompactionService } from '../services/MemoryCompactionService';

const FRAGMENTS_PER_TICK = 100;

@Injectable()
export class MemoryCompactionCron {
  constructor(
    private readonly compactionService: MemoryCompactionService,
    private readonly agentMemoryService: AgentMemoryService,
    private readonly featureService: FeatureService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(MemoryCompactionCron.name);
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async cronCompactMemories(): Promise<void> {
    const featureEnabled = await this.featureService.isFeatureEnabled('agent.memory.compaction');

    if (!featureEnabled) {
      return;
    }

    this.logger.log('Memory compaction cron starting');

    const systemContext = { userId: SYSTEM_USER } as ServiceContext;

    const fragments = await this.agentMemoryService.findUnprocessed(systemContext, {
      limit: FRAGMENTS_PER_TICK,
      minAgeMinutes: 2,
    });

    if (fragments.length === 0) {
      this.logger.debug('No unprocessed agent memory fragments found');

      return;
    }

    // Group by userId so each user gets a coherent extraction batch.
    const byUser = new Map<string, AgentMemory[]>();

    for (const fragment of fragments) {
      const bucket = byUser.get(fragment.userId) ?? [];
      bucket.push(fragment);
      byUser.set(fragment.userId, bucket);
    }

    this.logger.log('Processing agent memory fragments', {
      totalFragments: fragments.length,
      userCount: byUser.size,
    });

    for (const [userId, userFragments] of byUser) {
      try {
        const userServiceContext = toServiceContext({ userId });

        await this.compactionService.compactForUser(userServiceContext, userFragments);
      } catch (err) {
        this.logger.error(
          `Memory compaction failed for user ${userId}`,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }

    this.logger.log('Memory compaction cron complete');
  }
}

/**
 * TurnFragmentCron
 *
 * The missing producer for `ci.agent_memories` (feature-flagged:
 * 'agent.memory.turnFragments', default OFF).
 *
 * `AgentMemoryService.create` had exactly one caller — `MemoryController.write`
 * (`POST /memory/write`) — behind `ApiKeyGuard` rather than
 * `JwtOrApiKeyAuthGuard`, so the appliance's own web chat could not reach it
 * even with a valid session. On a stock appliance the table was therefore empty
 * by construction, and three subsystems downstream of it ran over nothing:
 * `MemoryCompactionCron`, the `agent-memory.created` search-index listener, and
 * `RecallService`'s raw-message channel.
 *
 * This cron closes that loop from the appliance's own chat: every settled,
 * completed turn `ChatTurnService.persistTurn` wrote becomes one fragment
 * stamped `source: 'chat-turn'`, `session_id = threadId`.
 *
 * Design constraints, each load-bearing:
 * - NOT inline in `persistTurn`. That `finally` block is already the
 *   crash-lossy part of the chat path; a fragment write there would be a
 *   fourth thing to lose, and would put a table write between the model
 *   finishing and the UI unblocking.
 * - NOT a `memory.remember` tool. `domains/tools/tools/WriteKnowledgeTool.ts`
 *   already owns that intent name and is already offered to chat; a second
 *   "remember" would hand a small local model two write paths with no
 *   principled way to choose between them, on a codebase that already carries
 *   a name-mashing normalizer because models mangle this exact tool.
 * - No watermark table. Fragment ids are deterministic (see `turnFragmentId`),
 *   so a crash replays into the same row instead of duplicating it.
 * - Per-user fan-out over pg-boss, modelled on `PythonFunctionCrons.fanOut`:
 *   one job per user keyed `fn:agent-turn-fragments:<user>:<windowKey>`, so a
 *   user whose scan throws retries alone rather than ending the tick for
 *   everyone behind them.
 */

import { Injectable } from '@nestjs/common';

import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';
import { EventService } from '@ci/domains/events';

import { AGENT_MEMORY_QUEUE } from '../constants';
import { AgentTurnFragmentsEvent } from '../events';
import { TURN_FRAGMENT_SETTINGS, TurnFragmentService } from '../services/TurnFragmentService';

/**
 * Second 3, off the five-second grid every other frequent cron already holds
 * (see `common/schedule/__tests__/cronSecondOffsets.test.ts`): `@nestjs/schedule`
 * timers are in-process, so a fan-out landing on second 0 shares one event loop
 * tick and one 25-connection pool with every aggregate that never picked a
 * second.
 *
 * The cadence is `config.agentMemory.turnFragments.intervalMinutes`, bounded
 * 5..15 by the schema, rather than a constant — the interval is an appliance
 * tuning decision (how stale a fragment may be before the next question in the
 * same session misses it), not a source-code one.
 */
export const TURN_FRAGMENT_CRON = `3 */${TURN_FRAGMENT_SETTINGS.intervalMinutes} * * * *`;

/**
 * Bucket the window into interval-sized slots so the singleton key refuses a
 * second copy of the same user+window while the first is still queued, and so
 * a tick that overruns cannot stack a duplicate behind itself.
 */
export function turnFragmentWindowKey(until: Date, intervalMinutes: number): string {
  return String(Math.floor(until.getTime() / (intervalMinutes * 60_000)));
}

@Injectable()
export class TurnFragmentCron {
  constructor(
    private readonly turnFragmentService: TurnFragmentService,
    private readonly eventService: EventService,
    private readonly featureService: FeatureService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(TurnFragmentCron.name);
  }

  @Cron(TURN_FRAGMENT_CRON, { name: 'TurnFragmentCron.cronWriteTurnFragments' })
  async cronWriteTurnFragments(): Promise<void> {
    const featureEnabled = await this.featureService.isFeatureEnabled('agent.memory.turnFragments');

    if (!featureEnabled) {
      return;
    }

    const window = this.turnFragmentService.resolveWindow();
    const userIds = await this.turnFragmentService.listUsersWithCompletedTurns(window);

    if (userIds.length === 0) {
      this.logger.debug('No completed chat turns in window', {
        since: window.since.toISOString(),
        until: window.until.toISOString(),
      });

      return;
    }

    const windowKey = turnFragmentWindowKey(window.until, TURN_FRAGMENT_SETTINGS.intervalMinutes);
    let enqueued = 0;

    for (const userId of userIds) {
      try {
        await this.eventService.send(
          AgentTurnFragmentsEvent,
          {
            userId,
            since: window.since.toISOString(),
            until: window.until.toISOString(),
          },
          {
            queue: AGENT_MEMORY_QUEUE,
            // AGENT_MEMORY_QUEUE_OPTIONS declares `policy: 'short'`, which is
            // queue-wide: a keyless send here would collapse with every other
            // keyless send under COALESCE(singleton_key,'').
            singletonKey: `fn:agent-turn-fragments:${userId}:${windowKey}`,
          },
        );

        enqueued += 1;
      } catch (err) {
        this.logger.error(
          `Failed to enqueue turn fragments for user ${userId}`,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }

    this.logger.log('Chat-turn fragment fan-out enqueued', {
      users: userIds.length,
      enqueued,
      windowKey,
    });
  }
}

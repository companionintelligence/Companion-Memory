import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';

import { ActivityRollupCron } from '@ci/domains/activity/cron/ActivityRollupCron';
import { AgentDispatchStaleCron } from '@ci/domains/agent/cron/AgentDispatchStaleCron';
import { MemoryCompactionCron } from '@ci/domains/agent/cron/MemoryCompactionCron';
import { TurnFragmentCron } from '@ci/domains/agent/cron/TurnFragmentCron';
import { SyncOrchestrator } from '@ci/domains/etl/listeners/SyncOrchestrator';
import { JobMetricsCollector } from '@ci/domains/events/services/JobMetricsCollector';
import { FeedQueueCron } from '@ci/domains/intelligence/cron/FeedQueueCron';
import { InitialActionsCron } from '@ci/domains/onboarding/cron/InitialActionsCron';
import { AnswerInferenceCron } from '@ci/domains/smart-rotation/cron/AnswerInferenceCron';

/**
 * Second-of-minute placement, which is a scheduling decision and not a style
 * one. `@nestjs/schedule` timers are in-process, so everything left on second 0
 * fires into the same event loop and the same 25-connection pool at once. The
 * subjects below are the expensive members of that pile-up — eight full-table
 * aggregates, a 100-fragment LLM batch, a per-user onboarding fan-out, four
 * unbounded connection-sync scans and two `pgboss.job` scans — so each takes a
 * second nobody else holds.
 *
 * The assertions read the metadata Nest's scheduler is actually handed, not the
 * source constants, so a `@Cron` rewritten back to `CronExpression.EVERY_*`
 * fails here too.
 */

/**
 * Seconds claimed by crons that were already offset before this invariant
 * existed, or that this process does not register (`role: 'worker'`) and so
 * cannot be read out of the scheduler metadata here.
 *
 * The five-second grid is now full — 5 through 55 all have a holder, between
 * this table and the subjects below — so the next cron to want a second takes
 * an off-grid one. 8, 18, 28, 38 and 48 are claimed below, as are 13
 * (`RecallProbeCron`) and 23 (`EntityTypeAuditCron`); 3 is claimed below by
 * `TurnFragmentCron`, 33 is claimed by `AgentMemoryRetentionCron`
 * (02:20:33, `role: 'worker'`), 43 is claimed by `AgentDispatchStaleCron`,
 * and 53 by `DeterministicPersonMergeCron.drain` (hourly at xx:17:53,
 * `role: 'worker'`), leaving 58 as the next tidy one free.
 *
 * Not listed, deliberately: `DerivationCron.deriveNightly` (`25 40 4 * * *`)
 * and `OrphanCleanupCron.sweepOnSchedule` (`35 50 2 * * *`) reuse seconds 25
 * and 35, but at a minute and hour no other holder of those seconds fires on,
 * so they never actually land together. This table is a registry of the
 * frequent schedules, where the second alone decides.
 */
const PREEXISTING_OFFSETS: Record<string, string> = {
  '10': 'PipelineControlService.tickOnSchedule',
  '20': 'PipelineTickCron.runOnSchedule',
  '30': 'ImportStageListener.sweepOnSchedule',
  '40': 'DeadLetterReaperListener.reapOnSchedule',
  '50': 'RetrievalHealthCron.captureRetrievalHealth, ImportRetentionCron.runOnSchedule',
  '53': 'DeterministicPersonMergeCron.drain',
};

function registeredExpression(method: unknown): string {
  const options = Reflect.getMetadata(SCHEDULE_CRON_OPTIONS, method as object) as
    { cronTime?: string } | undefined;

  expect(options?.cronTime).toEqual(expect.any(String));

  return options?.cronTime as string;
}

function fields(expression: string): string[] {
  const parts = expression.trim().split(/\s+/);

  // Five fields means no seconds field at all, which `cron` reads as second 0 —
  // the pile-up this test exists to prevent.
  expect(parts).toHaveLength(6);

  return parts;
}

/**
 * Every second a schedule occupies, not just its first. A sub-minute cadence
 * carries its own repeat in the seconds field (`8,38` for a 30-second job), and
 * each of those seconds is claimed.
 */
function secondsClaimed(method: unknown): string[] {
  return fields(registeredExpression(method))[0].split(',');
}

const SUBJECTS = [
  {
    name: 'ActivityRollupCron.refreshRollup',
    method: ActivityRollupCron.prototype.refreshRollup,
    cadence: '*/15 * * * *',
  },
  {
    name: 'MemoryCompactionCron.cronCompactMemories',
    method: MemoryCompactionCron.prototype.cronCompactMemories,
    cadence: '*/5 * * * *',
  },
  {
    // Cadence tracks `config.agentMemory.turnFragments.intervalMinutes`, whose
    // shipped default is 10; changing that default changes this literal.
    name: 'TurnFragmentCron.cronWriteTurnFragments',
    method: TurnFragmentCron.prototype.cronWriteTurnFragments,
    cadence: '*/10 * * * *',
  },
  {
    name: 'AgentDispatchStaleCron.failStale',
    method: AgentDispatchStaleCron.prototype.failStale,
    cadence: '* * * * *',
  },
  {
    name: 'InitialActionsCron.initializeEligibleUsers',
    method: InitialActionsCron.prototype.initializeEligibleUsers,
    cadence: '0 * * * *',
  },
  {
    name: 'SyncOrchestrator.orchestrateSyncJobs',
    method: SyncOrchestrator.prototype.orchestrateSyncJobs,
    cadence: '* * * * *',
  },
  {
    name: 'SyncOrchestrator.executeSyncJobs',
    method: SyncOrchestrator.prototype.executeSyncJobs,
    cadence: '* * * * *',
  },
  {
    name: 'SyncOrchestrator.executeTransformJobs',
    method: SyncOrchestrator.prototype.executeTransformJobs,
    cadence: '* * * * *',
  },
  {
    name: 'JobMetricsCollector.sampleOnSchedule',
    method: JobMetricsCollector.prototype.sampleOnSchedule,
    cadence: '*/5 * * * *',
  },
  {
    name: 'JobMetricsCollector.purgeOnSchedule',
    method: JobMetricsCollector.prototype.purgeOnSchedule,
    cadence: '25 4 * * *',
  },
  {
    name: 'AnswerInferenceCron.cronInferAnswers',
    method: AnswerInferenceCron.prototype.cronInferAnswers,
    cadence: '* * * * *',
  },
  {
    name: 'FeedQueueCron.topUpFeedQueue',
    method: FeedQueueCron.prototype.topUpFeedQueue,
    cadence: '*/20 * * * *',
  },
] as const;

describe('cron second offsets', () => {
  it.each(SUBJECTS)('$name fires off second 0', ({ method }) => {
    const seconds = secondsClaimed(method);

    expect(seconds).not.toHaveLength(0);

    for (const second of seconds) {
      expect(second).toMatch(/^\d+$/);
      expect(second).not.toBe('0');
    }
  });

  it.each(SUBJECTS)('$name keeps its cadence', ({ method, cadence }) => {
    expect(fields(registeredExpression(method)).slice(1).join(' ')).toBe(cadence);
  });

  // The one subject whose cadence lives in the seconds field rather than the
  // minute one: `CronExpression.EVERY_30_SECONDS` puts `*/30` on the seconds
  // field — seconds 0 and 30. Offsetting it means moving both halves of that
  // pair, and only their spacing proves the half-minute cadence survived the
  // rewrite.
  it('keeps SyncOrchestrator.executeSyncJobs on a 30-second cadence', () => {
    const ticks = secondsClaimed(SyncOrchestrator.prototype.executeSyncJobs).map(Number);

    expect(ticks).toHaveLength(2);
    expect(ticks[1] - ticks[0]).toBe(30);
  });

  it('gives each of them a second no other cron holds', () => {
    const claimed = new Map<string, string>(Object.entries(PREEXISTING_OFFSETS));

    for (const { name, method } of SUBJECTS) {
      for (const second of secondsClaimed(method)) {
        const holder = claimed.get(second);

        expect(holder == null ? null : `${name} collides with ${holder} on second ${second}`).toBeNull();

        claimed.set(second, name);
      }
    }
  });
});

import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';

import type { LoggerService } from '@ci/common/logging';

import {
  type AutoMergeOptions,
  type AutoMergeResult,
  DETERMINISTIC_MERGE_CRON,
  type MergeCandidateService,
} from '../../services/MergeCandidateService';
import {
  DETERMINISTIC_PERSON_MERGE_CRON,
  DeterministicPersonMergeCron,
  PER_USER_BUDGET_MS,
} from '../DeterministicPersonMergeCron';

const noopLogger = {
  setContext: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  error: () => undefined,
} as unknown as LoggerService;

function registeredOptions(): { cronTime?: string; name?: string } {
  return (Reflect.getMetadata(SCHEDULE_CRON_OPTIONS, DeterministicPersonMergeCron.prototype.drain) ?? {}) as {
    cronTime?: string;
    name?: string;
  };
}

describe('DeterministicPersonMergeCron schedule', () => {
  it('registers under the name the People page reads as its kill switch', () => {
    // `PersonResolver.mergeCandidates` asks JobControlStore about this exact
    // string; a registry name that drifted from it would leave the on-read
    // fold running after the operator disabled the job.
    expect(registeredOptions().name).toBe(DETERMINISTIC_MERGE_CRON);
    expect(DETERMINISTIC_MERGE_CRON).toBe('DeterministicPersonMergeCron.drain');
  });

  it('fires hourly at minute 17, on second 53', () => {
    const fields = (registeredOptions().cronTime ?? '').trim().split(/\s+/);

    expect(fields).toHaveLength(6);
    expect(fields[0]).toBe('53');
    expect(fields.slice(1).join(' ')).toBe('17 * * * *');
    expect(DETERMINISTIC_PERSON_MERGE_CRON).toBe(fields.join(' '));
  });
});

describe('DeterministicPersonMergeCron.sweep', () => {
  const users = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];

  const dataSource = {
    query: async () => users.map((id) => ({ id })),
  } as never;

  const result = (merged: number): AutoMergeResult => ({
    merged,
    skipped: 1,
    demoted: 2,
    considered: merged + 3,
  });

  it('drains every onboarded user with the per-user budget, and totals the counts', async () => {
    const seen: Array<{ userId: string; options: AutoMergeOptions }> = [];
    const service = {
      autoMergeDeterministicPairs: async (context: { userId: string }, options: AutoMergeOptions) => {
        seen.push({ userId: context.userId, options });

        return result(4);
      },
    } as unknown as MergeCandidateService;

    const totals = await new DeterministicPersonMergeCron(dataSource, service, noopLogger).sweep();

    expect(seen.map((call) => call.userId)).toEqual(users);
    expect(
      seen.every((call) => call.options.budgetMs <= PER_USER_BUDGET_MS && call.options.budgetMs > 0),
    ).toBe(true);
    // The cron always folds every tier: the kill switch stops it before it runs.
    expect(
      seen.every(
        (call) => call.options.includeProfileUrl === undefined && call.options.includePhone === undefined,
      ),
    ).toBe(true);
    expect(totals).toEqual({ merged: 8, skipped: 2, demoted: 4, considered: 14 });
  });

  it('does not let one account stall the rest', async () => {
    const service = {
      autoMergeDeterministicPairs: async (context: { userId: string }) => {
        if (context.userId === users[0]) {
          throw new Error('boom');
        }

        return result(3);
      },
    } as unknown as MergeCandidateService;

    const totals = await new DeterministicPersonMergeCron(dataSource, service, noopLogger).sweep();

    expect(totals.merged).toBe(3);
  });

  it('stops starting users once the tick budget is spent', async () => {
    const seen: string[] = [];
    const service = {
      autoMergeDeterministicPairs: async (context: { userId: string }) => {
        seen.push(context.userId);

        return result(1);
      },
    } as unknown as MergeCandidateService;

    await new DeterministicPersonMergeCron(dataSource, service, noopLogger).sweep({ tickMs: 0 });

    expect(seen).toEqual([]);
  });

  it('never hands a user more than the time left in the tick', async () => {
    const budgets: number[] = [];
    const service = {
      autoMergeDeterministicPairs: async (_context: unknown, options: AutoMergeOptions) => {
        budgets.push(options.budgetMs);

        return result(0);
      },
    } as unknown as MergeCandidateService;

    await new DeterministicPersonMergeCron(dataSource, service, noopLogger).sweep({
      perUserMs: 60 * 60_000,
      tickMs: 1_000,
    });

    expect(budgets.every((budget) => budget <= 1_000)).toBe(true);
  });
});

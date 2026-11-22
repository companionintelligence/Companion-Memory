import { zonedWallTimeToUTC } from '@ci/common/time/zoned';
import type { PlanningTimeService } from '@ci/domains/planning/task.module';

/**
 * A PlanningTimeService for an owner whose saved zone is America/Los_Angeles, with the real
 * wall-clock conversion, so the planning tools' tests see real daylight saving.
 */
export function losAngelesPlanningTime(): PlanningTimeService {
  return {
    toInstant: jest.fn(async (_context: unknown, date: string, time: string) =>
      zonedWallTimeToUTC(date, time, 'America/Los_Angeles'),
    ),
  } as unknown as PlanningTimeService;
}

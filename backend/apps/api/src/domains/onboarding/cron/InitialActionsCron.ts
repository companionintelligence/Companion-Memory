/**
 * InitialActionsCron
 *
 * Defers actions-system seed cards until ~24h after FTUE completes so the first
 * sync has time to land real data. Feature-flagged with `actions`.
 */

import { Injectable } from '@nestjs/common';

import { toServiceContext } from '@ci/common/context';
import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';
import { UserService } from '@ci/domains/user';

import { OnboardingService } from '../services/OnboardingService';

/** How long after onboard before we seed starter actions. */
export const INITIAL_ACTIONS_DELAY_MS = 24 * 60 * 60 * 1000;

const USERS_PER_TICK = 25;

// The hourly cadence of `CronExpression.EVERY_HOUR`, moved off HH:00:00 — the
// second every schedule that never picked one already fires at. See
// common/schedule/__tests__/cronSecondOffsets.test.ts for who holds what.
export const INITIAL_ACTIONS_CRON = '35 0 * * * *';

@Injectable()
export class InitialActionsCron {
  constructor(
    private readonly userService: UserService,
    private readonly onboardingService: OnboardingService,
    private readonly featureService: FeatureService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(InitialActionsCron.name);
  }

  @Cron(INITIAL_ACTIONS_CRON, { name: 'InitialActionsCron.initializeEligibleUsers' })
  async initializeEligibleUsers(): Promise<void> {
    if (!(await this.featureService.isFeatureEnabled('actions'))) {
      return;
    }

    const userIds = await this.userService.listUsersReadyForInitialActions(
      INITIAL_ACTIONS_DELAY_MS,
      USERS_PER_TICK,
    );

    if (userIds.length === 0) {
      return;
    }

    this.logger.log('Initializing actions for users past setup delay', {
      userCount: userIds.length,
      delayHours: INITIAL_ACTIONS_DELAY_MS / (60 * 60 * 1000),
    });

    let initialized = 0;

    for (const userId of userIds) {
      try {
        const created = await this.onboardingService.initializeActionsForUser(toServiceContext({ userId }));

        if (created) {
          initialized += 1;
        }
      } catch (error) {
        this.logger.error('Failed to initialize actions for user', {
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.logger.log('Processed deferred actions initialization', {
      usersConsidered: userIds.length,
      usersInitialized: initialized,
    });
  }
}

import { Injectable, OnApplicationBootstrap } from '@nestjs/common';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { serves } from '@ci/common/roles';
import { Cron } from '@ci/common/schedule';
import { type User, UserService } from '@ci/domains/user';

import { HomeConfirmService } from '../home/HomeConfirmService';
import { PlaceTransitionService } from '../places/PlaceTransitionService';
import { DailyMetricsService, DEFAULT_REFRESH_WINDOW_DAYS } from '../services/DailyMetricsService';
import { DerivationScanService } from '../services/DerivationScanService';

/** Hourly at minute 10 — staggered from the activity rollup's :00/:15/:30/:45 ticks. */
const DAILY_METRICS_CRON = '0 10 * * * *';

/** Shorter window for the recurring tick; bootstrap still backfills a full month. */
const CRON_WINDOW_DAYS = 2;

/**
 * Users whose place engine is rebuilt per tick.
 *
 * Every other per-user fan-out on the appliance rotates — 10 in smart rotation,
 * 25 in `InitialActionsCron` — and this one did not, while costing the most per
 * user: `PlaceClusterService.buildClusters` always reads the full 90-day
 * `ci.position` window. A population below this cap still refreshes in full
 * every tick, so the single-owner appliance is unaffected.
 */
const PLACES_USERS_PER_TICK = 25;

@Injectable()
export class DailyMetricsCron implements OnApplicationBootstrap {
  private running = false;

  private runStartedAt = 0;

  private consecutiveSkips = 0;

  /**
   * Round-robin position for {@link refreshPlaces}. In-memory, matching
   * `SmartRotationService`'s cursor: a restart re-refreshes the head of the
   * list, which costs a repeat rather than leaving a user unvisited.
   */
  private placesCursor = 0;

  constructor(
    private readonly dailyMetricsService: DailyMetricsService,
    private readonly placeTransitionService: PlaceTransitionService,
    private readonly userService: UserService,
    private readonly derivationScanService: DerivationScanService,
    private readonly homeConfirmService: HomeConfirmService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(DailyMetricsCron.name);
  }

  /**
   * Kick a 30-day backfill at startup so a fresh install has rows before the
   * first hourly tick. Fire-and-forget; boot must not wait on it.
   */
  onApplicationBootstrap() {
    // Web-role work: the boot backfill duplicated across a split topology is
    // waste, and the in-process `running` guard cannot see the other process.
    if (!serves('web')) {
      return;
    }

    void this.refresh({ windowDays: DEFAULT_REFRESH_WINDOW_DAYS });
  }

  @Cron(DAILY_METRICS_CRON, { name: 'DailyMetricsCron.refreshRecent' })
  async refreshRecent() {
    await this.refresh({ windowDays: CRON_WINDOW_DAYS });
  }

  private async refresh(options: { windowDays: number }) {
    if (this.running) {
      this.consecutiveSkips += 1;
      // A single slow run and a permanently wedged one both used to log this
      // line and nothing else. The elapsed time and the skip count are what
      // tell them apart.
      this.logger.warn('Skipping daily metrics refresh; previous run still in progress', {
        runningForMs: Date.now() - this.runStartedAt,
        consecutiveSkips: this.consecutiveSkips,
      });

      return;
    }

    this.running = true;
    this.runStartedAt = Date.now();
    this.consecutiveSkips = 0;

    try {
      try {
        await this.dailyMetricsService.refreshAll(options.windowDays);
      } catch (err) {
        this.logger.error(
          'Daily metrics refresh failed',
          err instanceof Error ? err : new Error(String(err)),
        );
      }

      try {
        await this.refreshPlaces();
      } catch (err) {
        this.logger.error('Place engine refresh failed', err instanceof Error ? err : new Error(String(err)));
      }

      try {
        await this.ensureHomeAsks();
      } catch (err) {
        this.logger.error('Home confirm enqueue failed', err instanceof Error ? err : new Error(String(err)));
      }

      try {
        await this.derivationScanService.scanAll();
      } catch (err) {
        this.logger.error('Derivation scan failed', err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      this.running = false;
      this.logger.log('Daily metrics refresh finished', {
        windowDays: options.windowDays,
        durationMs: Date.now() - this.runStartedAt,
      });
    }
  }

  /**
   * Rebuild stay-point clusters + recency-decayed transitions for a rotating
   * batch of onboarded users, then score their elapsed place_forecast_log rows.
   * Failures for one user do not abort the rest of the run.
   */
  private async refreshPlaces(): Promise<void> {
    const users = await this.userService.findAllOnboarded();
    const batch = this.nextPlacesBatch(users);
    this.logger.log('Refreshing place engine', { users: batch.length, onboarded: users.length });

    for (const user of batch) {
      const timezone = user.timezone || 'UTC';
      const context: UserServiceContext = { userId: user.id };

      try {
        await this.placeTransitionService.rebuild(context, { timezone });
        await this.placeTransitionService.scoreLog(context);
      } catch (err) {
        this.logger.error(
          `Place engine refresh failed for user ${user.id} (${timezone})`,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }
  }

  /** Advance the round-robin window over `users`, wrapping at the end. */
  private nextPlacesBatch(users: User[]): User[] {
    if (users.length <= PLACES_USERS_PER_TICK) {
      this.placesCursor = 0;

      return users;
    }

    const cursor = this.placesCursor % users.length;
    const batch = Array.from(
      { length: PLACES_USERS_PER_TICK },
      (_, offset) => users[(cursor + offset) % users.length],
    );

    this.placesCursor = (cursor + PLACES_USERS_PER_TICK) % users.length;

    return batch;
  }

  private async ensureHomeAsks(): Promise<void> {
    const users = await this.userService.findAllOnboarded();

    for (const user of users) {
      try {
        await this.homeConfirmService.ensureAction({ userId: user.id });
      } catch (err) {
        this.logger.error(
          `Home confirm enqueue failed for user ${user.id}`,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }
  }
}

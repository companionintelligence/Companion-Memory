import { Global, Module } from '@nestjs/common';

import config from '@ci/configuration';

import { CONSUMPTION_STORE, type ConsumptionStore } from './ConsumptionStore';
import { ConsumptionSweepCron } from './cron/ConsumptionSweepCron';
import { InMemoryConsumptionStore } from './InMemoryConsumptionStore';
import { PostgresConsumptionStore } from './PostgresConsumptionStore';

/**
 * The consumption store, chosen once at boot.
 *
 * ═══ WHY POSTGRES IS THE DEFAULT ═══
 *
 * The in-memory backend is the one that shipped, three times, and G8 is the bug
 * report. Defaulting to it again would leave every multi-replica deployment
 * with the same defect and an opt-in nobody knows to set — and for the nonce
 * cache that defect is a replay succeeding once per replica, which is not a
 * tuning question.
 *
 * The cost is a round trip on a hot path. That is the right trade for a control
 * whose whole job is to be correct under load, and both operations are
 * single-row and indexed.
 *
 * `consumption.store: "memory"` opts back out, for a single-process box or a
 * test that does not want a database.
 *
 * GLOBAL because three domains need it (`asks`, `peers`, and the budgets in
 * #2364) and threading a provider through each of their modules would give
 * every one of them a chance to bind a different backend — which is how you get
 * two stores and half a limit.
 */
@Global()
@Module({
  providers: [
    InMemoryConsumptionStore,
    PostgresConsumptionStore,
    {
      provide: CONSUMPTION_STORE,
      inject: [InMemoryConsumptionStore, PostgresConsumptionStore],
      useFactory: (memory: InMemoryConsumptionStore, postgres: PostgresConsumptionStore): ConsumptionStore =>
        config.consumption?.store === 'memory' ? memory : postgres,
    },
    // Registered as a provider so its @Cron method is discovered by the
    // scheduler; nothing injects it, so it is deliberately NOT exported.
    // Always schedules against PostgresConsumptionStore directly (not the
    // CONSUMPTION_STORE token) — the in-memory backend has nothing to reap,
    // and this must reclaim the Postgres tables regardless of which backend
    // is selected for the hot path.
    ConsumptionSweepCron,
  ],
  exports: [CONSUMPTION_STORE, PostgresConsumptionStore],
})
export class ConsumptionModule {}

export { checkSlidingWindow } from './slidingWindow';
export type { RateLimitDecision } from './slidingWindow';
export { CONSUMPTION_STORE } from './ConsumptionStore';
export type { ConsumptionStore } from './ConsumptionStore';
export { InMemoryConsumptionStore } from './InMemoryConsumptionStore';
export { PostgresConsumptionStore } from './PostgresConsumptionStore';

import { Module } from '@nestjs/common';

import { PeersModule } from '@ci/domains/peers';

import { TrustTasksController } from './controllers/TrustTasksController';
import { TrustTasksService } from './TrustTasksService';

/**
 * Trust Tasks (https://trusttasks.org) alongside the peer-ask surface — see `docs/trust-tasks.md`.
 *
 * Imports `PeersModule` for the ask pipeline, the peer links and the rate limiter it already owns; it
 * adds no table, no migration and no new gate. `FeatureService`, `LoggerService` and the consumption
 * store are global.
 */
@Module({
  imports: [PeersModule],
  controllers: [TrustTasksController],
  providers: [TrustTasksService],
})
export class TrustTasksModule {}

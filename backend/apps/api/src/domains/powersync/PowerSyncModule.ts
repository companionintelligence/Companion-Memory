import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { PowerSyncController } from './controllers/PowerSyncController';
import { SyncWindowSweepCron } from './cron/SyncWindowSweepCron';
import { PowerSyncTokenService } from './services/PowerSyncTokenService';

/**
 * Issues short-lived PowerSync auth tokens for the local-first sync engine, and
 * holds the device sync window open. The actual sync (Postgres logical
 * replication → PowerSync service → on-device SQLite) runs in the `powersync`
 * container; see infrastructure/powersync/.
 *
 * The window lives here rather than in the sync rules because PowerSync cannot
 * express a rolling cutoff — see SyncWindowSweepCron.
 */
@Module({
  // Empty JwtModule registration: tokens are signed with an explicit per-call
  // secret (the PowerSync secret), not the module-default auth secret.
  imports: [JwtModule.register({})],
  controllers: [PowerSyncController],
  providers: [PowerSyncTokenService, SyncWindowSweepCron],
})
export class PowerSyncModule {}

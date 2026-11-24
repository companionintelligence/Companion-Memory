/**
 * BlueBubbles (https://github.com/BlueBubblesApp/bluebubbles-app) integration:
 * the appliance-wide connection config, the DI-friendly wiring that gives the
 * framework-free `BlueBubblesAPIImporter` ETL importer
 * (`domains/import/datasources/bluebubbles.ts`) its first caller, and the
 * settings/webhook HTTP surface.
 *
 * Deliberately split from that datasource file: importers under
 * `domains/import/datasources/*.ts` are framework-free plain TypeScript (no
 * NestJS decorators, no DI) by hard convention, but a settings page, a
 * webhook controller and a 10-minute cron all need DI — a config repository,
 * `ImportRunService`/`PushStage` for the shared ingest path, a logger. This
 * module is where that framework-facing half lives.
 *
 * The AI messaging tools (`domains/tools/tools/Messaging*Tool.ts`) also
 * depend on this module — for `BlueBubblesClientService` specifically, not
 * the sync/webhook machinery — which is why it is exported here rather than
 * kept private to this module.
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ApplianceAdminGuard } from '@ci/common/guards';
import { ImportModule } from '@ci/domains/import';
import { UserModule } from '@ci/domains/user';

import { BlueBubblesConfigController } from './controllers/BlueBubblesConfigController';
import { BlueBubblesWebhookController } from './controllers/BlueBubblesWebhookController';
import { BlueBubblesSyncCron } from './cron/BlueBubblesSyncCron';
import { BlueBubblesConfigEntity } from './entities/BlueBubblesConfigEntity';
import { BlueBubblesClientService } from './services/BlueBubblesClientService';
import { BlueBubblesConfigService } from './services/BlueBubblesConfigService';
import { BlueBubblesSyncService } from './services/BlueBubblesSyncService';

@Module({
  imports: [TypeOrmModule.forFeature([BlueBubblesConfigEntity]), ImportModule, UserModule],
  controllers: [BlueBubblesConfigController, BlueBubblesWebhookController],
  providers: [
    BlueBubblesConfigService,
    BlueBubblesClientService,
    BlueBubblesSyncService,
    BlueBubblesSyncCron,
    // Registered so Nest resolves its DataSource here: the config GET asks it
    // whether the caller is an administrator rather than being refused by it.
    ApplianceAdminGuard,
  ],
  // BlueBubblesClientService: consumed by the `messaging.*` AI tools (ToolsModule).
  // BlueBubblesConfigService: consumed nowhere outside this module today, but exported for
  // symmetry / a future settings surface that needs it without pulling in the sync machinery.
  exports: [BlueBubblesClientService, BlueBubblesConfigService],
})
export class BlueBubblesModule {}

export { BlueBubblesClientService } from './services/BlueBubblesClientService';
export { BlueBubblesConfigService } from './services/BlueBubblesConfigService';

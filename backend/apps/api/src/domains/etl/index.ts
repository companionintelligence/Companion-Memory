// V2 ETL Collection Engine
export * from './controllers';
export * from './entities';
export * from './services';
export * from './types';

import { Module } from '@nestjs/common';

import { EventsModule } from '@ci/domains/events';
import { ConnectionsModule } from '@ci/domains/connections';

import { EtlController } from './controllers/EtlController';
import { EtlCollectionService } from './services/EtlCollectionService';
import { EtlTransformService } from './services/EtlTransformService';

@Module({
  imports: [EventsModule, ConnectionsModule],
  providers: [EtlCollectionService, EtlTransformService],
  controllers: [EtlController],
  exports: [EtlCollectionService, EtlTransformService],
})
export class EtlModule {}
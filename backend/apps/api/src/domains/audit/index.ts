/**
 * @module AuditModule
 *
 * Tracks changes to graph entities (nodes and relationships) for audit purposes.
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { GraphModule } from '@ci/domains/graph';

import { AuditController } from './controllers/AuditController';
import { DeltaEntity } from './entities/DeltaEntity';
import { DeltaService } from './services/DeltaService';
import { DeltaEntitySubscriber } from './subscribers/DeltaEntitySubscriber';

@Module({
  imports: [
    TypeOrmModule.forFeature([DeltaEntity]),
    GraphModule, // For NodeEntity and RelationshipEntity used by the subscriber
  ],
  controllers: [AuditController],
  providers: [DeltaService, DeltaEntitySubscriber],
  exports: [DeltaService],
})
export class AuditModule {}

export { DeltaService };
export { DeltaEntity };
export type { Delta, NodeType, ChangeType, ChangedField } from './entities/DeltaEntity';
export type { CreateDeltaDto, FindDeltasOptions, UpdateDeltasSummaryDto } from './types';

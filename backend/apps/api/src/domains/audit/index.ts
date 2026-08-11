/**
 * @module AuditModule
 *
 * The READ side of `ci.graph_deltas`: history of what changed in the knowledge
 * graph, served to the API and to the summary app.
 *
 * Preferred trail going forward is `ci.entity_mutations` (app-written via
 * {@link EntityMutationService} in MemoryModule) — see #1941. graph_deltas
 * triggers remain until insight readers cut over.
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { GraphModule } from '@ci/domains/graph';

import { AuditController } from './controllers/AuditController';
import { DeltaEntity } from './entities/DeltaEntity';
import { DeltaService } from './services/DeltaService';

@Module({
  imports: [
    TypeOrmModule.forFeature([DeltaEntity]),
    GraphModule, // For NodeService, injected by AuditController
  ],
  controllers: [AuditController],
  providers: [DeltaService],
  exports: [DeltaService],
})
export class AuditModule {}

export { DeltaService };
export { DeltaEntity };
export type { Delta, NodeType, ChangeType, ChangedField } from './entities/DeltaEntity';
export type { CreateDeltaDto, FindDeltasOptions, UpdateDeltasSummaryDto } from './types';

/**
 * @module AuditModule
 *
 * The READ side of `ci.graph_deltas`: history of what changed in the knowledge
 * graph, served to the API and to the summary app.
 *
 * Writers live in MemoryModule ({@link GraphDeltaWriter}) — app code inserts
 * into `ci.graph_deltas` in the same transaction as domain writes. DB triggers
 * were removed (20260811210000). See #1941 / PR #1942.
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

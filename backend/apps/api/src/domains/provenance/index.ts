/**
 * Plan 08 — Provenance & lineage.
 *
 * Provides:
 *   - ProvenanceService.recordEntity / recordRelationship / recordFact
 *   - IngestRunService.start / incrementCounts / end / rollback
 *
 * Wired into the ETL Promote path (initial site: PromoteService.processParticipants)
 * with subsequent commits porting every Promote* path. Once provenance is
 * populated everywhere, the GraphQL/MCP read APIs surface `derivedFrom` +
 * `sources` per plan 08 §3.4.
 */

import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import {
  EntityProvenanceEntity,
  FactProvenanceEntity,
  RelationshipProvenanceEntity,
} from './entities/EntityProvenanceEntity';
import { IngestRunEntity } from './entities/IngestRunEntity';
import { IngestRunService } from './services/IngestRunService';
import { ProvenanceService } from './services/ProvenanceService';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([
      EntityProvenanceEntity,
      RelationshipProvenanceEntity,
      FactProvenanceEntity,
      IngestRunEntity,
    ]),
  ],
  providers: [ProvenanceService, IngestRunService],
  exports: [ProvenanceService, IngestRunService],
})
export class ProvenanceModule {}

export { ProvenanceService, type ProvenanceWrite } from './services/ProvenanceService';
export { IngestRunService } from './services/IngestRunService';
export {
  EntityProvenanceEntity,
  RelationshipProvenanceEntity,
  FactProvenanceEntity,
  type ProvenanceKind,
} from './entities/EntityProvenanceEntity';
export { IngestRunEntity, type IngestRunStatus } from './entities/IngestRunEntity';

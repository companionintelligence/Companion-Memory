import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LoggerService } from '@ci/common/logging';

import {
  EntityProvenanceEntity,
  FactProvenanceEntity,
  RelationshipProvenanceEntity,
  type ProvenanceKind,
} from '../entities/EntityProvenanceEntity';

export interface ProvenanceWrite {
  kind: ProvenanceKind;
  sourceProvider?: string;
  sourceId?: string;
  sourceUri?: string;
  ingestRunId?: string;
  model?: string;
  sourceConfidence?: number;
  rawExcerptHash?: string;
}

/**
 * Plan 08 §3 — write provenance rows for entities, relationships, facts.
 *
 * Each method upserts: existing rows for an id are overwritten (later
 * writers win — appropriate when the ETL re-syncs the same source row
 * with refreshed metadata). `kind='legacy'` rows from the migration
 * backfill are silently replaced once a real provenance write arrives.
 *
 * Failures never throw: a missing provenance row degrades retrieval
 * quality but must not block the graph write itself.
 */
@Injectable()
export class ProvenanceService {
  constructor(
    @InjectRepository(EntityProvenanceEntity)
    private readonly entityRepo: Repository<EntityProvenanceEntity>,
    @InjectRepository(RelationshipProvenanceEntity)
    private readonly relRepo: Repository<RelationshipProvenanceEntity>,
    @InjectRepository(FactProvenanceEntity)
    private readonly factRepo: Repository<FactProvenanceEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ProvenanceService.name);
  }

  async recordEntity(entityId: string, write: ProvenanceWrite): Promise<void> {
    try {
      await this.entityRepo.save({ entity_id: entityId, ...this.toRow(write) });
    } catch (error) {
      this.warn('entity', entityId, error);
    }
  }

  async recordRelationship(relationshipId: string, write: ProvenanceWrite): Promise<void> {
    try {
      await this.relRepo.save({ relationship_id: relationshipId, ...this.toRow(write) });
    } catch (error) {
      this.warn('relationship', relationshipId, error);
    }
  }

  async recordFact(factId: string, write: ProvenanceWrite): Promise<void> {
    try {
      await this.factRepo.save({ fact_id: factId, ...this.toRow(write) });
    } catch (error) {
      this.warn('fact', factId, error);
    }
  }

  private toRow(w: ProvenanceWrite) {
    return {
      kind: w.kind,
      source_provider: w.sourceProvider ?? null,
      source_id: w.sourceId ?? null,
      source_uri: w.sourceUri ?? null,
      ingest_run_id: w.ingestRunId ?? null,
      model: w.model ?? null,
      source_confidence: w.sourceConfidence ?? null,
      raw_excerpt_hash: w.rawExcerptHash ?? null,
    };
  }

  private warn(kind: string, id: string, error: unknown) {
    this.logger.warn(`Failed to persist ${kind} provenance`, {
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

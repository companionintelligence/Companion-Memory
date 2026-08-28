import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

import type { GraphEntityInputDto, GraphRelationshipInputDto } from '@ci/domains/graph';

/** Which `GraphEnrichmentService.ingestWithPersonalization` call produced this batch. */
export const GRAPH_ENRICHMENT_PROPOSAL_CATEGORIES = [
  'preference',
  'family_relation',
  'general_relation',
] as const;
export type GraphEnrichmentProposalCategory = (typeof GRAPH_ENRICHMENT_PROPOSAL_CATEGORIES)[number];

/** Mirrors `ci.entity_type_proposals` / `ci.merge_candidates`' vocabulary. */
export const GRAPH_ENRICHMENT_PROPOSAL_STATUSES = ['pending', 'accepted', 'rejected'] as const;
export type GraphEnrichmentProposalStatus = (typeof GRAPH_ENRICHMENT_PROPOSAL_STATUSES)[number];

/**
 * One batch `GraphEnrichmentService` was about to write into the graph but
 * routed to review instead of auto-applying (see `ingestWithPersonalization`
 * and migration 20260824214141 for the full "why a new table" reasoning).
 *
 * The proposal carries the exact `bulkIngestGraph` batch — {@link entities} /
 * {@link relationships} — so accepting it later is a direct replay through
 * `GraphIngestService.ingest`, not a re-derivation from the source LLM
 * extraction (which is never persisted).
 */
@Entity({ schema: 'ci', name: 'graph_enrichment_proposals' })
@Index(['ownerUserId', 'status'])
export class GraphEnrichmentProposalEntity {
  @PrimaryColumn({ type: 'uuid', name: 'graph_enrichment_proposal_id' })
  id!: string;

  @Column({ type: 'uuid', name: 'owner_user_id' })
  ownerUserId!: string;

  @Column({ type: 'text' })
  category!: GraphEnrichmentProposalCategory;

  /** sha256 of the (entities, relationships) payload — the re-run dedupe key. */
  @Column({ type: 'text', name: 'content_hash' })
  contentHash!: string;

  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  entities!: GraphEntityInputDto[];

  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  relationships!: GraphRelationshipInputDto[];

  /** Human-readable one-line-per-item descriptions, for a review UI. */
  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  evidence!: string[];

  @Column({ type: 'double precision' })
  confidence!: number;

  @Column({ type: 'text', default: 'pending' })
  status!: GraphEnrichmentProposalStatus;

  @Column({ type: 'text', name: 'detected_by', default: 'graph_enrichment' })
  detectedBy!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  @Column({ type: 'timestamptz', name: 'resolved_at', nullable: true })
  resolvedAt!: Date | null;
}

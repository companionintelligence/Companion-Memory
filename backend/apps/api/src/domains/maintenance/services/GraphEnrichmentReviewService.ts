import { createHash } from 'crypto';

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import {
  type GraphEntityInputDto,
  type GraphIngestResult,
  GraphIngestService,
  type GraphRelationshipInputDto,
} from '@ci/domains/graph';

import {
  type GraphEnrichmentProposalCategory,
  GraphEnrichmentProposalEntity,
  type GraphEnrichmentProposalStatus,
} from '../entities/GraphEnrichmentProposalEntity';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export interface GraphEnrichmentProposalBatch {
  entities: GraphEntityInputDto[];
  relationships: GraphRelationshipInputDto[];
}

export interface RecordProposalInput {
  category: GraphEnrichmentProposalCategory;
  input: GraphEnrichmentProposalBatch;
  evidence: string[];
  confidence: number;
}

export interface GraphEnrichmentProposalPage {
  proposals: GraphEnrichmentProposalEntity[];
  totalCount: number;
  hasNextPage: boolean;
  endCursor: string | null;
}

/**
 * JSON with object keys in sorted order, so the same batch hashes identically
 * regardless of the source order its fields were built in. Mirrors
 * GraphIngestService's own `stableJson`.
 */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }

      return sorted;
    }

    return v;
  });
}

function hashBatch(batch: GraphEnrichmentProposalBatch): string {
  return createHash('sha256').update(stableJson(batch)).digest('hex');
}

export function encodeGraphEnrichmentProposalCursor(proposal: { createdAt: Date; id: string }): string {
  return Buffer.from(`${proposal.createdAt.toISOString()}::${proposal.id}`).toString('base64');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const [createdAt, id] = Buffer.from(cursor, 'base64').toString('utf8').split('::');

    return createdAt && id ? { createdAt, id } : null;
  } catch {
    return null;
  }
}

/**
 * Persistence + review lifecycle for the batches `GraphEnrichmentService`
 * routes to `'review'` instead of auto-applying. See migration 20260824214141
 * for why this is its own table rather than an existing review queue.
 *
 * It proposes; it never applies on its own. {@link accept} is the only path
 * that writes to the graph, and it does so by replaying the exact batch
 * through {@link GraphIngestService.ingest} — the same idempotent path the
 * auto-apply branch of `ingestWithPersonalization` already uses.
 */
@Injectable()
export class GraphEnrichmentReviewService {
  constructor(
    @InjectRepository(GraphEnrichmentProposalEntity)
    private readonly repository: Repository<GraphEnrichmentProposalEntity>,
    private readonly graphIngestService: GraphIngestService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(GraphEnrichmentReviewService.name);
  }

  /**
   * File (or refresh) a proposal for one `ingestWithPersonalization` batch.
   *
   * Upserts on (owner, category, content hash) so re-running extract-graph
   * over unchanged data never piles up duplicate pending rows — matching
   * `ci.entity_type_proposals`' rule, a re-run refreshes confidence/evidence
   * but NEVER touches `status`: a human's decision on this exact batch stands.
   */
  async recordProposal(context: UserServiceContext, params: RecordProposalInput): Promise<void> {
    if (params.input.entities.length === 0 && params.input.relationships.length === 0) {
      return;
    }

    const contentHash = hashBatch(params.input);

    await this.repository.manager.query(
      `INSERT INTO ci.graph_enrichment_proposals (
              graph_enrichment_proposal_id, owner_user_id, category, content_hash,
              entities, relationships, evidence, confidence)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8)
       ON CONFLICT (owner_user_id, category, content_hash) DO UPDATE
          SET entities     = EXCLUDED.entities,
              relationships = EXCLUDED.relationships,
              evidence     = EXCLUDED.evidence,
              confidence   = EXCLUDED.confidence,
              updated_at   = now()`,
      [
        uuidv7(),
        context.userId,
        params.category,
        contentHash,
        JSON.stringify(params.input.entities),
        JSON.stringify(params.input.relationships),
        JSON.stringify(params.evidence),
        params.confidence,
      ],
    );
  }

  async findProposals(
    context: UserServiceContext,
    options: {
      status?: GraphEnrichmentProposalStatus;
      category?: GraphEnrichmentProposalCategory;
      limit?: number;
      after?: string | null;
    } = {},
  ): Promise<GraphEnrichmentProposalPage> {
    const status = options.status ?? 'pending';
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const cursor = options.after ? decodeCursor(options.after) : null;

    const qb = this.repository
      .createQueryBuilder('p')
      .where('p.ownerUserId = :userId', { userId: context.userId })
      .andWhere('p.status = :status', { status });

    if (options.category) {
      qb.andWhere('p.category = :category', { category: options.category });
    }

    const totalCount = await qb.getCount();

    if (cursor) {
      qb.andWhere('(p.createdAt < :createdAt OR (p.createdAt = :createdAt AND p.id > :id))', {
        createdAt: cursor.createdAt,
        id: cursor.id,
      });
    }

    const rows = await qb
      .orderBy('p.createdAt', 'DESC')
      .addOrderBy('p.id', 'ASC')
      .take(limit + 1)
      .getMany();

    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return {
      proposals: page,
      totalCount,
      hasNextPage,
      endCursor: last ? encodeGraphEnrichmentProposalCursor(last) : null,
    };
  }

  /**
   * Apply one pending proposal's batch through `GraphIngestService.ingest`
   * and mark it accepted. A no-op (returns null) for a proposal that is
   * missing, not this user's, or already resolved — so a double-click can
   * never apply the same batch twice.
   */
  async accept(
    context: UserServiceContext,
    id: string,
  ): Promise<{ proposal: GraphEnrichmentProposalEntity; ingest: GraphIngestResult } | null> {
    const proposal = await this.repository.findOne({ where: { id, ownerUserId: context.userId } });

    if (!proposal || proposal.status !== 'pending') {
      return null;
    }

    const ingest = await this.graphIngestService.ingest(context, {
      entities: proposal.entities,
      relationships: proposal.relationships,
    });

    proposal.status = 'accepted';
    proposal.resolvedAt = new Date();
    await this.repository.save(proposal);

    this.logger.log('Accepted graph enrichment proposal', {
      userId: context.userId,
      proposalId: id,
      category: proposal.category,
      entitiesProcessed: ingest.entitiesProcessed,
      relationshipsProcessed: ingest.relationshipsProcessed,
    });

    return { proposal, ingest };
  }

  /** Marks a pending proposal rejected. No-op (returns null) if already resolved or not found. */
  async reject(context: UserServiceContext, id: string): Promise<GraphEnrichmentProposalEntity | null> {
    const proposal = await this.repository.findOne({ where: { id, ownerUserId: context.userId } });

    if (!proposal || proposal.status !== 'pending') {
      return null;
    }

    proposal.status = 'rejected';
    proposal.resolvedAt = new Date();
    await this.repository.save(proposal);

    this.logger.log('Rejected graph enrichment proposal', {
      userId: context.userId,
      proposalId: id,
      category: proposal.category,
    });

    return proposal;
  }
}

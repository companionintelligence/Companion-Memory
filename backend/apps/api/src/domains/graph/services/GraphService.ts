import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { UserServiceContext } from '@ci/common/context';

import { type Node } from '../entities/NodeEntity';
import { type Relationship, RelationshipEntity } from '../entities/RelationshipEntity';
import { RelationshipType } from '../types';

import { NodeService } from './NodeService';

@Injectable()
export class GraphService {
  constructor(
    @InjectRepository(RelationshipEntity)
    private readonly relationshipRepository: Repository<RelationshipEntity>,
    private readonly nodeService: NodeService,
  ) {}

  async traverse(
    context: UserServiceContext,
    nodeIds: string[],
    options: {
      relationshipTypes?: (keyof typeof RelationshipType)[];
      direction?: 'outbound' | 'inbound' | 'both';
      maxDepth?: number;
      maxNodes?: number;
      maxEdges?: number;
    } = {},
  ): Promise<{ nodes: Node[]; edges: Relationship[] }> {
    const maxDepth = Math.max(0, options.maxDepth ?? 1);
    const maxNodes = Math.max(1, Math.min(options.maxNodes ?? 25, 250));
    const maxEdges = Math.max(0, Math.min(options.maxEdges ?? 50, 500));
    const direction = options.direction ?? 'both';

    const visitedNodes = new Map<string, Node>();
    const collectedEdges: Relationship[] = [];

    let currentLayer = new Set(nodeIds);
    let depth = 0;

    while (currentLayer.size > 0 && depth <= maxDepth && visitedNodes.size < maxNodes) {
      const layerIds = Array.from(currentLayer).filter((id) => !visitedNodes.has(id));

      if (layerIds.length === 0) {
        break;
      }

      const nodes = (await this.nodeService.findByIds(context, layerIds)).filter(
        (node): node is Node => node !== null,
      );

      nodes.forEach((node) => {
        if (!visitedNodes.has(node.entityId) && visitedNodes.size < maxNodes) {
          visitedNodes.set(node.entityId, node);
        }
      });

      if (depth === maxDepth || visitedNodes.size >= maxNodes || collectedEdges.length >= maxEdges) {
        break;
      }

      const relationships = await this.getRelationships(context, layerIds, {
        relationshipTypes: options.relationshipTypes,
        direction,
      });

      console.log(
        `Depth ${depth}: Found ${relationships.length} relationships for layer with ${layerIds.length} nodes.`,
        {
          relationships,
        },
      );

      const nextLayer = new Set<string>();

      for (const rel of relationships) {
        if (collectedEdges.length >= maxEdges) {
          break;
        }

        collectedEdges.push(rel);

        if (direction === 'outbound' || direction === 'both') {
          if (layerIds.includes(rel.fromNodeId) && !visitedNodes.has(rel.toNodeId)) {
            nextLayer.add(rel.toNodeId);
          }
        }

        if (direction === 'inbound' || direction === 'both') {
          if (layerIds.includes(rel.toNodeId) && !visitedNodes.has(rel.fromNodeId)) {
            nextLayer.add(rel.fromNodeId);
          }
        }
      }

      currentLayer = nextLayer;
      depth += 1;
    }

    return {
      nodes: Array.from(visitedNodes.values()),
      edges: collectedEdges.slice(0, maxEdges),
    };
  }

  private async getRelationships(
    context: UserServiceContext,
    nodeIds: string[],
    options: {
      relationshipTypes?: (keyof typeof RelationshipType)[];
      direction?: 'outbound' | 'inbound' | 'both';
    } = {},
  ): Promise<Relationship[]> {
    if (nodeIds.length === 0) {
      return [];
    }

    let query = this.relationshipRepository
      .createQueryBuilder('rel')
      .where('rel.userId = :userId', { userId: context.userId });

    if (options.relationshipTypes?.length) {
      query = query.andWhere('rel.type IN (:...relationshipTypes)', {
        relationshipTypes: options.relationshipTypes,
      });
    }

    const direction = options.direction ?? 'both';

    switch (direction) {
      case 'outbound':
        query = query.andWhere('rel.fromNodeId IN (:...entityIds)', {
          entityIds: nodeIds,
        });
        break;

      case 'inbound':
        query = query.andWhere('rel.toNodeId IN (:...entityIds)', {
          entityIds: nodeIds,
        });
        break;

      case 'both':
        query = query.andWhere('(rel.fromNodeId IN (:...entityIds) OR rel.toNodeId IN (:...entityIds))', {
          entityIds: nodeIds,
        });
        break;
    }

    return (await query.getMany()).map((entity) => RelationshipEntity.toEgressType(entity));
  }
}

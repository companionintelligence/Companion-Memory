import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/services';

import { GraphNodeEntity } from '../entities/GraphNodeEntity';

import { GraphQueryService } from './GraphQueryService';

/**
 * User context data structure for LLM system prompts
 */
export interface UserContext {
  currentUser: {
    entityId: string;
    name: string;
    username: string | null;
    properties?: Record<string, unknown>;
  };
  familyMembers: Array<{
    entityId: string;
    name: string;
    relationship: string;
    age?: number;
    properties?: Record<string, unknown>;
  }>;
  topPreferences: Array<{
    entityId: string;
    name: string;
    type: string;
    strength: number;
    relationship: 'PREFERS' | 'DISLIKES';
  }>;
  quickStats: {
    totalEntities: number;
    totalPreferences: number;
    totalDislikes: number;
    familySize: number;
  };
}

type PreferenceRelationshipResult = {
  entityId: string;
  name: string;
  type: string;
  strength: number;
  relationship: 'PREFERS' | 'DISLIKES';
};

/**
 * Service to generate rich context about a user for LLM pre-hydration
 *
 * This service provides a snapshot of the user's knowledge graph that can be
 * injected into the system prompt, giving the LLM baseline knowledge about:
 * - Who the user is
 * - Their family members
 * - Their preferences and dislikes
 * - Basic stats about their knowledge graph
 *
 * This enables better tool selection, fewer queries, and more contextual responses.
 */
@Injectable()
export class UserContextService {
  private logger = new LoggerService(UserContextService.name);

  constructor(
    private readonly graphQuery: GraphQueryService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Get comprehensive user context for LLM system prompt injection
   *
   * @param userId - The user ID to get context for
   * @returns UserContext object ready for system prompt
   */
  async getUserContextForLLM(userId: string): Promise<UserContext | null> {
    try {
      // 1. Get user's entity
      const userEntity = await this.resolveUserEntity(userId);
      if (!userEntity) {
        this.logger.warn(`No entity found for user ${userId}`);

        return null;
      }

      // 2. Get family members (1-hop family relationships)
      const familyMembers = await this.getFamilyMembers(userId, userEntity.entity_id);

      // 3. Get top preferences and dislikes
      const preferences = await this.getTopPreferences(userId, userEntity.entity_id, 10);
      const dislikes = await this.getTopDislikes(userId, userEntity.entity_id, 5);

      // 4. Get quick stats
      const stats = await this.getQuickStats(userId);

      // 5. Format for LLM
      return {
        currentUser: {
          entityId: userEntity.entity_id,
          name: userEntity.name ?? 'User',
          username: await this.getUsernameFromUsersTable(userId),
          properties: this.pickImportantProperties(userEntity.properties ?? {}),
        },
        familyMembers: familyMembers.map((member) => ({
          entityId: member.entityId,
          name: member.name,
          relationship: member.relationship,
          age: member.age,
          properties: this.pickImportantProperties(member.properties ?? {}),
        })),
        topPreferences: [...preferences, ...dislikes],
        quickStats: {
          totalEntities: stats.totalEntities,
          totalPreferences: preferences.length,
          totalDislikes: dislikes.length,
          familySize: familyMembers.length,
        },
      };
    } catch (error) {
      this.logger.error(
        'Failed to get user context for LLM',
        error instanceof Error ? error : new Error(String(error)),
      );

      return null;
    }
  }

  /**
   * Format user context as markdown for system prompt
   */
  formatContextForSystemPrompt(context: UserContext): string {
    const lines = [
      '# User Context',
      '',
      '## Current User',
      `- Name: ${context.currentUser.name}`,
      `- Username: ${context.currentUser.username || 'Not set'}`,
      `- Entity ID: ${context.currentUser.entityId}`,
    ];

    if (context.currentUser.properties && Object.keys(context.currentUser.properties).length > 0) {
      lines.push('- Properties:');
      Object.entries(context.currentUser.properties).forEach(([key, value]) => {
        lines.push(`  - ${key}: ${value}`);
      });
    }

    if (context.familyMembers.length > 0) {
      lines.push('', '## Family Members');
      context.familyMembers.forEach((member) => {
        lines.push(`- ${member.name} (${member.relationship})${member.age ? `, age ${member.age}` : ''}`);
        lines.push(`  - Entity ID: ${member.entityId}`);
      });
    }

    if (context.topPreferences.length > 0) {
      const preferences = context.topPreferences.filter((p) => p.relationship === 'PREFERS');
      const dislikes = context.topPreferences.filter((p) => p.relationship === 'DISLIKES');

      if (preferences.length > 0) {
        lines.push('', '## Top Preferences');
        preferences.forEach((pref) => {
          lines.push(`- ${pref.name} (${pref.type}) - strength: ${pref.strength.toFixed(2)}`);
        });
      }

      if (dislikes.length > 0) {
        lines.push('', '## Dislikes');
        dislikes.forEach((dislike) => {
          lines.push(`- ${dislike.name} (${dislike.type}) - strength: ${dislike.strength.toFixed(2)}`);
        });
      }
    }

    lines.push('', '## Quick Stats');
    lines.push(`- Total entities in graph: ${context.quickStats.totalEntities}`);
    lines.push(`- Total preferences: ${context.quickStats.totalPreferences}`);
    lines.push(`- Total dislikes: ${context.quickStats.totalDislikes}`);
    lines.push(`- Family members: ${context.quickStats.familySize}`);

    lines.push('', '---');
    lines.push(
      'Use this context to make informed decisions about tool usage. ' +
        'When the user refers to "my family", these are the people they mean. ' +
        'You can use entity IDs from this context for precise queries.',
    );

    return lines.join('\n');
  }

  /**
   * Resolve user's Person entity
   */
  private async resolveUserEntity(userId: string): Promise<GraphNodeEntity | null> {
    // Try to get entity_id from users table first
    const userQuery = `
      SELECT entity_id
      FROM users
      WHERE id = $1
    `;
    const userResult = await this.dataSource.query(userQuery, [userId]);

    if (userResult.length > 0 && userResult[0].entity_id) {
      const entity = await this.graphQuery.getNode(userId, userResult[0].entity_id);
      if (entity) {
        return entity;
      }
    }

    // Fall back to linked entities
    const nodes = await this.graphQuery.getNodes(userId, { entityType: 'Person', limit: 1 });

    if (nodes.length > 0) {
      const [node] = nodes;
      if (userResult.length > 0 && !userResult[0].entity_id) {
        await this.dataSource.query(`UPDATE users SET entity_id = $2 WHERE id = $1`, [
          userId,
          node.entity_id,
        ]);
      }

      return node;
    }

    return null;
  }

  /**
   * Get username from users table
   */
  private async getUsernameFromUsersTable(userId: string): Promise<string | null> {
    const query = `SELECT username, name FROM users WHERE id = $1`;
    const result = await this.dataSource.query(query, [userId]);

    if (result.length > 0) {
      return result[0].username || result[0].name || null;
    }

    return null;
  }

  /**
   * Get family members (SPOUSE, PARENT_OF, CHILD_OF, SIBLING_OF relationships)
   */
  private async getFamilyMembers(
    userId: string,
    userEntityId: string,
  ): Promise<
    Array<{
      entityId: string;
      name: string;
      relationship: string;
      age?: number;
      properties?: Record<string, unknown>;
    }>
  > {
    const { nodes, edges } = await this.graphQuery.traverseGraph(userId, [userEntityId], {
      relationshipTypes: ['SPOUSE', 'PARENT_OF', 'CHILD_OF', 'SIBLING_OF'],
      direction: 'both',
      maxDepth: 1,
      maxNodes: 20,
      maxEdges: 20,
    });

    const familyMembers: Array<{
      entityId: string;
      name: string;
      relationship: string;
      age?: number;
      properties?: Record<string, unknown>;
    }> = [];

    for (const edge of edges) {
      const relatedEntityId = edge.from_entity_id === userEntityId ? edge.to_entity_id : edge.from_entity_id;

      const relatedNode = nodes.get(relatedEntityId);
      if (relatedNode && relatedNode.entity_id !== userEntityId) {
        familyMembers.push({
          entityId: relatedNode.entity_id,
          name: relatedNode.name ?? 'Unknown',
          relationship: edge.relationship_type,
          age: relatedNode.properties?.['age'] as number | undefined,
          properties: relatedNode.properties ?? {},
        });
      }
    }

    return familyMembers;
  }

  /**
   * Get top preferences (PREFERS relationships)
   */
  private async getTopPreferences(
    userId: string,
    userEntityId: string,
    limit: number,
  ): Promise<
    Array<{
      entityId: string;
      name: string;
      type: string;
      strength: number;
      relationship: 'PREFERS';
    }>
  > {
    const results = await this.getTopRelationships(userId, userEntityId, 'PREFERS', limit);

    return results.map((item) => ({
      ...item,
      relationship: 'PREFERS' as const,
    }));
  }

  private async getTopDislikes(
    userId: string,
    userEntityId: string,
    limit: number,
  ): Promise<
    Array<{
      entityId: string;
      name: string;
      type: string;
      strength: number;
      relationship: 'DISLIKES';
    }>
  > {
    const results = await this.getTopRelationships(userId, userEntityId, 'DISLIKES', limit);

    return results.map((item) => ({
      ...item,
      relationship: 'DISLIKES' as const,
    }));
  }

  private async getTopRelationships(
    userId: string,
    userEntityId: string,
    relationshipType: 'PREFERS' | 'DISLIKES',
    limit: number,
  ): Promise<PreferenceRelationshipResult[]> {
    const relationships = await this.graphQuery.getRelationships(userId, {
      entityIds: [userEntityId],
      relationshipTypes: [relationshipType],
      direction: 'outbound',
    });

    if (relationships.length === 0) {
      return [];
    }

    const sorted = relationships
      .filter((rel) => rel.relationship_type === relationshipType)
      .sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0))
      .slice(0, limit);

    if (sorted.length === 0) {
      return [];
    }

    const conceptIds = Array.from(new Set(sorted.map((rel) => rel.to_entity_id)));
    const conceptNodes = await this.graphQuery.getNodesByIds(userId, conceptIds);
    const conceptMap = new Map<string, GraphNodeEntity>(conceptNodes.map((node) => [node.entity_id, node]));

    return sorted
      .map((rel) => {
        const concept = conceptMap.get(rel.to_entity_id);
        if (!concept) {
          return null;
        }

        const type = this.extractConceptType(concept);
        const name = concept.name ?? type ?? 'Unknown';

        return {
          entityId: concept.entity_id,
          name,
          type,
          strength: rel.strength ?? 0,
          relationship: relationshipType,
        };
      })
      .filter((value): value is PreferenceRelationshipResult => value !== null);
  }

  /**
   * Get quick stats about user's graph
   */
  private async getQuickStats(userId: string): Promise<{
    totalEntities: number;
  }> {
    const query = `
      SELECT COUNT(*) as count
      FROM entities
      WHERE owner_user_id = $1
        AND is_active = TRUE
    `;

    const result = await this.dataSource.query(query, [userId]);

    return {
      totalEntities: parseInt(result[0]?.count || '0', 10),
    };
  }

  private extractConceptType(node: GraphNodeEntity): string {
    const propertyType = node.properties?.['type'];
    if (typeof propertyType === 'string' && propertyType.trim().length > 0) {
      return propertyType;
    }

    return node.entity_type ?? 'Concept';
  }

  /**
   * Pick important properties to include in context (avoid overwhelming the LLM)
   */
  private pickImportantProperties(properties: Record<string, unknown>): Record<string, unknown> {
    const importantKeys = ['age', 'occupation', 'bio', 'family_role', 'first_name', 'last_name'];

    const picked: Record<string, unknown> = {};
    for (const key of importantKeys) {
      if (properties[key] !== undefined && properties[key] !== null) {
        picked[key] = properties[key];
      }
    }

    return picked;
  }
}

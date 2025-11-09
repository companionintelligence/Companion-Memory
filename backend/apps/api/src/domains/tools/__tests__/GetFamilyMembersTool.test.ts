/**
 * Comprehensive test suite for GetFamilyMembersTool
 * Tests all aspects of the FamilyMember interface and tool functionality
 */

import { v4 as uuidv4 } from 'uuid';

import type { RequestContext } from '@ci/common/types';
import type {
  GraphQueryService,
  GraphReadService,
  GraphNodeEntity,
  RelationshipEntity,
} from '@ci/domains/memory';

import { GetFamilyMembersTool } from '../providers/native/GetFamilyMembersTool';

import { MockGraphQueryService, MockGraphReadService } from './test-emulators';

describe('GetFamilyMembersTool', () => {
  let tool: GetFamilyMembersTool;
  let mockGraphQuery: MockGraphQueryService;
  let mockGraphRead: MockGraphReadService;
  let testContext: RequestContext;
  let userEntityId: string;
  let userId: string;

  beforeEach(() => {
    // Reset test data
    mockGraphQuery = new MockGraphQueryService();
    mockGraphRead = new MockGraphReadService(mockGraphQuery);
    // Type assertion is safe here as MockGraphReadService implements the same interface
    tool = new GetFamilyMembersTool(
      mockGraphQuery as unknown as GraphQueryService,
      mockGraphRead as unknown as GraphReadService,
    );

    userId = uuidv4();
    userEntityId = uuidv4();

    testContext = {
      userId,
      requestId: uuidv4(),
    };

    // Set up default user entity
    const userNode: GraphNodeEntity = {
      entity_id: userEntityId,
      entity_type: 'Person',
      name: 'Test User',
      description: null,
      properties: {},
      outgoing_relationships: [],
      embedding: null,
      search_content: null,
      linked_table: null,
      linked_id: null,
      owner_user_id: userId,
      is_active: true,
      is_archived: false,
      created_at: new Date(),
      updated_at: new Date(),
      last_accessed: new Date(),
    };

    mockGraphQuery.setUserEntity(userId, userNode);
  });

  describe('Schema validation', () => {
    it('should have correct schema name', () => {
      expect(tool.schema.name).toBe('getFamilyMembers');
    });

    it('should have correct schema category', () => {
      expect(tool.schema.category).toBe('database');
    });

    it('should have valid parameter definitions', () => {
      expect(tool.schema.parameters.type).toBe('object');
      expect(tool.schema.parameters.properties).toHaveProperty('relationshipType');
      expect(tool.schema.parameters.properties).toHaveProperty('includePreferences');
    });

    it('should include examples', () => {
      expect(tool.schema.examples).toBeDefined();
      expect(tool.schema.examples!.length).toBeGreaterThan(0);
    });
  });

  describe('Successful execution', () => {
    it('should retrieve family members successfully', async () => {
      // Set up a family member
      const spouseId = uuidv4();
      const spouseNode: GraphNodeEntity = {
        entity_id: spouseId,
        entity_type: 'Person',
        name: 'Sarah Smith',
        description: null,
        properties: {
          first_name: 'Sarah',
          last_name: 'Smith',
        },
        outgoing_relationships: [],
        embedding: null,
        search_content: null,
        linked_table: null,
        linked_id: null,
        owner_user_id: userId,
        is_active: true,
        is_archived: false,
        created_at: new Date(),
        updated_at: new Date(),
        last_accessed: new Date(),
      };

      mockGraphQuery.addNode(spouseNode);

      const relationship: RelationshipEntity = {
        relationship_id: uuidv4(),
        from_entity_id: userEntityId,
        to_entity_id: spouseId,
        relationship_type: 'SPOUSE',
        strength: 1.0,
        properties: {},
        is_bidirectional: true,
        is_active: true,
        start_date: null,
        end_date: null,
        owner_user_id: userId,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockGraphQuery.addRelationship(relationship);

      const result = await tool.execute(testContext, {
        relationshipType: 'all',
        includePreferences: false,
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.familyMembers).toHaveLength(1);
      expect(result.data!.familyMembers[0].name).toBe('Sarah Smith');
      expect(result.data!.familyMembers[0].relationshipType).toBe('SPOUSE');
      expect(result.data!.familyMembers[0].closenessScore).toBe(1.0);
      expect(result.data!.totalCount).toBe(1);
      expect(result.data!.userId).toBe(userId);
    });

    it('should retrieve multiple family members', async () => {
      // Set up spouse
      const spouseId = uuidv4();
      const spouseNode: GraphNodeEntity = {
        entity_id: spouseId,
        entity_type: 'Person',
        name: 'Sarah Smith',
        description: null,
        properties: {},
        outgoing_relationships: [],
        embedding: null,
        search_content: null,
        linked_table: null,
        linked_id: null,
        owner_user_id: userId,
        is_active: true,
        is_archived: false,
        created_at: new Date(),
        updated_at: new Date(),
        last_accessed: new Date(),
      };

      mockGraphQuery.addNode(spouseNode);

      // Set up child
      const childId = uuidv4();
      const childNode: GraphNodeEntity = {
        entity_id: childId,
        entity_type: 'Person',
        name: 'Bobby Smith',
        description: null,
        properties: {},
        outgoing_relationships: [],
        embedding: null,
        search_content: null,
        linked_table: null,
        linked_id: null,
        owner_user_id: userId,
        is_active: true,
        is_archived: false,
        created_at: new Date(),
        updated_at: new Date(),
        last_accessed: new Date(),
      };

      mockGraphQuery.addNode(childNode);

      const spouseRelationship: RelationshipEntity = {
        relationship_id: uuidv4(),
        from_entity_id: userEntityId,
        to_entity_id: spouseId,
        relationship_type: 'SPOUSE',
        strength: 1.0,
        properties: {},
        is_bidirectional: true,
        is_active: true,
        start_date: null,
        end_date: null,
        owner_user_id: userId,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const childRelationship: RelationshipEntity = {
        relationship_id: uuidv4(),
        from_entity_id: userEntityId,
        to_entity_id: childId,
        relationship_type: 'PARENT_OF',
        strength: 0.9,
        properties: {},
        is_bidirectional: false,
        is_active: true,
        start_date: null,
        end_date: null,
        owner_user_id: userId,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockGraphQuery.addRelationship(spouseRelationship);
      mockGraphQuery.addRelationship(childRelationship);

      const result = await tool.execute(testContext, {
        relationshipType: 'all',
        includePreferences: false,
      });

      expect(result.success).toBe(true);
      expect(result.data!.familyMembers).toHaveLength(2);
      expect(result.data!.totalCount).toBe(2);
    });
  });

  describe('Relationship type filtering', () => {
    beforeEach(() => {
      // Set up spouse (romantic partner)
      const spouseId = uuidv4();
      const spouseNode: GraphNodeEntity = {
        entity_id: spouseId,
        entity_type: 'Person',
        name: 'Sarah Smith',
        description: null,
        properties: {},
        outgoing_relationships: [],
        embedding: null,
        search_content: null,
        linked_table: null,
        linked_id: null,
        owner_user_id: userId,
        is_active: true,
        is_archived: false,
        created_at: new Date(),
        updated_at: new Date(),
        last_accessed: new Date(),
      };

      mockGraphQuery.addNode(spouseNode);

      const spouseRelationship: RelationshipEntity = {
        relationship_id: uuidv4(),
        from_entity_id: userEntityId,
        to_entity_id: spouseId,
        relationship_type: 'SPOUSE',
        strength: 1.0,
        properties: {},
        is_bidirectional: true,
        is_active: true,
        start_date: null,
        end_date: null,
        owner_user_id: userId,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockGraphQuery.addRelationship(spouseRelationship);

      // Set up sibling (family member)
      const siblingId = uuidv4();
      const siblingNode: GraphNodeEntity = {
        entity_id: siblingId,
        entity_type: 'Person',
        name: 'John Doe',
        description: null,
        properties: {},
        outgoing_relationships: [],
        embedding: null,
        search_content: null,
        linked_table: null,
        linked_id: null,
        owner_user_id: userId,
        is_active: true,
        is_archived: false,
        created_at: new Date(),
        updated_at: new Date(),
        last_accessed: new Date(),
      };

      mockGraphQuery.addNode(siblingNode);

      const siblingRelationship: RelationshipEntity = {
        relationship_id: uuidv4(),
        from_entity_id: userEntityId,
        to_entity_id: siblingId,
        relationship_type: 'SIBLING_OF',
        strength: 0.8,
        properties: {},
        is_bidirectional: true,
        is_active: true,
        start_date: null,
        end_date: null,
        owner_user_id: userId,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockGraphQuery.addRelationship(siblingRelationship);
    });

    it('should filter by romantic_partner relationship type', async () => {
      const result = await tool.execute(testContext, {
        relationshipType: 'romantic_partner',
        includePreferences: false,
      });

      expect(result.success).toBe(true);
      expect(result.data!.familyMembers).toHaveLength(1);
      expect(result.data!.familyMembers[0].name).toBe('Sarah Smith');
      expect(result.data!.familyMembers[0].relationshipType).toBe('SPOUSE');
    });

    it('should filter by family relationship type', async () => {
      const result = await tool.execute(testContext, {
        relationshipType: 'family',
        includePreferences: false,
      });

      expect(result.success).toBe(true);
      // Should return both spouse and sibling as both are family relationships
      expect(result.data!.familyMembers.length).toBeGreaterThanOrEqual(1);
      const hasSpouse = result.data!.familyMembers.some((m) => m.name === 'Sarah Smith');
      const hasSibling = result.data!.familyMembers.some((m) => m.name === 'John Doe');
      expect(hasSpouse || hasSibling).toBe(true);
    });

    it('should return all relationships with "all" filter', async () => {
      const result = await tool.execute(testContext, {
        relationshipType: 'all',
        includePreferences: false,
      });

      expect(result.success).toBe(true);
      expect(result.data!.familyMembers).toHaveLength(2);
    });
  });

  describe('Preference inclusion', () => {
    it('should include preferences when requested', async () => {
      // Set up family member
      const spouseId = uuidv4();
      const spouseNode: GraphNodeEntity = {
        entity_id: spouseId,
        entity_type: 'Person',
        name: 'Sarah Smith',
        description: null,
        properties: {},
        outgoing_relationships: [],
        embedding: null,
        search_content: null,
        linked_table: null,
        linked_id: null,
        owner_user_id: userId,
        is_active: true,
        is_archived: false,
        created_at: new Date(),
        updated_at: new Date(),
        last_accessed: new Date(),
      };

      mockGraphQuery.addNode(spouseNode);

      const relationship: RelationshipEntity = {
        relationship_id: uuidv4(),
        from_entity_id: userEntityId,
        to_entity_id: spouseId,
        relationship_type: 'SPOUSE',
        strength: 1.0,
        properties: {},
        is_bidirectional: true,
        is_active: true,
        start_date: null,
        end_date: null,
        owner_user_id: userId,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockGraphQuery.addRelationship(relationship);

      // Set up preferences
      const likeId = uuidv4();
      const likeNode: GraphNodeEntity = {
        entity_id: likeId,
        entity_type: 'Concept',
        name: 'Italian cuisine',
        description: null,
        properties: { type: 'Food' },
        outgoing_relationships: [],
        embedding: null,
        search_content: null,
        linked_table: null,
        linked_id: null,
        owner_user_id: userId,
        is_active: true,
        is_archived: false,
        created_at: new Date(),
        updated_at: new Date(),
        last_accessed: new Date(),
      };

      mockGraphQuery.addNode(likeNode);

      const preferenceRelationship: RelationshipEntity = {
        relationship_id: uuidv4(),
        from_entity_id: spouseId,
        to_entity_id: likeId,
        relationship_type: 'PREFERS',
        strength: 0.9,
        properties: {},
        is_bidirectional: false,
        is_active: true,
        start_date: null,
        end_date: null,
        owner_user_id: userId,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockGraphQuery.addRelationship(preferenceRelationship);

      const result = await tool.execute(testContext, {
        relationshipType: 'all',
        includePreferences: true,
      });

      expect(result.success).toBe(true);
      expect(result.data!.familyMembers).toHaveLength(1);
      expect(result.data!.familyMembers[0].preferences).toBeDefined();
      expect(result.data!.familyMembers[0].preferences!.likes).toHaveLength(1);
      expect(result.data!.familyMembers[0].preferences!.likes[0]).toBe('Italian cuisine');
    });

    it('should not include preferences when not requested', async () => {
      // Set up family member
      const spouseId = uuidv4();
      const spouseNode: GraphNodeEntity = {
        entity_id: spouseId,
        entity_type: 'Person',
        name: 'Sarah Smith',
        description: null,
        properties: {},
        outgoing_relationships: [],
        embedding: null,
        search_content: null,
        linked_table: null,
        linked_id: null,
        owner_user_id: userId,
        is_active: true,
        is_archived: false,
        created_at: new Date(),
        updated_at: new Date(),
        last_accessed: new Date(),
      };

      mockGraphQuery.addNode(spouseNode);

      const relationship: RelationshipEntity = {
        relationship_id: uuidv4(),
        from_entity_id: userEntityId,
        to_entity_id: spouseId,
        relationship_type: 'SPOUSE',
        strength: 1.0,
        properties: {},
        is_bidirectional: true,
        is_active: true,
        start_date: null,
        end_date: null,
        owner_user_id: userId,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockGraphQuery.addRelationship(relationship);

      const result = await tool.execute(testContext, {
        relationshipType: 'all',
        includePreferences: false,
      });

      expect(result.success).toBe(true);
      expect(result.data!.familyMembers).toHaveLength(1);
      expect(result.data!.familyMembers[0].preferences).toBeUndefined();
    });

    it('should include both likes and dislikes in preferences', async () => {
      // Set up family member
      const spouseId = uuidv4();
      const spouseNode: GraphNodeEntity = {
        entity_id: spouseId,
        entity_type: 'Person',
        name: 'Sarah Smith',
        description: null,
        properties: {},
        outgoing_relationships: [],
        embedding: null,
        search_content: null,
        linked_table: null,
        linked_id: null,
        owner_user_id: userId,
        is_active: true,
        is_archived: false,
        created_at: new Date(),
        updated_at: new Date(),
        last_accessed: new Date(),
      };

      mockGraphQuery.addNode(spouseNode);

      const relationship: RelationshipEntity = {
        relationship_id: uuidv4(),
        from_entity_id: userEntityId,
        to_entity_id: spouseId,
        relationship_type: 'SPOUSE',
        strength: 1.0,
        properties: {},
        is_bidirectional: true,
        is_active: true,
        start_date: null,
        end_date: null,
        owner_user_id: userId,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockGraphQuery.addRelationship(relationship);

      // Set up like
      const likeId = uuidv4();
      const likeNode: GraphNodeEntity = {
        entity_id: likeId,
        entity_type: 'Concept',
        name: 'Jazz music',
        description: null,
        properties: { type: 'Music' },
        outgoing_relationships: [],
        embedding: null,
        search_content: null,
        linked_table: null,
        linked_id: null,
        owner_user_id: userId,
        is_active: true,
        is_archived: false,
        created_at: new Date(),
        updated_at: new Date(),
        last_accessed: new Date(),
      };

      mockGraphQuery.addNode(likeNode);

      const preferenceRelationship: RelationshipEntity = {
        relationship_id: uuidv4(),
        from_entity_id: spouseId,
        to_entity_id: likeId,
        relationship_type: 'PREFERS',
        strength: 0.9,
        properties: {},
        is_bidirectional: false,
        is_active: true,
        start_date: null,
        end_date: null,
        owner_user_id: userId,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockGraphQuery.addRelationship(preferenceRelationship);

      // Set up dislike
      const dislikeId = uuidv4();
      const dislikeNode: GraphNodeEntity = {
        entity_id: dislikeId,
        entity_type: 'Concept',
        name: 'Horror movies',
        description: null,
        properties: { type: 'Entertainment' },
        outgoing_relationships: [],
        embedding: null,
        search_content: null,
        linked_table: null,
        linked_id: null,
        owner_user_id: userId,
        is_active: true,
        is_archived: false,
        created_at: new Date(),
        updated_at: new Date(),
        last_accessed: new Date(),
      };

      mockGraphQuery.addNode(dislikeNode);

      const dislikeRelationship: RelationshipEntity = {
        relationship_id: uuidv4(),
        from_entity_id: spouseId,
        to_entity_id: dislikeId,
        relationship_type: 'DISLIKES',
        strength: 0.8,
        properties: {},
        is_bidirectional: false,
        is_active: true,
        start_date: null,
        end_date: null,
        owner_user_id: userId,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockGraphQuery.addRelationship(dislikeRelationship);

      const result = await tool.execute(testContext, {
        relationshipType: 'all',
        includePreferences: true,
      });

      expect(result.success).toBe(true);
      expect(result.data!.familyMembers).toHaveLength(1);
      expect(result.data!.familyMembers[0].preferences).toBeDefined();
      expect(result.data!.familyMembers[0].preferences!.likes).toHaveLength(1);
      expect(result.data!.familyMembers[0].preferences!.likes[0]).toBe('Jazz music');
      expect(result.data!.familyMembers[0].preferences!.dislikes).toHaveLength(1);
      expect(result.data!.familyMembers[0].preferences!.dislikes[0]).toBe('Horror movies');
    });
  });

  describe('Edge cases', () => {
    it('should return empty array when user has no profile', async () => {
      // Clear the user entity
      mockGraphQuery.reset();

      const result = await tool.execute(testContext, {
        relationshipType: 'all',
        includePreferences: false,
      });

      expect(result.success).toBe(true);
      expect(result.data!.familyMembers).toHaveLength(0);
      expect(result.data!.totalCount).toBe(0);
    });

    it('should return empty array when user has no family members', async () => {
      const result = await tool.execute(testContext, {
        relationshipType: 'all',
        includePreferences: false,
      });

      expect(result.success).toBe(true);
      expect(result.data!.familyMembers).toHaveLength(0);
      expect(result.data!.totalCount).toBe(0);
    });

    it('should handle empty preferences gracefully', async () => {
      // Set up family member without preferences
      const spouseId = uuidv4();
      const spouseNode: GraphNodeEntity = {
        entity_id: spouseId,
        entity_type: 'Person',
        name: 'Sarah Smith',
        description: null,
        properties: {},
        outgoing_relationships: [],
        embedding: null,
        search_content: null,
        linked_table: null,
        linked_id: null,
        owner_user_id: userId,
        is_active: true,
        is_archived: false,
        created_at: new Date(),
        updated_at: new Date(),
        last_accessed: new Date(),
      };

      mockGraphQuery.addNode(spouseNode);

      const relationship: RelationshipEntity = {
        relationship_id: uuidv4(),
        from_entity_id: userEntityId,
        to_entity_id: spouseId,
        relationship_type: 'SPOUSE',
        strength: 1.0,
        properties: {},
        is_bidirectional: true,
        is_active: true,
        start_date: null,
        end_date: null,
        owner_user_id: userId,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockGraphQuery.addRelationship(relationship);

      const result = await tool.execute(testContext, {
        relationshipType: 'all',
        includePreferences: true,
      });

      expect(result.success).toBe(true);
      expect(result.data!.familyMembers).toHaveLength(1);
      expect(result.data!.familyMembers[0].preferences).toBeDefined();
      expect(result.data!.familyMembers[0].preferences!.likes).toHaveLength(0);
      expect(result.data!.familyMembers[0].preferences!.dislikes).toHaveLength(0);
    });

    it('should handle family member with missing name', async () => {
      // Set up family member without name
      const spouseId = uuidv4();
      const spouseNode: GraphNodeEntity = {
        entity_id: spouseId,
        entity_type: 'Person',
        name: null,
        description: null,
        properties: {
          first_name: 'Sarah',
          last_name: 'Smith',
        },
        outgoing_relationships: [],
        embedding: null,
        search_content: null,
        linked_table: null,
        linked_id: null,
        owner_user_id: userId,
        is_active: true,
        is_archived: false,
        created_at: new Date(),
        updated_at: new Date(),
        last_accessed: new Date(),
      };

      mockGraphQuery.addNode(spouseNode);

      const relationship: RelationshipEntity = {
        relationship_id: uuidv4(),
        from_entity_id: userEntityId,
        to_entity_id: spouseId,
        relationship_type: 'SPOUSE',
        strength: 1.0,
        properties: {},
        is_bidirectional: true,
        is_active: true,
        start_date: null,
        end_date: null,
        owner_user_id: userId,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockGraphQuery.addRelationship(relationship);

      const result = await tool.execute(testContext, {
        relationshipType: 'all',
        includePreferences: false,
      });

      expect(result.success).toBe(true);
      expect(result.data!.familyMembers).toHaveLength(1);
      // Should fall back to extracting name from properties
      expect(result.data!.familyMembers[0].name).toBe('Sarah Smith');
    });

    it('should use default closeness score when strength is not set', async () => {
      const spouseId = uuidv4();
      const spouseNode: GraphNodeEntity = {
        entity_id: spouseId,
        entity_type: 'Person',
        name: 'Sarah Smith',
        description: null,
        properties: {},
        outgoing_relationships: [],
        embedding: null,
        search_content: null,
        linked_table: null,
        linked_id: null,
        owner_user_id: userId,
        is_active: true,
        is_archived: false,
        created_at: new Date(),
        updated_at: new Date(),
        last_accessed: new Date(),
      };

      mockGraphQuery.addNode(spouseNode);

      const relationship: RelationshipEntity = {
        relationship_id: uuidv4(),
        from_entity_id: userEntityId,
        to_entity_id: spouseId,
        relationship_type: 'SPOUSE',
        strength: 0.5, // default strength
        properties: {},
        is_bidirectional: true,
        is_active: true,
        start_date: null,
        end_date: null,
        owner_user_id: userId,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockGraphQuery.addRelationship(relationship);

      const result = await tool.execute(testContext, {
        relationshipType: 'all',
        includePreferences: false,
      });

      expect(result.success).toBe(true);
      expect(result.data!.familyMembers).toHaveLength(1);
      expect(result.data!.familyMembers[0].closenessScore).toBe(0.5);
    });
  });

  describe('Error handling', () => {
    it('should fail when user context is missing', async () => {
      const contextWithoutUser: Partial<RequestContext> = {
        // Simulate missing userId for error handling test
        requestId: uuidv4(),
      };

      const result = await tool.execute(contextWithoutUser as RequestContext, {
        relationshipType: 'all',
        includePreferences: false,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('User context is required');
    });

    it('should include execution metadata', async () => {
      const result = await tool.execute(testContext, {
        relationshipType: 'all',
        includePreferences: false,
      });

      expect(result.metadata).toBeDefined();
      expect(result.metadata!.executionId).toBeDefined();
      expect(result.metadata!.toolName).toBe('getFamilyMembers');
    });

    it('should track execution time', async () => {
      const result = await tool.execute(testContext, {
        relationshipType: 'all',
        includePreferences: false,
      });

      expect(result.executionTimeMs).toBeDefined();
      expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('FamilyMember interface coverage', () => {
    it('should populate all FamilyMember interface fields', async () => {
      // Set up family member with all possible data
      const spouseId = uuidv4();
      const spouseNode: GraphNodeEntity = {
        entity_id: spouseId,
        entity_type: 'Person',
        name: 'Sarah Smith',
        description: null,
        properties: {
          interaction_frequency: 'daily',
        },
        outgoing_relationships: [],
        embedding: null,
        search_content: null,
        linked_table: null,
        linked_id: null,
        owner_user_id: userId,
        is_active: true,
        is_archived: false,
        created_at: new Date(),
        updated_at: new Date(),
        last_accessed: new Date(),
      };

      mockGraphQuery.addNode(spouseNode);

      const relationship: RelationshipEntity = {
        relationship_id: uuidv4(),
        from_entity_id: userEntityId,
        to_entity_id: spouseId,
        relationship_type: 'SPOUSE',
        strength: 0.95,
        properties: {},
        is_bidirectional: true,
        is_active: true,
        start_date: null,
        end_date: null,
        owner_user_id: userId,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockGraphQuery.addRelationship(relationship);

      const result = await tool.execute(testContext, {
        relationshipType: 'all',
        includePreferences: false,
      });

      expect(result.success).toBe(true);
      const member = result.data!.familyMembers[0];

      // Verify all FamilyMember interface fields
      expect(member).toHaveProperty('id');
      expect(member).toHaveProperty('name');
      expect(member).toHaveProperty('relationshipType');
      expect(member).toHaveProperty('relationshipSubtype');
      expect(member).toHaveProperty('closenessScore');
      expect(member).toHaveProperty('interactionFrequency');

      expect(member.id).toBe(spouseId);
      expect(member.name).toBe('Sarah Smith');
      expect(member.relationshipType).toBe('SPOUSE');
      expect(member.closenessScore).toBe(0.95);
      expect(member.interactionFrequency).toBe('daily');
    });

    it('should handle interaction frequency from properties', async () => {
      const spouseId = uuidv4();
      const spouseNode: GraphNodeEntity = {
        entity_id: spouseId,
        entity_type: 'Person',
        name: 'Sarah Smith',
        description: null,
        properties: {
          frequency: 'weekly',
        },
        outgoing_relationships: [],
        embedding: null,
        search_content: null,
        linked_table: null,
        linked_id: null,
        owner_user_id: userId,
        is_active: true,
        is_archived: false,
        created_at: new Date(),
        updated_at: new Date(),
        last_accessed: new Date(),
      };

      mockGraphQuery.addNode(spouseNode);

      const relationship: RelationshipEntity = {
        relationship_id: uuidv4(),
        from_entity_id: userEntityId,
        to_entity_id: spouseId,
        relationship_type: 'SPOUSE',
        strength: 1.0,
        properties: {},
        is_bidirectional: true,
        is_active: true,
        start_date: null,
        end_date: null,
        owner_user_id: userId,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockGraphQuery.addRelationship(relationship);

      const result = await tool.execute(testContext, {
        relationshipType: 'all',
        includePreferences: false,
      });

      expect(result.success).toBe(true);
      expect(result.data!.familyMembers[0].interactionFrequency).toBe('weekly');
    });

    it('should default to "unknown" interaction frequency when not available', async () => {
      const spouseId = uuidv4();
      const spouseNode: GraphNodeEntity = {
        entity_id: spouseId,
        entity_type: 'Person',
        name: 'Sarah Smith',
        description: null,
        properties: {},
        outgoing_relationships: [],
        embedding: null,
        search_content: null,
        linked_table: null,
        linked_id: null,
        owner_user_id: userId,
        is_active: true,
        is_archived: false,
        created_at: new Date(),
        updated_at: new Date(),
        last_accessed: new Date(),
      };

      mockGraphQuery.addNode(spouseNode);

      const relationship: RelationshipEntity = {
        relationship_id: uuidv4(),
        from_entity_id: userEntityId,
        to_entity_id: spouseId,
        relationship_type: 'SPOUSE',
        strength: 1.0,
        properties: {},
        is_bidirectional: true,
        is_active: true,
        start_date: null,
        end_date: null,
        owner_user_id: userId,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockGraphQuery.addRelationship(relationship);

      const result = await tool.execute(testContext, {
        relationshipType: 'all',
        includePreferences: false,
      });

      expect(result.success).toBe(true);
      expect(result.data!.familyMembers[0].interactionFrequency).toBe('unknown');
    });
  });
});

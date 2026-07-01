/**
 * B2 — self-entity resolution.
 *
 * The preference/family tools resolve the current user to a graph node via
 * GraphQueryService.getUserEntity, which requires ci.users.entity_id to be set
 * (and the node to still exist + be active). ReadKnowledgeTool resolves it via
 * raw SQL with a linked_table='users' fallback.
 *
 * These cases prove that when the user has NO linked graph entity, every tool
 * returns a clean empty/warning payload — never a crash.
 */
import { IDS, createGraphToolHarness, seedImporterGraph, type GraphToolHarness } from './graphToolHarness';

describe('graph LLM tools — self-entity resolution (B2)', () => {
  const ctx = { userId: IDS.user };

  describe('user has no linked graph entity (users.entity_id is null)', () => {
    let harness: GraphToolHarness;

    beforeEach(async () => {
      harness = await createGraphToolHarness();
      seedImporterGraph(harness);
      // Sever the user→entity link: the importer's `self` node still exists,
      // but ci.users.entity_id is null and nothing is linked_table='users'.
      harness.userService.setUser(IDS.user, null);
      // Also drop the linked_table backstop ReadKnowledge would otherwise use.
      harness.graph.addNode(IDS.user, {
        entityId: IDS.self,
        entityType: 'Person',
        name: 'Me',
        linkedTable: null,
        linkedId: null,
      });
    });

    it('getUserPreferences returns clean empty with a "user not found" signal', async () => {
      const result = await harness.run('knowledge_preferences', ctx, {});

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.data.totalPreferences).toBe(0);
      expect(result.data.totalDislikes).toBe(0);
      expect(result.data.personName).toBe('User not found');
    });

    it('getEntertainmentPreferences returns clean empty', async () => {
      const result = await harness.run('media_entertainmentPreferences', ctx, {});

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.data.totalPreferences).toBe(0);
      expect(result.data.personName).toBe('User not found');
    });

    it('getFamilyMembers returns clean empty', async () => {
      const result = await harness.run('people_relationships', ctx, {});

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.data).toMatchObject({ familyMembers: [], totalCount: 0, userId: IDS.user });
    });

    it('readKnowledge returns a warning payload (not a throw)', async () => {
      const result = await harness.run('memory_recall', ctx, { useCurrentUser: true });

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.data.nodes).toEqual([]);
      expect(result.data.edges).toEqual([]);
      expect(Array.isArray(result.data.warnings)).toBe(true);
      expect(result.data.warnings.length).toBeGreaterThan(0);
    });
  });

  describe('user row missing but self node still linked via linked_table=users', () => {
    let harness: GraphToolHarness;

    beforeEach(async () => {
      harness = await createGraphToolHarness();
      seedImporterGraph(harness);
      // ci.users row absent, but the importer's `self` node retains its
      // linked_table='users'/linked_id backlink.
      harness.userService.setMissing(IDS.user);
    });

    it('getUserPreferences degrades gracefully (getUserEntity has no linked_table fallback)', async () => {
      // GraphQueryService.getUserEntity reads users.entity_id only, so a missing
      // user row yields a clean empty result for the preference tools.
      const result = await harness.run('knowledge_preferences', ctx, {});

      expect(result.success).toBe(true);
      expect(result.data.personName).toBe('User not found');
    });

    it('readKnowledge recovers via the linked_table=users fallback (well-formed payload)', async () => {
      // ReadKnowledgeTool.resolveCurrentUserEntity has a second query against
      // ci.entities (linked_table=users) that recovers the self node even when
      // the users row / entity_id is gone — so it returns a full payload, not a
      // crash and not a malformed object.
      const result = await harness.run('memory_recall', ctx, { useCurrentUser: true });

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.data.seedEntityIds).toEqual([IDS.self]);
      expect(result.data.nodes.map((n: { id: string }) => n.id)).toContain(IDS.self);
      expect(result.data.warnings).toBeUndefined();
    });
  });

  describe('linked-entity points at a soft-deleted / missing node', () => {
    let harness: GraphToolHarness;

    beforeEach(async () => {
      harness = await createGraphToolHarness();
      seedImporterGraph(harness);
      // users.entity_id points at an id that has no active node.
      harness.userService.setUser(IDS.user, 'deadbeef-0000-0000-0000-000000000000');
    });

    it('getUserPreferences returns clean empty when the linked node is gone', async () => {
      const result = await harness.run('knowledge_preferences', ctx, {});

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.data.personName).toBe('User not found');
    });
  });

  describe('missing user context', () => {
    it('every tool surfaces a structured error (not an uncaught throw) when userId is absent', async () => {
      const harness = await createGraphToolHarness();
      seedImporterGraph(harness);

      for (const name of [
        'knowledge_preferences',
        'media_entertainmentPreferences',
        'people_relationships',
        'memory_recall',
      ]) {
        const result = await harness.run(name, {}, {});
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('EXECUTION_ERROR');
        expect(result.error?.message).toMatch(/user context is required/i);
      }
    });
  });
});

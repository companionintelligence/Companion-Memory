/**
 * B1 — graceful-empty + correctness on the IMPORTER's actual vocabulary.
 *
 * The importer only writes Person/Location/Organization/Concept nodes and
 * KNOWS/MENTIONS edges (see CI-Import-Tools/backend/src/ci-server/graph-sync.ts).
 * It never writes PREFERS/DISLIKES or family edges (SPOUSE/PARENT_OF/…), and the
 * Concepts it writes carry no `properties.type` of `cuisine`/`movie_genre`.
 *
 * These tests prove the preference/family tools return a CLEAN EMPTY result
 * (not an error/throw) on that data, and that readKnowledge surfaces the
 * connected people through the importer's real KNOWS/MENTIONS vocabulary.
 */
import { IDS, createGraphToolHarness, seedImporterGraph, type GraphToolHarness } from './graphToolHarness';

describe('graph LLM tools — graceful empty on imported vocabulary (B1)', () => {
  let harness: GraphToolHarness;
  const ctx = { userId: IDS.user };

  beforeEach(async () => {
    harness = await createGraphToolHarness();
    seedImporterGraph(harness);
  });

  describe('knowledge_preferences', () => {
    it('returns a clean empty result (no error) when no PREFERS/DISLIKES edges exist', async () => {
      const result = await harness.run('knowledge_preferences', ctx, {});

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.data).toMatchObject({
        preferences: [],
        dislikes: [],
        totalPreferences: 0,
        totalDislikes: 0,
        personId: IDS.self,
        personName: 'Me',
      });
    });

    it('returns clean empty for a category filter too', async () => {
      const result = await harness.run('knowledge_preferences', ctx, { category: 'food' });

      expect(result.success).toBe(true);
      expect(result.data.totalPreferences).toBe(0);
      expect(result.data.totalDislikes).toBe(0);
    });
  });

  describe('media_entertainmentPreferences', () => {
    it('returns a clean empty result (no error) when no PREFERS/DISLIKES edges exist', async () => {
      const result = await harness.run('media_entertainmentPreferences', ctx, {});

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.data).toMatchObject({
        preferences: [],
        dislikes: [],
        totalPreferences: 0,
        totalDislikes: 0,
        personId: IDS.self,
        personName: 'Me',
      });
    });
  });

  describe('people_relationships', () => {
    it('returns a clean empty result (no error) when only KNOWS edges exist (no family edges)', async () => {
      const result = await harness.run('people_relationships', ctx, {});

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.data).toMatchObject({
        familyMembers: [],
        totalCount: 0,
        userId: IDS.user,
      });
    });

    it('returns clean empty with includePreferences set (no nested throw)', async () => {
      const result = await harness.run('people_relationships', ctx, { includePreferences: true });

      expect(result.success).toBe(true);
      expect(result.data.totalCount).toBe(0);
    });
  });

  describe('personName resolution on importer vocabulary', () => {
    it('getUserPreferences("my wife") returns "not found" (no SPOUSE edge exists)', async () => {
      const result = await harness.run('knowledge_preferences', ctx, { personName: 'my wife' });

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.data.totalPreferences).toBe(0);
      expect(result.data.personName).toBe('my wife (not found)');
    });

    it('getEntertainmentPreferences resolves a KNOWS contact by name, then returns clean empty prefs', async () => {
      // "Alice" matches a KNOWS contact via the name-based fallback; she has no
      // PREFERS edges, so the tool returns her id with empty preferences.
      const result = await harness.run('media_entertainmentPreferences', ctx, { personName: 'Alice' });

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.data.personId).toBe(IDS.alice);
      expect(result.data.totalPreferences).toBe(0);
      expect(result.data.totalDislikes).toBe(0);
    });

    it('readKnowledge("Alice") resolves the KNOWS contact by name', async () => {
      const result = await harness.run('memory_recall', ctx, {
        personName: 'Alice',
        useCurrentUser: false,
        include: { properties: false, relationships: true, metadata: false },
      });

      expect(result.success).toBe(true);
      expect(result.data.seedEntityIds).toEqual([IDS.alice]);
      expect(result.data.warnings).toBeUndefined();
    });

    it('readKnowledge("Nonexistent Person") returns a warning, not a throw', async () => {
      const result = await harness.run('memory_recall', ctx, {
        personName: 'Nonexistent Person',
        useCurrentUser: false,
      });

      expect(result.success).toBe(true);
      expect(result.data.nodes).toEqual([]);
      expect(result.data.warnings?.[0]).toMatch(/could not find person/i);
    });
  });

  describe('getFamilyMembers includePreferences on a family member with no prefs', () => {
    it('does not throw when a family member has zero PREFERS/DISLIKES', async () => {
      // Add a single SPOUSE edge (family vocabulary) but no preference edges for
      // that spouse, to exercise the includePreferences nested-read path.
      harness.graph.addRelationship(IDS.user, {
        from: IDS.self,
        to: IDS.alice,
        type: 'SPOUSE',
        strength: 1.0,
      });

      const result = await harness.run('people_relationships', ctx, { includePreferences: true });

      expect(result.success).toBe(true);
      expect(result.data.totalCount).toBe(1);
      expect(result.data.familyMembers[0].preferences).toEqual({ likes: [], dislikes: [] });
    });
  });

  describe('readKnowledge — importer vocabulary (KNOWS / MENTIONS)', () => {
    it('returns connected people via KNOWS/MENTIONS when relationshipTypes is omitted', async () => {
      const result = await harness.run('memory_recall', ctx, {
        useCurrentUser: true,
        include: { properties: false, relationships: true, metadata: false },
      });

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();

      const nodeIds = result.data.nodes.map((n: { id: string }) => n.id).sort();
      // self + the two KNOWS contacts + the MENTIONS organization.
      expect(nodeIds).toEqual([IDS.self, IDS.alice, IDS.bob, IDS.acme].sort());

      const edgeTypes = result.data.edges.map((e: { type: string }) => e.type).sort();
      expect(edgeTypes).toEqual(['KNOWS', 'KNOWS', 'MENTIONS']);

      // The KNOWS edges connect the user to the named contacts.
      const knowsTargets = result.data.edges
        .filter((e: { type: string }) => e.type === 'KNOWS')
        .map((e: { to: { name: string | null } }) => e.to.name)
        .sort();
      expect(knowsTargets).toEqual(['Alice Example', 'Bob Example']);

      expect(result.data.warnings).toBeUndefined();
    });

    it('returns the self node alone (no warning) when filtered to PREFERS, which the importer never writes', async () => {
      const result = await harness.run('memory_recall', ctx, {
        useCurrentUser: true,
        relationshipTypes: ['PREFERS'],
        include: { properties: false, relationships: true, metadata: false },
      });

      expect(result.success).toBe(true);
      // Seed node is still returned (ensuredSeedNodes), but no PREFERS edges exist.
      expect(result.data.nodes.map((n: { id: string }) => n.id)).toEqual([IDS.self]);
      expect(result.data.edges).toEqual([]);
      expect(result.data.stats.edgeCount).toBe(0);
    });
  });
});

/**
 * B4 — deterministic harness smoke + correctness.
 *
 * Drives each graph tool through the real ToolRegistry.executeTool path against
 * a tiny, deterministic graph (user-self Person + contacts via KNOWS, an
 * Organization via MENTIONS, typed Concepts). The "imported vocabulary" half of
 * the fixture is exercised by graphTools.gracefulEmpty.test.ts; here we add the
 * ENRICHED vocabulary (PREFERS/DISLIKES + SPOUSE) to prove the tools light up
 * with correct shape + content once the vocabulary gap is closed.
 */
import {
  IDS,
  createGraphToolHarness,
  seedEnrichedGraph,
  seedImporterGraph,
  type GraphToolHarness,
} from './graphToolHarness';

describe('graph LLM tools — registry harness (B4)', () => {
  const ctx = { userId: IDS.user };

  it('registers every native graph tool by name', async () => {
    const harness = await createGraphToolHarness();
    const names = harness.registry.getRegisteredToolNames().sort();

    expect(names).toEqual(
      [
        'media_entertainmentPreferences',
        'people_relationships',
        'knowledge_preferences',
        'memory_recall',
      ].sort(),
    );
  });

  it('returns TOOL_NOT_FOUND (not a throw) for an unknown tool', async () => {
    const harness = await createGraphToolHarness();
    const result = await harness.registry.executeTool('doesNotExist', ctx, {});

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('TOOL_NOT_FOUND');
  });

  describe('with enriched vocabulary (PREFERS / SPOUSE present)', () => {
    let harness: GraphToolHarness;

    beforeEach(async () => {
      harness = await createGraphToolHarness();
      seedImporterGraph(harness);
      seedEnrichedGraph(harness);
    });

    it('getUserPreferences returns the typed PREFERS concepts, sorted by strength', async () => {
      const result = await harness.run('knowledge_preferences', ctx, { category: 'all' });

      expect(result.success).toBe(true);
      expect(result.data.totalPreferences).toBe(2);
      expect(result.data.totalDislikes).toBe(0);
      // Sorted by descending strength: Italian (0.9) before Science Fiction (0.85).
      expect(result.data.preferences.map((p: { name: string }) => p.name)).toEqual([
        'Italian',
        'Science Fiction',
      ]);
      expect(result.data.preferences[0]).toMatchObject({
        id: IDS.italian,
        type: 'cuisine',
        relationship: 'PREFERS',
        strength: 0.9,
      });
    });

    it('getUserPreferences honours the food category filter', async () => {
      const result = await harness.run('knowledge_preferences', ctx, { category: 'food' });

      expect(result.data.preferences.map((p: { type: string }) => p.type)).toEqual(['cuisine']);
    });

    it('getEntertainmentPreferences returns only media-typed concepts', async () => {
      const result = await harness.run('media_entertainmentPreferences', ctx, { mediaType: 'movies' });

      expect(result.success).toBe(true);
      expect(result.data.preferences.map((p: { name: string }) => p.name)).toEqual(['Science Fiction']);
      expect(result.data.preferences[0]).toMatchObject({ type: 'movie_genre', relationship: 'PREFERS' });
    });

    it('getFamilyMembers returns the SPOUSE contact', async () => {
      const result = await harness.run('people_relationships', ctx, { includePreferences: false });

      expect(result.success).toBe(true);
      expect(result.data.totalCount).toBe(1);
      expect(result.data.familyMembers[0]).toMatchObject({
        id: IDS.alice,
        name: 'Alice Example',
        relationshipType: 'SPOUSE',
        closenessScore: 1.0,
      });
    });

    it('readKnowledge resolves "my wife" via the SPOUSE edge', async () => {
      const result = await harness.run('memory_recall', ctx, {
        personName: 'my wife',
        useCurrentUser: false,
        relationshipTypes: ['SPOUSE', 'PREFERS'],
        include: { properties: true, relationships: true, metadata: false },
      });

      expect(result.success).toBe(true);
      expect(result.data.seedEntityIds).toEqual([IDS.alice]);
      const nodeIds = result.data.nodes.map((n: { id: string }) => n.id);
      expect(nodeIds).toContain(IDS.alice);
    });

    it('readKnowledge can find typed concepts via filters + inbound PREFERS', async () => {
      const result = await harness.run('memory_recall', ctx, {
        useCurrentUser: false,
        filters: { entityType: 'Concept', propertyEquals: { type: 'cuisine' } },
        relationshipTypes: ['PREFERS'],
        traversal: { direction: 'inbound', maxDepth: 1, maxNodes: 25, maxEdges: 50 },
        include: { properties: true, relationships: true, metadata: false },
      });

      expect(result.success).toBe(true);
      expect(result.data.seedEntityIds).toEqual([IDS.italian]);
      // Inbound PREFERS reaches the user-self node.
      const nodeIds = result.data.nodes.map((n: { id: string }) => n.id).sort();
      expect(nodeIds).toEqual([IDS.italian, IDS.self].sort());
      expect(result.data.edges[0]).toMatchObject({ type: 'PREFERS', from: { id: IDS.self } });
    });
  });

  describe('result envelope shape', () => {
    it('wraps successful executions with success/data/executionTimeMs/metadata', async () => {
      const harness = await createGraphToolHarness();
      seedImporterGraph(harness);

      const result = await harness.run('memory_recall', ctx, { useCurrentUser: true });

      expect(result).toMatchObject({
        success: true,
        // metadata.toolName carries the tool's schema name — the dotted intent id.
        metadata: { toolName: 'memory.recall' },
      });
      expect(typeof result.executionTimeMs).toBe('number');
      expect(result.metadata?.executionId).toBeTruthy();
    });
  });
});

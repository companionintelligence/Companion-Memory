import type { GraphEntityInputDto, GraphRelationshipInputDto } from '@ci/domains/graph';

import {
  FAMILY_RELATIONSHIP_TYPES,
  GraphEnrichmentService,
  PREFERENCE_CONCEPT_TYPES,
  type LlmExtraction,
} from './GraphEnrichmentService';

interface IngestBatch {
  entities: GraphEntityInputDto[];
  relationships: GraphRelationshipInputDto[];
}

/** Read the ingest batch passed in a given mocked GraphIngestService.ingest call. */
function batchOf(ingest: jest.Mock, callIndex: number): IngestBatch {
  return ingest.mock.calls[callIndex][1] as IngestBatch;
}

const USER = '00000000-0000-0000-0000-0000000000aa';
const SELF = '00000000-0000-0000-0000-0000000000ff';
const SPOUSE_ID = '00000000-0000-0000-0000-0000000000b1';
const SIBLING_ID = '00000000-0000-0000-0000-0000000000b2';

interface CommRow {
  subject: string | null;
  content: string | null;
  summary: string | null;
}

interface EventRow {
  title: string | null;
  description: string | null;
}

/**
 * DataSource whose query() serves canned communication + event rows so the
 * sampler returns deterministic content; everything downstream of the LLM is
 * what we assert on.
 */
function makeDataSource(comms: CommRow[], events: EventRow[]) {
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('FROM ci.communications')) {
      return comms;
    }

    if (sql.includes('FROM ci.events')) {
      return events;
    }

    return [];
  });

  return { dataSource: { query }, query };
}

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

/**
 * Build the service with the LLM, ingest, and Person-resolution all stubbed.
 * `extraction` is what the (mocked) LLM "returns"; `persons` maps a lower-cased
 * name to the entity_id that GraphQueryService.getNodes should resolve it to
 * (absent => no Person node, so the relation is skipped).
 */
function makeService(opts: {
  comms?: CommRow[];
  events?: EventRow[];
  extraction: LlmExtraction;
  persons?: Record<string, string>;
}) {
  const { dataSource, query } = makeDataSource(opts.comms ?? [], opts.events ?? []);

  const chat = jest.fn().mockResolvedValue({
    message: { role: 'assistant', content: JSON.stringify(opts.extraction) },
  });
  const ollamaService = { chat };

  const ingest = jest.fn(async (_ctx: unknown, input: { entities: unknown[]; relationships: unknown[] }) => ({
    entitiesProcessed: input.entities.length,
    relationshipsProcessed: input.relationships.length,
    errors: [],
  }));
  const graphIngestService = { ingest };

  const persons = opts.persons ?? {};
  const getNodes = jest.fn(async (_userId: string, options: { nameContains?: string }) => {
    const id = persons[(options.nameContains ?? '').toLowerCase()];

    return id ? [{ entity_id: id, name: options.nameContains, entity_type: 'Person' }] : [];
  });
  const graphQuery = { getNodes };

  const personalizationService = {
    decideAction: jest.fn().mockResolvedValue('auto'),
  };

  const service = new GraphEnrichmentService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dataSource as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ollamaService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    graphIngestService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    graphQuery as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    personalizationService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    makeLogger() as any,
  );

  return { service, chat, ingest, getNodes, query };
}

describe('GraphEnrichmentService.buildPreferenceInput (parse -> graph-input mapping)', () => {
  it('emits Concept nodes whose properties.type is the tool vocab + self PREFERS/DISLIKES edges', () => {
    const input = GraphEnrichmentService.buildPreferenceInput([
      { concept: 'Italian', type: 'cuisine', sentiment: 'like' },
      { concept: 'Horror', type: 'movie_genre', sentiment: 'dislike' },
    ]);

    expect(input.entities).toHaveLength(2);

    const italian = input.entities[0];
    expect(italian.entityType).toBe('Concept'); // satisfies entity_type ~ '^[A-Z][A-Za-z]*$'
    expect(italian.name).toBe('Italian');
    // GraphReadService.extractConceptType reads properties.type; the tools filter on it.
    expect(italian.properties?.type).toBe('cuisine');

    // self -> Concept edges, PREFERS for like / DISLIKES for dislike.
    expect(input.relationships).toEqual([
      expect.objectContaining({ fromKey: 'self', type: 'PREFERS' }),
      expect.objectContaining({ fromKey: 'self', type: 'DISLIKES' }),
    ]);
    // Edge target key matches the Concept entity key so ingest wires them in-batch.
    expect(input.relationships[0].toKey).toBe(input.entities[0].key);
    expect(input.relationships[1].toKey).toBe(input.entities[1].key);

    // Edge type satisfies relationship_type ~ '^[A-Z_][A-Z0-9_]*$'.
    for (const rel of input.relationships) {
      expect(rel.type).toMatch(/^[A-Z_][A-Z0-9_]*$/);
    }
  });

  it('is re-runnable: the same preference yields the same Concept key', () => {
    const a = GraphEnrichmentService.buildPreferenceInput([
      { concept: 'Jazz', type: 'music_genre', sentiment: 'like' },
    ]);
    const b = GraphEnrichmentService.buildPreferenceInput([
      { concept: 'Jazz', type: 'music_genre', sentiment: 'like' },
    ]);

    expect(a.entities[0].key).toBe(b.entities[0].key);
  });
});

describe('GraphEnrichmentService.cleanExtraction', () => {
  it('keeps only types in the tool vocab and normalizes case', () => {
    const { preferences } = GraphEnrichmentService.cleanExtraction({
      preferences: [
        { concept: 'Sushi', type: 'CUISINE', sentiment: 'like' },
        { concept: 'Politics', type: 'topic', sentiment: 'dislike' }, // unknown type -> dropped
      ],
      familyRelations: [],
      generalRelations: [],
    });

    expect(preferences).toEqual([{ concept: 'Sushi', type: 'cuisine', sentiment: 'like' }]);
  });

  it('keeps only family relationship types in the family-tool vocab and upper-cases them', () => {
    const { family } = GraphEnrichmentService.cleanExtraction({
      preferences: [],
      familyRelations: [
        { person: 'Liam', relatedPerson: 'Sarah', relationship: 'spouse' },
        { person: 'Liam', relatedPerson: 'Bob', relationship: 'coworker' }, // not family -> dropped
        { person: 'Liam', relatedPerson: 'Liam', relationship: 'SPOUSE' }, // self-ref -> dropped
      ],
      generalRelations: [],
    });

    expect(family).toEqual([
      { person: 'Liam', relatedPerson: 'Sarah', relationship: 'SPOUSE', confidence: 0.75 },
    ]);
    // The relationship type is one the family tool queries.
    expect(FAMILY_RELATIONSHIP_TYPES).toContain(family[0].relationship);
  });
});

describe('GraphEnrichmentService.parseLlmContent', () => {
  it('tolerates markdown fences and leading prose', () => {
    const raw =
      'Sure!\n```json\n{ "preferences": [{"concept":"Thai","type":"cuisine","sentiment":"like"}] }\n```';
    const parsed = GraphEnrichmentService.parseLlmContent(raw);

    expect(parsed.preferences).toEqual([{ concept: 'Thai', type: 'cuisine', sentiment: 'like' }]);
    expect(parsed.familyRelations).toEqual([]);
    expect(parsed.generalRelations).toEqual([]);
  });

  it('returns empty arrays on malformed JSON', () => {
    expect(GraphEnrichmentService.parseLlmContent('not json at all')).toEqual({
      preferences: [],
      familyRelations: [],
      generalRelations: [],
    });
  });
});

describe('GraphEnrichmentService.enrich (end-to-end with mocked LLM)', () => {
  it('writes preferences as Concept nodes + self edges through bulkIngestGraph', async () => {
    const { service, ingest, chat } = makeService({
      comms: [{ subject: 'Dinner', content: 'I love Italian food, hate seafood', summary: null }],
      extraction: {
        preferences: [
          { concept: 'Italian', type: 'cuisine', sentiment: 'like' },
          { concept: 'Seafood', type: 'food', sentiment: 'dislike' },
        ],
        familyRelations: [],
        generalRelations: [],
      },
    });

    const result = await service.enrich(USER, { maxEvents: 0 });

    expect(chat).toHaveBeenCalledTimes(1);
    expect(result.preferencesExtracted).toBe(2);
    expect(result.conceptsWritten).toBe(2);
    expect(result.preferenceEdgesWritten).toBe(2);

    // The preference batch is the first ingest call.
    const prefBatch = batchOf(ingest, 0);
    expect(prefBatch.entities.every((e) => e.entityType === 'Concept')).toBe(true);
    const types = prefBatch.entities.map((e) => e.properties?.type);
    expect(types).toEqual(['cuisine', 'food']);
    expect(prefBatch.relationships.map((r) => r.type)).toEqual(['PREFERS', 'DISLIKES']);
    expect(prefBatch.relationships.every((r) => r.fromKey === 'self')).toBe(true);
  });

  it('resolves the SPOUSE/family path between EXISTING Person nodes and writes the edge', async () => {
    const { service, ingest, getNodes } = makeService({
      comms: [{ subject: null, content: 'Sarah is my wife. My sister Emma visited.', summary: null }],
      extraction: {
        preferences: [],
        familyRelations: [
          { person: 'Liam', relatedPerson: 'Sarah', relationship: 'SPOUSE' },
          { person: 'Liam', relatedPerson: 'Emma', relationship: 'SIBLING_OF' },
        ],
        generalRelations: [],
      },
      persons: { liam: SELF, sarah: SPOUSE_ID, emma: SIBLING_ID },
    });

    const result = await service.enrich(USER, { maxEvents: 0 });

    expect(getNodes).toHaveBeenCalled();
    expect(result.familyRelationsExtracted).toBe(2);
    expect(result.familyRelationsResolved).toBe(2);
    expect(result.familyEdgesWritten).toBe(2);

    // Family batch is the (only) ingest call here — no Concept entities, edges
    // reference the resolved Person ids directly (pre-resolved endpoints).
    const familyBatch = batchOf(ingest, 0);
    expect(familyBatch.entities).toHaveLength(0);
    expect(familyBatch.relationships).toEqual([
      expect.objectContaining({
        type: 'SPOUSE',
        fromEntityId: SELF,
        fromEntityType: 'Person',
        toEntityId: SPOUSE_ID,
        toEntityType: 'Person',
      }),
      expect.objectContaining({
        type: 'SIBLING_OF',
        fromEntityId: SELF,
        toEntityId: SIBLING_ID,
      }),
    ]);
    // Edge types are exactly what GetFamilyMembersTool queries.
    for (const rel of familyBatch.relationships) {
      expect(FAMILY_RELATIONSHIP_TYPES).toContain(rel.type);
      expect(rel.type).toMatch(/^[A-Z_][A-Z0-9_]*$/);
    }
  });

  it('skips a family relation when a person is not in the graph (never invents Person nodes)', async () => {
    const { service, ingest } = makeService({
      comms: [{ subject: null, content: 'My spouse Dana.', summary: null }],
      extraction: {
        preferences: [],
        familyRelations: [{ person: 'Liam', relatedPerson: 'Dana', relationship: 'SPOUSE' }],
        generalRelations: [],
      },
      persons: { liam: SELF }, // Dana has no Person node
    });

    const result = await service.enrich(USER, { maxEvents: 0 });

    expect(result.familyRelationsExtracted).toBe(1);
    expect(result.familyRelationsResolved).toBe(0);
    expect(result.familyEdgesWritten).toBe(0);
    // Nothing to write -> ingest is never called.
    expect(ingest).not.toHaveBeenCalled();
  });

  it('no-ops cleanly when there are no sampled records', async () => {
    const { service, chat, ingest } = makeService({
      comms: [],
      events: [],
      extraction: { preferences: [], familyRelations: [], generalRelations: [] },
    });

    const result = await service.enrich(USER);

    expect(result.sampledRecords).toBe(0);
    expect(chat).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });
});

describe('vocabulary alignment with the graph tools', () => {
  it('exposes the concept types the preference tools filter on', () => {
    // Spot-check the load-bearing values the tools' CATEGORY_TYPE_MAP / MEDIA_TYPE_MAP use.
    for (const t of ['cuisine', 'food', 'movie_genre', 'music_genre', 'book_genre']) {
      expect(PREFERENCE_CONCEPT_TYPES).toContain(t);
    }
  });
});

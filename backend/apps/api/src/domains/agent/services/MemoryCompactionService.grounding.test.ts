import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { RelationshipService } from '@ci/domains/graph';
import type { OllamaService } from '@ci/domains/llm';
import type {
  ConceptService,
  ItemService,
  PersonService,
  PlaceService,
  UserContextService,
} from '@ci/domains/memory';

import type { AgentMemory } from '../entities/AgentMemoryEntity';

import type { AgentMemoryService } from './AgentMemoryService';
import { MemoryCompactionService, isNameGrounded } from './MemoryCompactionService';

/**
 * gemma3:270m, the utility model the Hub hands out, answered four agent notes
 * about a coffee order, two towns and a spare key with the extraction prompt's
 * own few-shot example. Compaction stored the person "Anita" as the user's
 * sister, "Foster + Partners" and "London", with SIBLING_OF and WORKS_AT, and
 * marked the real notes processed. Chat then answered "Who is my family" with
 * "your sibling is Anita". Nothing checked that an extracted name is in the
 * notes at all.
 */

const USER_ID = 'user-1';
const SELF_ID = 'self-entity';
const CONTEXT = { userId: USER_ID } as UserServiceContext;

const NOTES = [
  'My hb test drink is an oat milk flat white.',
  'The user lives in Brackenfold.',
  'The user now lives in Tullowmere.',
  "The user's spare key is under the blue flowerpot.",
];

/** What gemma3:270m returned for NOTES: the prompt's example, word for word. */
const PROMPT_EXAMPLE = {
  entities: [
    {
      type: 'person',
      name: 'Anita',
      description: "the user's sister; an architect who works at Foster + Partners",
    },
    {
      type: 'place',
      name: 'Foster + Partners',
      description: 'an architecture firm in London where Anita works',
    },
    { type: 'place', name: 'London', description: 'city where Foster + Partners is located' },
  ],
  relationships: [
    {
      fromName: 'the user',
      fromType: 'person',
      toName: 'Anita',
      toType: 'person',
      relationshipType: 'SIBLING_OF',
    },
    {
      fromName: 'Anita',
      fromType: 'person',
      toName: 'Foster + Partners',
      toType: 'place',
      relationshipType: 'WORKS_AT',
    },
  ],
};

/** What qwen3.5:9b returned for the same notes on the same stack. */
const REAL_EXTRACTION = {
  entities: [
    { type: 'item', name: 'oat milk flat white', description: "the user's hb test drink" },
    { type: 'place', name: 'Brackenfold', description: 'a place where the user lived' },
    { type: 'place', name: 'Tullowmere', description: 'a place where the user now lives' },
    { type: 'item', name: 'spare key', description: 'an item that is under the blue flowerpot' },
  ],
  relationships: [
    {
      fromName: 'the user',
      fromType: 'person',
      toName: 'Tullowmere',
      toType: 'place',
      relationshipType: 'LIVES_IN',
    },
  ],
};

function makeFragment(id: string, content: string): AgentMemory {
  return {
    id,
    userId: USER_ID,
    sessionId: null,
    source: 'memory',
    title: null,
    content,
    processedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as AgentMemory;
}

function makeService(replies: object[]) {
  const chat = jest.fn(async () => ({
    message: { content: JSON.stringify(replies.length > 1 ? replies.shift() : replies[0]) },
  }));
  const created: string[] = [];
  const create = (prefix: string) =>
    jest.fn(async (_ctx: unknown, data: { name: string }) => {
      created.push(data.name);

      return { id: `${prefix}-${data.name}`, name: data.name };
    });

  const personService = {
    search: jest.fn().mockResolvedValue([]),
    create: create('person'),
    update: jest.fn(),
    findAll: jest.fn().mockResolvedValue([]),
  } as unknown as PersonService;
  const conceptService = { search: jest.fn().mockResolvedValue([]), create: create('concept') };
  const createPlace = create('place');
  // PlaceService.create answers with an array of rows.
  const placeService = {
    create: jest.fn(async (ctx: unknown, data: { name: string }) => [await createPlace(ctx, data)]),
  };
  const itemService = { create: create('item'), findAll: jest.fn().mockResolvedValue([]) };
  const relationshipService = {
    resolveType: jest.fn((type: string) => type),
    upsert: jest.fn(),
  };
  const userContext = {
    getSelfIdentity: jest
      .fn()
      .mockResolvedValue({ entityId: SELF_ID, aliases: ['the user', 'user', 'hb tester'] }),
  } as unknown as UserContextService;
  const markProcessed = jest.fn();
  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  };

  const service = new MemoryCompactionService(
    { chat } as unknown as OllamaService,
    { markProcessed } as unknown as AgentMemoryService,
    personService,
    conceptService as unknown as ConceptService,
    userContext,
    placeService as unknown as PlaceService,
    itemService as unknown as ItemService,
    relationshipService as unknown as RelationshipService,
    logger as unknown as LoggerService,
  );

  return { service, chat, created, relationshipService, markProcessed, logger };
}

const fragments = () => NOTES.map((content, i) => makeFragment(`frag-${i}`, content));
const processed = (markProcessed: jest.Mock) =>
  markProcessed.mock.calls.flatMap((call) => call[1] as string[]);

describe('isNameGrounded', () => {
  const text = NOTES.join('\n');

  it('finds names written in the notes, whatever the case, order, punctuation or plural', () => {
    expect(isNameGrounded('Brackenfold', text)).toBe(true);
    expect(isNameGrounded('Oat Milk Flat White', text)).toBe(true);
    expect(isNameGrounded('flat white, oat milk', text)).toBe(true);
    expect(isNameGrounded('blue flowerpots', text)).toBe(true);
    expect(isNameGrounded('the spare key', text)).toBe(true);
    expect(isNameGrounded('Foster + Partners', 'She works at Foster + Partners.')).toBe(true);
    expect(isNameGrounded('Zoë', 'lunch with Zoe')).toBe(true);
  });

  it('refuses names that are not there, in whole or in part', () => {
    expect(isNameGrounded('Anita', text)).toBe(false);
    expect(isNameGrounded('Foster + Partners', text)).toBe(false);
    expect(isNameGrounded('London', text)).toBe(false);
    expect(isNameGrounded('red flowerpot', text)).toBe(false);
    expect(isNameGrounded('', text)).toBe(false);
  });
});

describe('MemoryCompactionService keeps only names that are in the notes', () => {
  it("stores nothing from the prompt's example and leaves the notes for another try", async () => {
    const { service, created, relationshipService, markProcessed, logger } = makeService([PROMPT_EXAMPLE]);

    await service.compactForUser(CONTEXT, fragments());

    expect(created).toEqual([]);
    expect(relationshipService.upsert).not.toHaveBeenCalled();
    expect(processed(markProcessed)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      'Dropped extracted names that are not in the memory fragments',
      expect.objectContaining({
        droppedEntities: ['Anita', 'Foster + Partners', 'London'],
        droppedRelationships: 2,
      }),
    );
  });

  it('marks the notes processed once the retry budget is spent, still without storing the example', async () => {
    const { service, created, markProcessed } = makeService([PROMPT_EXAMPLE]);

    for (let run = 0; run < 3; run++) {
      await service.compactForUser(CONTEXT, fragments());
    }

    expect(created).toEqual([]);
    expect(processed(markProcessed)).toEqual(['frag-0', 'frag-1', 'frag-2', 'frag-3']);
  });

  it('stores a real extraction as before, with its link to the user', async () => {
    const { service, created, relationshipService, markProcessed } = makeService([REAL_EXTRACTION]);

    await service.compactForUser(CONTEXT, fragments());

    expect(created).toEqual(['oat milk flat white', 'Brackenfold', 'Tullowmere', 'spare key']);
    expect(relationshipService.upsert).toHaveBeenCalledTimes(1);
    expect(relationshipService.upsert).toHaveBeenCalledWith(
      CONTEXT,
      expect.objectContaining({ fromNodeId: SELF_ID, toNodeId: 'place-Tullowmere', type: 'LIVES_IN' }),
    );
    expect(processed(markProcessed)).toEqual(['frag-0', 'frag-1', 'frag-2', 'frag-3']);
  });

  it('keeps the real names from a mixed answer and drops the invented ones with their links', async () => {
    const mixed = {
      entities: [...REAL_EXTRACTION.entities, ...PROMPT_EXAMPLE.entities],
      relationships: [...REAL_EXTRACTION.relationships, ...PROMPT_EXAMPLE.relationships],
    };
    const { service, created, relationshipService, markProcessed } = makeService([mixed]);

    await service.compactForUser(CONTEXT, fragments());

    expect(created).toEqual(['oat milk flat white', 'Brackenfold', 'Tullowmere', 'spare key']);
    expect(relationshipService.upsert).toHaveBeenCalledTimes(1);
    expect(processed(markProcessed)).toEqual(['frag-0', 'frag-1', 'frag-2', 'frag-3']);
  });

  it('still treats an empty answer as "nothing to extract"', async () => {
    const { service, created, markProcessed } = makeService([{ entities: [], relationships: [] }]);

    await service.compactForUser(CONTEXT, fragments());

    expect(created).toEqual([]);
    expect(processed(markProcessed)).toEqual(['frag-0', 'frag-1', 'frag-2', 'frag-3']);
  });
});

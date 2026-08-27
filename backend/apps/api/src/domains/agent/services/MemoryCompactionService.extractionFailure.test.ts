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
import { MemoryCompactionService } from './MemoryCompactionService';

/**
 * A failed extraction must not look like an empty one.
 *
 * `parseExtractionResult` used to return `{entities: [], relationships: []}`
 * whenever the model's reply was truncated or unparseable. That empty result
 * counted as a completed batch, so `markProcessed` stamped `processed_at` and
 * the fragment was never retried — the content was silently lost. These tests
 * pin the distinction: unparseable output leaves the fragment unstamped for
 * the next run, a valid-but-empty extraction stamps it, and a fragment that
 * keeps failing eventually gets stamped anyway so it cannot loop forever.
 */

const USER_ID = 'user-1';
const CONTEXT = { userId: USER_ID } as UserServiceContext;

/** Valid JSON object, no entities: the model saying "nothing here". */
const EMPTY_EXTRACTION = JSON.stringify({ entities: [], relationships: [] });

/** Model ran out of tokens mid-object — never closes the brace. */
const TRUNCATED_EXTRACTION = '{"entities": [{"type": "person", "name": "Pri';

/** Model ignored the JSON instruction entirely. */
const PROSE_EXTRACTION = 'Sure! I found one person in these fragments.';

/** Closes the brace, but the body is not valid JSON — JSON.parse throws. */
const MALFORMED_EXTRACTION = '{"entities": ["unclosed}';

function makeFragment(id: string): AgentMemory {
  return {
    id,
    userId: USER_ID,
    sessionId: null,
    source: 'memory',
    title: null,
    content: `fragment body for ${id}`,
    processedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as AgentMemory;
}

/**
 * Drives the real `compactForUser` with the LLM call stubbed. `contents` is
 * consumed one entry per batch, so a multi-batch run can mix a good batch with
 * a broken one; the last entry repeats if the run needs more batches.
 */
function makeService(contents: string[]) {
  const chat = jest.fn(async () => {
    const content = contents.length > 1 ? (contents.shift() as string) : (contents[0] as string);

    return { message: { content } };
  });

  const ollamaService = { chat } as unknown as OllamaService;

  const personCreate = jest.fn(async (_ctx: unknown, data: { name: string }) => ({
    id: `created-${data.name.toLowerCase()}`,
    name: data.name,
  }));

  const personService = {
    search: jest.fn().mockResolvedValue([]),
    create: personCreate,
    update: jest.fn(),
    findAll: jest.fn().mockResolvedValue([]),
  } as unknown as PersonService;

  const conceptService = {
    search: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({ id: 'concept-1' }),
  } as unknown as ConceptService;

  const userContext = {
    getSelfIdentity: jest.fn().mockResolvedValue(null),
  } as unknown as UserContextService;

  const placeService = { create: jest.fn() } as unknown as PlaceService;
  const itemService = { create: jest.fn() } as unknown as ItemService;
  const relationshipService = {
    resolveType: jest.fn().mockReturnValue(null),
    upsert: jest.fn(),
  } as unknown as RelationshipService;

  const markProcessed = jest.fn();
  const agentMemoryService = { markProcessed } as unknown as AgentMemoryService;

  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  } as unknown as LoggerService;

  const service = new MemoryCompactionService(
    ollamaService,
    agentMemoryService,
    personService,
    conceptService,
    userContext,
    placeService,
    itemService,
    relationshipService,
    logger,
  );

  return { service, markProcessed, chat, personCreate };
}

/** The id list handed to markProcessed across all of its calls. */
function processedIds(markProcessed: jest.Mock): string[] {
  return markProcessed.mock.calls.flatMap((call) => call[1] as string[]);
}

describe('MemoryCompactionService — failed extraction vs empty extraction', () => {
  it.each([
    ['truncated', TRUNCATED_EXTRACTION],
    ['non-JSON prose', PROSE_EXTRACTION],
    ['closed but malformed JSON', MALFORMED_EXTRACTION],
  ])('does NOT mark a fragment processed when the model output is %s', async (_label, content) => {
    const { service, markProcessed } = makeService([content]);

    await service.compactForUser(CONTEXT, [makeFragment('frag-1')]);

    expect(markProcessed).not.toHaveBeenCalled();
  });

  it('DOES mark a fragment processed when the model returns a valid but empty extraction', async () => {
    const { service, markProcessed, personCreate } = makeService([EMPTY_EXTRACTION]);

    await service.compactForUser(CONTEXT, [makeFragment('frag-1')]);

    expect(markProcessed).toHaveBeenCalledTimes(1);
    expect(processedIds(markProcessed as jest.Mock)).toStrictEqual(['frag-1']);
    // A genuinely empty extraction writes nothing to the graph, but it is
    // still a completed one.
    expect(personCreate).not.toHaveBeenCalled();
  });

  it('does NOT mark a fragment processed when the LLM call itself throws', async () => {
    const { service, markProcessed } = makeService([EMPTY_EXTRACTION]);
    (service as unknown as { ollamaService: { chat: jest.Mock } }).ollamaService.chat.mockRejectedValue(
      new Error('ollama is down'),
    );

    await service.compactForUser(CONTEXT, [makeFragment('frag-1')]);

    expect(markProcessed).not.toHaveBeenCalled();
  });

  it('stamps only the fragments whose own batch parsed, not the whole run', async () => {
    // BATCH_SIZE is 4, so frag-1..frag-4 form batch one and frag-5 batch two.
    const { service, markProcessed, chat } = makeService([EMPTY_EXTRACTION, TRUNCATED_EXTRACTION]);

    const fragments = ['frag-1', 'frag-2', 'frag-3', 'frag-4', 'frag-5'].map(makeFragment);

    await service.compactForUser(CONTEXT, fragments);

    expect(chat).toHaveBeenCalledTimes(2);

    const stamped = processedIds(markProcessed as jest.Mock);
    expect(stamped).toHaveLength(4);
    expect(stamped).toStrictEqual(['frag-1', 'frag-2', 'frag-3', 'frag-4']);
    expect(stamped).not.toContain('frag-5');
  });

  it('gives up after a bounded number of failures so an unparseable fragment cannot loop forever', async () => {
    const { service, markProcessed } = makeService([TRUNCATED_EXTRACTION]);
    const fragment = makeFragment('frag-1');

    // Attempts 1 and 2: retryable, left unstamped for the next cron tick.
    await service.compactForUser(CONTEXT, [fragment]);
    expect(markProcessed).not.toHaveBeenCalled();

    await service.compactForUser(CONTEXT, [fragment]);
    expect(markProcessed).not.toHaveBeenCalled();

    // Attempt 3 exhausts the budget: stamp it so the cron stops re-reading it.
    await service.compactForUser(CONTEXT, [fragment]);
    expect(processedIds(markProcessed as jest.Mock)).toStrictEqual(['frag-1']);
  });

  it('resets the failure budget once a batch finally parses', async () => {
    const { service, markProcessed } = makeService([TRUNCATED_EXTRACTION]);
    const fragment = makeFragment('frag-1');

    await service.compactForUser(CONTEXT, [fragment]);
    await service.compactForUser(CONTEXT, [fragment]);
    expect(markProcessed).not.toHaveBeenCalled();

    // A successful run clears the counter...
    const chat = (service as unknown as { ollamaService: { chat: jest.Mock } }).ollamaService.chat;
    chat.mockResolvedValue({ message: { content: EMPTY_EXTRACTION } });
    await service.compactForUser(CONTEXT, [fragment]);
    expect(processedIds(markProcessed as jest.Mock)).toStrictEqual(['frag-1']);

    // ...so a later failure starts over from attempt 1 rather than tripping
    // the give-up path immediately.
    chat.mockResolvedValue({ message: { content: TRUNCATED_EXTRACTION } });
    await service.compactForUser(CONTEXT, [fragment]);
    expect(markProcessed).toHaveBeenCalledTimes(1);
  });
});

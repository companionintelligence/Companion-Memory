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
 * `upsertEntity`'s person branch is the merge/dedupe logic the audit flags
 * as highest-risk in this domain: it folds every name form the LLM emits for
 * one real person onto a single graph node ("Priya" == "Priya Sharma") via a
 * token-subset heuristic, while making sure two DIFFERENT people who happen
 * to share a token ("John Smith" vs "John Doe") are never collapsed into
 * one. This drives the whole thing through the public `compactForUser` entry
 * point — the private helpers are reachable only through it — with the LLM
 * call stubbed to return a fixed extraction result, so this pins the actual
 * merge DECISION, not a hand-picked internal function.
 */

const USER_ID = 'user-1';
const CONTEXT = { userId: USER_ID } as UserServiceContext;

function extractionResponse(entities: Array<{ type: string; name: string; description?: string }>) {
  return {
    message: { content: JSON.stringify({ entities, relationships: [] }) },
  };
}

function makeFragment(content: string): AgentMemory {
  return {
    id: `frag-${content.slice(0, 8)}`,
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

function makeService(options: {
  chatResponse: { message: { content: string } };
  searchResult?: Array<{ id: string; name: string | null }>;
  findAllResult?: Array<{ id: string; name: string | null }>;
}) {
  const ollamaService = {
    chat: jest.fn().mockResolvedValue(options.chatResponse),
  } as unknown as OllamaService;

  const personCreate = jest.fn(async (_ctx: unknown, data: { name: string }) => ({
    id: `created-${data.name.toLowerCase().replace(/\s+/g, '-')}`,
    name: data.name,
  }));
  const personUpdate = jest.fn(async (_ctx: unknown, id: string, data: { name?: string }) => ({
    id,
    name: data.name ?? null,
  }));
  const personSearch = jest.fn().mockResolvedValue(options.searchResult ?? []);
  const personFindAll = jest.fn().mockResolvedValue(options.findAllResult ?? []);

  const personService = {
    search: personSearch,
    create: personCreate,
    update: personUpdate,
    findAll: personFindAll,
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
  const agentMemoryService = { markProcessed: jest.fn() } as unknown as AgentMemoryService;
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

  return { service, personCreate, personUpdate, personSearch, personFindAll };
}

describe('MemoryCompactionService — person merge/dedupe', () => {
  it('exact (case-insensitive) name match reuses the existing node, never creates a duplicate', async () => {
    const { service, personCreate } = makeService({
      chatResponse: extractionResponse([{ type: 'person', name: 'jane smith', description: 'a friend' }]),
      searchResult: [{ id: 'existing-jane', name: 'Jane Smith' }],
    });

    await service.compactForUser(CONTEXT, [makeFragment('jane smith is a friend')]);

    expect(personCreate).not.toHaveBeenCalled();
  });

  it('an unambiguous shorter name variant reuses the existing node instead of creating a duplicate', async () => {
    // "Priya" against a single "Priya Sharma" candidate is a token-subset
    // match — the audit's core worry (silently creating a second "Priya"
    // node instead of the graph noticing it's the same person).
    const { service, personCreate, personUpdate } = makeService({
      chatResponse: extractionResponse([{ type: 'person', name: 'Priya', description: 'friend' }]),
      searchResult: [], // no EXACT "Priya" match
      findAllResult: [{ id: 'existing-priya', name: 'Priya Sharma' }],
    });

    await service.compactForUser(CONTEXT, [makeFragment('Priya said hi')]);

    expect(personCreate).not.toHaveBeenCalled();
    // "Priya" is a SHORTER form than the stored "Priya Sharma" — promotion
    // only ever extends the stored name, never shrinks it.
    expect(personUpdate).not.toHaveBeenCalled();
  });

  it('a fuller name variant reuses the existing node AND promotes it to the fuller form', async () => {
    const { service, personCreate, personUpdate } = makeService({
      chatResponse: extractionResponse([{ type: 'person', name: 'Priya Sharma', description: 'friend' }]),
      searchResult: [],
      findAllResult: [{ id: 'existing-priya', name: 'Priya' }],
    });

    await service.compactForUser(CONTEXT, [makeFragment('Priya Sharma said hi')]);

    expect(personCreate).not.toHaveBeenCalled();
    expect(personUpdate).toHaveBeenCalledWith(
      CONTEXT,
      'existing-priya',
      { name: 'Priya Sharma' },
      { source: 'MemoryCompactionService.promotePersonName' },
    );
  });

  it('an AMBIGUOUS bare name (matches two different full names) creates a new node instead of guessing', async () => {
    // "John" fits both "John Smith" and "John Doe" — merging into either
    // would silently attach this fragment's facts to the WRONG person.
    const { service, personCreate, personUpdate } = makeService({
      chatResponse: extractionResponse([
        { type: 'person', name: 'John', description: 'mentioned in passing' },
      ]),
      searchResult: [],
      findAllResult: [
        { id: 'john-smith', name: 'John Smith' },
        { id: 'john-doe', name: 'John Doe' },
      ],
    });

    await service.compactForUser(CONTEXT, [makeFragment('John came by')]);

    expect(personCreate).toHaveBeenCalledTimes(1);
    expect(personUpdate).not.toHaveBeenCalled();
  });

  it('two genuinely different people sharing a token never merge (e.g. "Priya Sharma" vs "Priya Patel")', async () => {
    const { service, personCreate } = makeService({
      chatResponse: extractionResponse([{ type: 'person', name: 'Priya Patel', description: 'coworker' }]),
      searchResult: [],
      findAllResult: [{ id: 'existing-sharma', name: 'Priya Sharma' }],
    });

    await service.compactForUser(CONTEXT, [makeFragment('Priya Patel joined the team')]);

    // Neither name is a token-subset of the other ("sharma" vs "patel"), so
    // this must create a distinct node, not fold into Priya Sharma's.
    expect(personCreate).toHaveBeenCalledTimes(1);
    expect(personCreate).toHaveBeenCalledWith(CONTEXT, { name: 'Priya Patel', description: 'coworker' });
  });

  it('a relational descriptor ("Priya\'s brother") never merges with the head name and never blocks it', async () => {
    const { service, personCreate } = makeService({
      chatResponse: extractionResponse([{ type: 'person', name: "Priya's brother", description: 'sibling' }]),
      searchResult: [],
      findAllResult: [{ id: 'existing-priya', name: 'Priya' }],
    });

    await service.compactForUser(CONTEXT, [makeFragment("Priya's brother visited")]);

    // Must create its own node — "Priya's brother" is a different person
    // from "Priya", not a name variant of her.
    expect(personCreate).toHaveBeenCalledWith(CONTEXT, { name: "Priya's brother", description: 'sibling' });
  });
});

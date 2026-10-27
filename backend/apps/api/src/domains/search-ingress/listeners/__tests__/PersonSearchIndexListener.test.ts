import { SYSTEM_USER } from '@ci/common/context';
import config from '@ci/configuration';
import { type Person } from '@ci/domains/memory';

import { PersonSearchIndexListener } from '../PersonSearchIndexListener';

/**
 * Locks in the person skip-marker contract that makes the person backfill sweep
 * converge: an unembeddable person (no search document) records a
 * ci_search.index_skips marker instead of being silently dropped — otherwise
 * every sweep re-enqueues it forever — and a successful embed clears any stale
 * marker. Persons only skip on 'empty': the message-tuned too-short/trivial
 * heuristics must NOT apply, because a bare short name ("Josh") is exactly what
 * a person document looks like.
 */
function makeListener(person: Partial<Person> | null) {
  const personService = { findById: jest.fn(async () => person as Person | null) };
  const embeddingGenerationService = { generateEmbedding: jest.fn(async () => [0.1, 0.2]) };
  const embeddingService = { upsert: jest.fn(async () => undefined), remove: jest.fn(async () => undefined) };
  const indexSkipService = {
    recordSkip: jest.fn(async () => undefined),
    clearSkip: jest.fn(async () => undefined),
  };
  const vectorService = { upsert: jest.fn(async () => undefined), remove: jest.fn(async () => undefined) };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn() };

  const listener = new PersonSearchIndexListener(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    personService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    embeddingGenerationService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    embeddingService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    indexSkipService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vectorService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
  );

  return { listener, embeddingGenerationService, embeddingService, indexSkipService, vectorService, logger };
}

describe('PersonSearchIndexListener skip markers', () => {
  it('records an index_skips marker when the person has no search document', async () => {
    const { listener, embeddingService, indexSkipService } = makeListener({
      id: 'p1',
      userId: 'u1',
      name: null,
      description: null,
      properties: undefined,
    });

    await listener.indexPerson({ personId: 'p1' });

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(indexSkipService.recordSkip).toHaveBeenCalledWith({
      entityType: 'person',
      entityId: 'p1',
      reason: 'empty',
    });
  });

  it('embeds a person with just a short name (no too-short/trivial skip) and clears any stale marker', async () => {
    const { listener, embeddingService, indexSkipService } = makeListener({
      id: 'p2',
      userId: 'u1',
      name: 'Josh',
      description: null,
      properties: undefined,
    });

    await listener.indexPerson({ personId: 'p2' });

    expect(indexSkipService.recordSkip).not.toHaveBeenCalled();
    expect(embeddingService.upsert).toHaveBeenCalledWith(
      { userId: 'u1' },
      expect.objectContaining({ entityType: 'person', entityId: 'p2' }),
    );
    expect(indexSkipService.clearSkip).toHaveBeenCalledWith({ entityType: 'person', entityId: 'p2' });
  });

  it('does not mark a person that simply was not found (row-level issue, not a content skip)', async () => {
    const { listener, embeddingService, indexSkipService } = makeListener(null);

    await listener.indexPerson({ personId: 'missing' });

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(indexSkipService.recordSkip).not.toHaveBeenCalled();
  });
});

describe('PersonSearchIndexListener.unindexPerson', () => {
  it('removes the embedding and the vector for (person, id), under the system context', async () => {
    const { listener, embeddingService, vectorService } = makeListener(null);

    await listener.unindexPerson({ personId: 'person-1' });

    expect(embeddingService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'person', entityId: 'person-1' },
    );
    expect(vectorService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'person', entityId: 'person-1' },
    );
  });
});

describe('PersonSearchIndexListener.updatePerson', () => {
  it('re-embeds and re-vectorizes an updated person the same way indexPerson does', async () => {
    const { listener, embeddingService, vectorService } = makeListener({
      id: 'p3',
      userId: 'u1',
      name: 'Josh Updated',
      description: 'now has a bio',
      properties: undefined,
    });

    await listener.updatePerson({ personId: 'p3' });

    expect(embeddingService.upsert).toHaveBeenCalledWith(
      { userId: 'u1' },
      expect.objectContaining({ entityType: 'person', entityId: 'p3' }),
    );
    expect(vectorService.upsert).toHaveBeenCalledWith(
      { userId: 'u1' },
      expect.objectContaining({ entityType: 'person', entityId: 'p3' }),
    );
  });
});

describe('PersonSearchIndexListener merge tombstones', () => {
  it('removes a merged person from the search index instead of (re-)indexing it', async () => {
    const { listener, embeddingGenerationService, embeddingService, indexSkipService, vectorService } =
      makeListener({
        id: 'p4',
        userId: 'u1',
        name: 'Duplicate Josh',
        description: null,
        properties: undefined,
        mergedIntoEntityId: 'p1',
      });

    await listener.updatePerson({ personId: 'p4' });

    expect(embeddingGenerationService.generateEmbedding).not.toHaveBeenCalled();
    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(vectorService.upsert).not.toHaveBeenCalled();
    expect(embeddingService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'person', entityId: 'p4' },
    );
    expect(vectorService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'person', entityId: 'p4' },
    );
    // A merge tombstone's absence is permanent, not content-dependent — it must
    // not go through the skip-marker bookkeeping used for a genuinely blank row.
    expect(indexSkipService.recordSkip).not.toHaveBeenCalled();
    expect(indexSkipService.clearSkip).not.toHaveBeenCalled();
  });
});

describe('PersonSearchIndexListener archived (forgotten) people', () => {
  it('removes an archived person from the search index when a later write re-emits it', async () => {
    const { listener, embeddingGenerationService, embeddingService, indexSkipService, vectorService } =
      makeListener({
        id: 'p7',
        userId: 'u1',
        name: 'Jane Smith',
        description: null,
        properties: undefined,
        isActive: false,
      });

    await listener.updatePerson({ personId: 'p7' });

    expect(embeddingGenerationService.generateEmbedding).not.toHaveBeenCalled();
    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(vectorService.upsert).not.toHaveBeenCalled();
    expect(embeddingService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'person', entityId: 'p7' },
    );
    expect(vectorService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'person', entityId: 'p7' },
    );
    // Like a tombstone, absent by the user's choice, not for want of content.
    expect(indexSkipService.recordSkip).not.toHaveBeenCalled();
    expect(indexSkipService.clearSkip).not.toHaveBeenCalled();
  });
});

describe('PersonSearchIndexListener userId guard', () => {
  it('refuses to index a person with no associated user', async () => {
    const { listener, embeddingService, vectorService, logger } = makeListener({
      id: 'p5',
      userId: null,
      name: 'No Owner',
      description: null,
      properties: undefined,
    });

    await listener.indexPerson({ personId: 'p5' });

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(vectorService.upsert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no associated user'));
  });
});

describe('PersonSearchIndexListener CI_EMBED_TYPES allowlist', () => {
  const originalTypes = config.embedding.types;

  afterEach(() => {
    config.embedding.types = originalTypes;
  });

  it('skips embedding (but still vectorizes) a person when "person" is excluded from the allowlist', async () => {
    config.embedding.types = ['event'];

    const { listener, embeddingService, vectorService } = makeListener({
      id: 'p6',
      userId: 'u1',
      name: 'Josh',
      description: 'has a bio',
      properties: undefined,
    });

    await listener.indexPerson({ personId: 'p6' });

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(vectorService.upsert).toHaveBeenCalled();
  });
});

import { SYSTEM_USER } from '@ci/common/context';
import config from '@ci/configuration';

import { TaskSearchIndexListener } from '../TaskSearchIndexListener';

function makeListener(task: Record<string, unknown> | null = null) {
  const taskService = { findById: jest.fn().mockResolvedValue(task) };
  const embeddingGenerationService = { generateEmbedding: jest.fn().mockResolvedValue([0.1, 0.2]) };
  const embeddingService = {
    upsert: jest.fn().mockResolvedValue(null),
    remove: jest.fn().mockResolvedValue(true),
  };
  const vectorService = {
    upsert: jest.fn().mockResolvedValue(null),
    remove: jest.fn().mockResolvedValue(true),
  };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const listener = new TaskSearchIndexListener(
    taskService as never,
    embeddingGenerationService as never,
    embeddingService as never,
    vectorService as never,
    logger as never,
  );

  return { listener, taskService, embeddingGenerationService, embeddingService, vectorService, logger };
}

const OPEN_TASK = {
  id: 'task-1',
  userId: 'user-1',
  title: 'Send the Fenwick contract',
  description: 'Countersigned copy back to legal',
  notes: null,
  status: 'open',
};

describe('TaskSearchIndexListener tenant scoping', () => {
  // The regression this whole file exists for. TaskService.findById is
  // unconditionally tenant-scoped and has no SYSTEM_USER escape, so reading the
  // row under SYSTEM_USER (as every other search listener does) returns null for
  // every real task and the listener silently indexes nothing. The payload's
  // userId is the only thing that makes the read work.
  it('reads the task under the owner from the payload, never under SYSTEM_USER', async () => {
    const { listener, taskService } = makeListener(OPEN_TASK);

    await listener.indexTask({ taskId: 'task-1', userId: 'user-1' } as never);

    expect(taskService.findById).toHaveBeenCalledWith({ userId: 'user-1' }, 'task-1');
    expect(taskService.findById).not.toHaveBeenCalledWith(
      expect.objectContaining({ userId: SYSTEM_USER }),
      expect.anything(),
    );
  });

  it('actually indexes a task owned by a real user', async () => {
    const { listener, embeddingService, vectorService } = makeListener(OPEN_TASK);

    await listener.indexTask({ taskId: 'task-1', userId: 'user-1' } as never);

    expect(embeddingService.upsert).toHaveBeenCalledWith(
      { userId: 'user-1' },
      { entityType: 'task', entityId: 'task-1', embedding: [0.1, 0.2] },
    );
    expect(vectorService.upsert).toHaveBeenCalled();
  });

  // pg-boss is at-least-once, so jobs enqueued under the previous payload shape
  // outlive the deploy that added userId. Skipping them must be quiet and safe.
  it('skips a legacy payload that carries no userId, without touching the index', async () => {
    const { listener, taskService, embeddingService, vectorService, logger } = makeListener(OPEN_TASK);

    await listener.indexTask({ taskId: 'task-1' } as never);

    expect(taskService.findById).not.toHaveBeenCalled();
    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(vectorService.upsert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('TaskSearchIndexListener.indexTask / updateTask', () => {
  it('is a no-op when the task cannot be found', async () => {
    const { listener, embeddingService, logger } = makeListener(null);

    await listener.indexTask({ taskId: 'ghost', userId: 'user-1' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('weights the title above description and notes, and status lowest', async () => {
    const { listener, vectorService } = makeListener({
      ...OPEN_TASK,
      notes: 'Chased twice',
    });

    await listener.indexTask({ taskId: 'task-1', userId: 'user-1' } as never);

    expect(vectorService.upsert).toHaveBeenCalledWith(
      { userId: 'user-1' },
      {
        entityType: 'task',
        entityId: 'task-1',
        searchableText: [
          { text: 'Send the Fenwick contract', weight: 10 },
          { text: 'Countersigned copy back to legal', weight: 5 },
          { text: 'Chased twice', weight: 5 },
          { text: 'open', weight: 2 },
        ],
      },
    );
  });

  // Status is intentionally excluded from the embedding: appending the same
  // status word to every document drags unrelated tasks together in vector space.
  it('excludes status from the embedded document but keeps the prose', async () => {
    const { listener, embeddingGenerationService } = makeListener(OPEN_TASK);

    await listener.indexTask({ taskId: 'task-1', userId: 'user-1' } as never);

    expect(embeddingGenerationService.generateEmbedding).toHaveBeenCalledWith(
      'Send the Fenwick contract Countersigned copy back to legal',
    );
  });

  it('updateTask re-indexes an existing task the same way', async () => {
    const { listener, embeddingService } = makeListener(OPEN_TASK);

    await listener.updateTask({ taskId: 'task-1', userId: 'user-1' } as never);

    expect(embeddingService.upsert).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ entityType: 'task', entityId: 'task-1' }),
    );
  });

  it('skips a task with no title, description or notes', async () => {
    const { listener, embeddingService } = makeListener({
      id: 'task-2',
      userId: 'user-1',
      title: '',
      description: null,
      notes: null,
      status: 'open',
    });

    await listener.indexTask({ taskId: 'task-2', userId: 'user-1' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
  });
});

describe('TaskSearchIndexListener archived handling', () => {
  // Archiving REMOVES rather than skips. A skip would leave the row visible to
  // the backfill sweep forever, which is the non-convergence ci_search.index_skips
  // was created to end; removal also keeps recall from surfacing archived work.
  it('removes an archived task from the index instead of re-indexing it', async () => {
    const { listener, embeddingService, vectorService } = makeListener({
      ...OPEN_TASK,
      status: 'archived',
    });

    await listener.updateTask({ taskId: 'task-1', userId: 'user-1' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(vectorService.upsert).not.toHaveBeenCalled();
    expect(embeddingService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'task', entityId: 'task-1' },
    );
    expect(vectorService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'task', entityId: 'task-1' },
    );
  });
});

describe('TaskSearchIndexListener.unindexTask', () => {
  it('removes the embedding and the vector for (task, id) under the system context', async () => {
    const { listener, embeddingService, vectorService } = makeListener();

    await listener.unindexTask({ taskId: 'task-1', userId: 'user-1' } as never);

    expect(embeddingService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'task', entityId: 'task-1' },
    );
    expect(vectorService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'task', entityId: 'task-1' },
    );
  });
});

describe('CI_EMBED_TYPES allowlist', () => {
  const originalTypes = config.embedding.types;

  afterEach(() => {
    config.embedding.types = originalTypes;
  });

  it('skips embedding but still vectorizes when "task" is excluded from the allowlist', async () => {
    config.embedding.types = ['event'];

    const { listener, embeddingService, vectorService } = makeListener(OPEN_TASK);

    await listener.indexTask({ taskId: 'task-1', userId: 'user-1' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(vectorService.upsert).toHaveBeenCalled();
  });
});

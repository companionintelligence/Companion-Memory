import type { Repository } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';

import type { AgentMemoryEntity } from '../../entities/AgentMemoryEntity';
import { AgentMemoryCreatedEvent } from '../../events';
import { AgentMemoryService } from '../AgentMemoryService';

const CONTEXT = { userId: 'user-1' } as UserServiceContext;

const logger = {
  setContext: () => undefined,
  log: () => undefined,
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as LoggerService;

function makeService() {
  const saved: AgentMemoryEntity[] = [];
  const sends: Array<{ name: string; payload: Record<string, unknown> }> = [];

  const repository = {
    create: (data: Partial<AgentMemoryEntity>) => data as AgentMemoryEntity,
    save: async (entity: AgentMemoryEntity) => {
      saved.push(entity);

      return entity;
    },
  } as unknown as Repository<AgentMemoryEntity>;

  const eventService = {
    send: async (name: string, payload: Record<string, unknown>) => {
      sends.push({ name, payload });

      return [];
    },
  } as unknown as EventService;

  return { saved, sends, service: new AgentMemoryService(repository, eventService, logger) };
}

/**
 * The idempotence contract the chat-turn producer leans on: a replay-safe
 * caller supplies the primary key, everyone else gets a fresh uuid7. Without
 * the caller-supplied id the cron would need a watermark table to avoid
 * writing a second fragment for a turn it had already distilled.
 */
describe('AgentMemoryService.create', () => {
  it('honours a caller-supplied deterministic id', async () => {
    const { service, saved, sends } = makeService();

    const memory = await service.create(CONTEXT, {
      id: '0190c3f2-0000-8000-8000-000000000001',
      content: 'User: where did I park?\nAssistant: Level 3, bay 118.',
      source: 'chat-turn',
      sessionId: 'thread-1',
    });

    expect(memory.id).toBe('0190c3f2-0000-8000-8000-000000000001');
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe('0190c3f2-0000-8000-8000-000000000001');
    expect(sends).toHaveLength(1);
    expect(sends[0].name).toBe(AgentMemoryCreatedEvent);
    expect(sends[0].payload.memoryId).toBe('0190c3f2-0000-8000-8000-000000000001');
  });

  it('still mints a uuid for a caller that supplies none', async () => {
    const { service, saved } = makeService();

    await service.create(CONTEXT, { content: 'remembered by Hermes', source: 'memory' });

    expect(saved[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(saved[0].title).toBe('[memory]');
  });
});

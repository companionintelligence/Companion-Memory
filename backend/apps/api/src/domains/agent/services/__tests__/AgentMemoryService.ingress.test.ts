import type { Repository } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';

import type { AgentMemoryEntity } from '../../entities/AgentMemoryEntity';
import { AgentMemoryCreatedEvent } from '../../events';
import { AgentMemoryService } from '../AgentMemoryService';

const USER = '0190c3f2-0000-7000-8000-000000000001';
const MEMORY_ID = '0190c3f2-0000-7000-8000-0000000000aa';
const CONTENT = 'Remind me to call the vet tomorrow';
const FLAG = 'MEMORY_INGRESS_DECISION';

const CONTEXT = { userId: USER } as UserServiceContext;

function build() {
  const sends: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const log = jest.fn();

  const repository = {
    create: (data: Partial<AgentMemoryEntity>) => data as AgentMemoryEntity,
    save: async (entity: AgentMemoryEntity) => entity,
  } as unknown as Repository<AgentMemoryEntity>;

  const eventService = {
    send: async (name: string, payload: Record<string, unknown>) => {
      sends.push({ name, payload });

      return [];
    },
  } as unknown as EventService;

  const logger = {
    setContext: () => undefined,
    log,
    debug: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as LoggerService;

  return { service: new AgentMemoryService(repository, eventService, logger), sends, log };
}

/** The ingress call is fire-and-forget, so let its promise chain run before asserting on it. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

function ingressReply(): Response {
  return new Response(
    JSON.stringify({
      user_id: USER,
      intent: 'store_task',
      intent_confidence: 0.8,
      intent_distribution: {},
      is_commitment: true,
      commitment_probability: 0.93,
      sensitivity: 1,
      sensitivity_distribution: {},
      calibrated: true,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('AgentMemoryService.create with MEMORY_INGRESS_DECISION', () => {
  const previous = process.env[FLAG];

  afterEach(() => {
    jest.restoreAllMocks();

    if (previous === undefined) {
      delete process.env[FLAG];
    } else {
      process.env[FLAG] = previous;
    }
  });

  it('makes no sidecar call and records nothing while the flag is off', async () => {
    delete process.env[FLAG];
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const { service, sends, log } = build();

    const memory = await service.create(CONTEXT, { id: MEMORY_ID, content: CONTENT, source: 'chat-turn' });
    await settle();

    expect(memory.id).toBe(MEMORY_ID);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalledWith('Memory ingress decision', expect.anything());
    expect(sends.map((send) => send.name)).toEqual([AgentMemoryCreatedEvent]);
  });

  it('scores the fragment with /decision/ingress and logs the scores beside the write, which is unchanged', async () => {
    process.env[FLAG] = 'true';
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(ingressReply());
    const { service, sends, log } = build();

    const memory = await service.create(CONTEXT, { id: MEMORY_ID, content: CONTENT, source: 'chat-turn' });
    await settle();

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];

    expect(url).toContain(`/decision/ingress?user_id=${USER}`);
    expect(JSON.parse(String(init.body))).toEqual({ text: CONTENT });
    expect(log).toHaveBeenCalledWith(
      'Memory ingress decision',
      expect.objectContaining({
        memoryId: MEMORY_ID,
        userId: USER,
        isCommitment: true,
        intent: 'store_task',
      }),
    );
    expect(memory.id).toBe(MEMORY_ID);
    expect(sends.map((send) => send.name)).toEqual([AgentMemoryCreatedEvent]);
  });

  it('leaves the write exactly as it was when the sidecar fails', async () => {
    process.env[FLAG] = 'true';
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const { service, sends, log } = build();

    const memory = await service.create(CONTEXT, { id: MEMORY_ID, content: CONTENT, source: 'chat-turn' });
    await settle();

    expect(memory.id).toBe(MEMORY_ID);
    expect(sends.map((send) => send.name)).toEqual([AgentMemoryCreatedEvent]);
    expect(log).not.toHaveBeenCalledWith('Memory ingress decision', expect.anything());
  });
});

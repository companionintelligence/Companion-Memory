import type { Repository } from 'typeorm';

import type { LoggerService } from '@ci/common/logging';
import type { MessageEntity } from '@ci/domains/conversations';

import type { AgentMemory } from '../../entities/AgentMemoryEntity';
import { turnFragmentId } from '../../turnFragments';
import type { AgentMemoryService, CreateAgentMemoryDto } from '../AgentMemoryService';
import { TURN_FRAGMENT_SETTINGS, TurnFragmentService } from '../TurnFragmentService';

const USER_ID = 'user-1';

interface Row {
  id: string;
  content: string;
  threadId: string;
  threadTitle: string | null;
  promptId: string;
  promptContent: string;
}

function messageRow(row: Row): MessageEntity {
  return {
    id: row.id,
    content: row.content,
    role: 'assistant',
    canceled: false,
    threadId: row.threadId,
    thread: { id: row.threadId, name: row.threadTitle },
    promptMessage: { id: row.promptId, content: row.promptContent, role: 'user' },
  } as unknown as MessageEntity;
}

/**
 * A query-builder double that records the predicates the service asked for and
 * hands back canned rows. The point is the DECISIONS the service makes on top
 * of the query — which rows become one turn, which turn is dropped, which
 * fragment is skipped as already written — plus the handful of predicates that
 * are themselves the contract ("completed" means the thread went back to idle).
 */
function fakeRepository(rows: MessageEntity[], rawRows: Array<{ user_id: string | null }> = []) {
  const predicates: string[] = [];
  const params: Record<string, unknown> = {};
  const state: { limit?: number; distinct?: boolean; joinedAndSelected: string[] } = {
    joinedAndSelected: [],
  };

  const builder: Record<string, unknown> = {};
  const chain =
    (name: string) =>
    (...args: unknown[]) => {
      if (name === 'where' || name === 'andWhere') {
        predicates.push(String(args[0]));
        Object.assign(params, (args[1] as Record<string, unknown>) ?? {});
      }

      if (name === 'limit') {
        state.limit = args[0] as number;
      }

      if (name === 'distinct') {
        state.distinct = args[0] as boolean;
      }

      if (name === 'innerJoinAndSelect') {
        state.joinedAndSelected.push(String(args[0]));
      }

      return builder;
    };

  for (const name of [
    'innerJoin',
    'innerJoinAndSelect',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'limit',
    'select',
    'distinct',
  ]) {
    builder[name] = chain(name);
  }

  builder.getMany = async () => rows;
  builder.getRawMany = async () => rawRows;

  return {
    repository: { createQueryBuilder: () => builder } as unknown as Repository<MessageEntity>,
    predicates,
    params,
    state,
  };
}

function fakeAgentMemoryService(existingIds: string[] = []) {
  const created: CreateAgentMemoryDto[] = [];

  return {
    created,
    service: {
      findByIds: async (_context: unknown, ids: string[]) =>
        ids.filter((id) => existingIds.includes(id)).map((id) => ({ id }) as AgentMemory),
      create: async (_context: unknown, data: CreateAgentMemoryDto) => {
        created.push(data);

        return { id: data.id } as AgentMemory;
      },
    } as unknown as AgentMemoryService,
  };
}

const logger = {
  setContext: () => undefined,
  log: () => undefined,
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as LoggerService;

function makeService(rows: MessageEntity[], existingIds: string[] = []) {
  const repo = fakeRepository(rows);
  const memory = fakeAgentMemoryService(existingIds);

  return {
    ...repo,
    ...memory,
    service: new TurnFragmentService(repo.repository, memory.service, logger),
  };
}

const WINDOW = { since: new Date('2026-08-26T10:00:00Z'), until: new Date('2026-08-26T11:00:00Z') };

const TOOL_TURN: Row[] = [
  {
    id: 'assistant-1',
    content: '<think>check the calendar</think>Let me look at Thursday.',
    threadId: 'thread-1',
    threadTitle: 'Week ahead',
    promptId: 'prompt-1',
    promptContent: 'What meetings do I have on Thursday afternoon?',
  },
  {
    id: 'assistant-2',
    content: 'Two: the design review at 14:00 and a 1:1 with Priya at 16:00.',
    threadId: 'thread-1',
    threadTitle: 'Week ahead',
    promptId: 'prompt-1',
    promptContent: 'What meetings do I have on Thursday afternoon?',
  },
];

describe('TurnFragmentService.resolveWindow', () => {
  it('never reaches later than now minus the settle delay', () => {
    const { service } = makeService([]);
    const now = new Date('2026-08-26T12:00:00Z');
    const window = service.resolveWindow(now);

    expect(now.getTime() - window.until.getTime()).toBe(TURN_FRAGMENT_SETTINGS.settleMinutes * 60_000);
    expect(window.until.getTime() - window.since.getTime()).toBe(
      TURN_FRAGMENT_SETTINGS.lookbackMinutes * 60_000,
    );
  });

  it('looks back further than one interval, so a skipped tick is recovered', () => {
    expect(TURN_FRAGMENT_SETTINGS.lookbackMinutes).toBeGreaterThan(TURN_FRAGMENT_SETTINGS.intervalMinutes);
  });
});

describe('TurnFragmentService.listUsersWithCompletedTurns', () => {
  it('asks the database for distinct owners of settled, idle-thread assistant rows', async () => {
    const repo = fakeRepository([], [{ user_id: 'user-a' }, { user_id: 'user-b' }, { user_id: null }]);
    const memory = fakeAgentMemoryService();
    const service = new TurnFragmentService(repo.repository, memory.service, logger);

    expect(await service.listUsersWithCompletedTurns(WINDOW)).toStrictEqual(['user-a', 'user-b']);
    expect(repo.state.distinct).toBe(true);
    expect(repo.predicates).toEqual(
      expect.arrayContaining([
        'message.role = :role',
        'message.canceled = false',
        'thread.isArchived = false',
        'thread.generationStatus = :idle',
        'message.updatedAt >= :since',
        'message.updatedAt < :until',
      ]),
    );
    expect(repo.params).toMatchObject({
      role: 'assistant',
      idle: 'idle',
      since: WINDOW.since,
      until: WINDOW.until,
    });
  });
});

describe('TurnFragmentService.distillForUser', () => {
  it('collapses every assistant row of one prompt into a single fragment', async () => {
    const { service, created } = makeService(TOOL_TURN.map(messageRow));

    const outcome = await service.distillForUser(USER_ID, WINDOW);

    expect(outcome).toStrictEqual({ turns: 1, written: 1, skipped: 0 });
    expect(created).toHaveLength(1);
    expect(created[0]).toStrictEqual({
      id: turnFragmentId({ userId: USER_ID, threadId: 'thread-1', promptMessageId: 'prompt-1' }),
      title: '[chat-turn] Week ahead',
      content:
        'User: What meetings do I have on Thursday afternoon?\n' +
        'Assistant: Let me look at Thursday.\n\n' +
        'Two: the design review at 14:00 and a 1:1 with Priya at 16:00.',
      source: 'chat-turn',
      sessionId: 'thread-1',
    });
  });

  it('writes nothing on a replay of a window it already distilled', async () => {
    const alreadyWritten = turnFragmentId({
      userId: USER_ID,
      threadId: 'thread-1',
      promptMessageId: 'prompt-1',
    });
    const { service, created } = makeService(TOOL_TURN.map(messageRow), [alreadyWritten]);

    const outcome = await service.distillForUser(USER_ID, WINDOW);

    expect(created).toHaveLength(0);
    expect(outcome).toStrictEqual({ turns: 1, written: 0, skipped: 1 });
  });

  it('keeps each thread as its own session', async () => {
    const rows = [
      ...TOOL_TURN,
      {
        id: 'assistant-3',
        content: 'The lease renewal is due on the 30th of September.',
        threadId: 'thread-2',
        threadTitle: null,
        promptId: 'prompt-2',
        promptContent: 'When does the flat lease actually run out?',
      },
    ].map(messageRow);
    const { service, created } = makeService(rows);

    await service.distillForUser(USER_ID, WINDOW);

    expect(created).toHaveLength(2);
    expect(created.map((fragment) => fragment.sessionId)).toStrictEqual(['thread-1', 'thread-2']);
  });

  it('drops the last turn when the row budget was hit, rather than freezing a partial one', async () => {
    // A full page means the final prompt's assistant rows may continue past
    // the cut, so that prompt is left for the next tick. Ten prompts share the
    // page so the drop is visible rather than masked by the turn cap.
    const rowLimit = TURN_FRAGMENT_SETTINGS.maxTurnsPerUser * 4;
    const promptCount = 10;
    const rowsPerPrompt = rowLimit / promptCount;
    const rows = Array.from({ length: rowLimit }, (_, index) =>
      messageRow({
        id: `assistant-${index}`,
        content: `Answer number ${index}, which is long enough to clear the floor.`,
        threadId: 'thread-1',
        threadTitle: 'Week ahead',
        promptId: `prompt-${Math.floor(index / rowsPerPrompt)}`,
        promptContent: `Question number ${index}, also long enough to clear the floor.`,
      }),
    );
    const { service, created, state } = makeService(rows);

    const outcome = await service.distillForUser(USER_ID, WINDOW);

    expect(state.limit).toBe(rowLimit);
    expect(outcome.turns).toBe(promptCount - 1);
    expect(created).toHaveLength(promptCount - 1);
    expect(created.map((fragment) => fragment.id)).not.toContain(
      turnFragmentId({
        userId: USER_ID,
        threadId: 'thread-1',
        promptMessageId: `prompt-${promptCount - 1}`,
      }),
    );
  });

  it('caps one user at the configured turn budget', async () => {
    // Short of the row budget, so nothing is dropped as truncated: what limits
    // this page is `maxTurnsPerUser` alone.
    const promptCount = TURN_FRAGMENT_SETTINGS.maxTurnsPerUser + 7;
    const rows = Array.from({ length: promptCount }, (_, index) =>
      messageRow({
        id: `assistant-${index}`,
        content: `Answer number ${index}, which is long enough to clear the floor.`,
        threadId: 'thread-1',
        threadTitle: 'Week ahead',
        promptId: `prompt-${index}`,
        promptContent: `Question number ${index}, also long enough to clear the floor.`,
      }),
    );
    const { service, created } = makeService(rows);

    const outcome = await service.distillForUser(USER_ID, WINDOW);

    expect(outcome.turns).toBe(TURN_FRAGMENT_SETTINGS.maxTurnsPerUser);
    expect(created).toHaveLength(TURN_FRAGMENT_SETTINGS.maxTurnsPerUser);
  });

  it('hydrates the thread so the fragment can be titled', async () => {
    const { service, state } = makeService(TOOL_TURN.map(messageRow));

    await service.distillForUser(USER_ID, WINDOW);

    expect(state.joinedAndSelected).toStrictEqual(['message.thread', 'message.promptMessage']);
  });

  it('only pairs assistant rows with a user prompt', async () => {
    const { service, params } = makeService(TOOL_TURN.map(messageRow));

    await service.distillForUser(USER_ID, WINDOW);

    expect(params.promptRole).toBe('user');
    expect(params.userId).toBe(USER_ID);
  });
});

import type { RequestContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { CommunicationService, UserContextService } from '@ci/domains/memory';

import type { AgentMemoryService } from '../../services/AgentMemoryService';
import type { ForecastContextService } from '../../services/ForecastContextService';
import type { MemoryCompactionService } from '../../services/MemoryCompactionService';
import type { RecallService } from '../../services/RecallService';
import { MemoryController } from '../MemoryController';

/**
 * `POST /memory/turn` stores what an agent harness (OpenClaw `afterTurn`,
 * Hermes `sync_turn`) saw in one chat turn. The owner is the one talking to the
 * agent, so their message is the one they SENT and the agent's reply is the one
 * they RECEIVED. Recall prints direction as "I wrote" / "someone else wrote to
 * me", so a swapped direction hands the owner's own words to "someone else" and
 * the agent's words to the owner.
 */

const USER_ID = '00000000-0000-4000-8000-000000000001';

function makeController() {
  const created: Array<Record<string, unknown>> = [];
  const communicationService = {
    findByIds: jest.fn(async () => []),
    create: jest.fn(async (_context: unknown, data: Record<string, unknown>) => {
      created.push(data);

      return data;
    }),
  } as unknown as CommunicationService;

  const controller = new MemoryController(
    undefined as unknown as UserContextService,
    undefined as unknown as RecallService,
    undefined as unknown as AgentMemoryService,
    communicationService,
    undefined as unknown as ForecastContextService,
    undefined as unknown as MemoryCompactionService,
    { setContext: () => undefined } as unknown as LoggerService,
  );

  return { controller, created };
}

describe('MemoryController POST /memory/turn', () => {
  it("stores the owner's message as outbound and the agent's reply as inbound", async () => {
    const { controller, created } = makeController();

    const result = await controller.turn({ userId: USER_ID } as RequestContext, {
      platform: 'openclaw',
      sessionId: 'session-1',
      messages: [
        { role: 'user', content: 'Please remember this for later: my snack is a cardamom bun.' },
        { role: 'assistant', content: 'Got it, I will remember that your snack is a cardamom bun.' },
      ],
    });

    expect(result).toEqual({ created: 2, skipped: 0 });
    expect(
      created.map((row) => [(row.participants_metadata as { role: string }).role, row.direction]),
    ).toEqual([
      ['user', 'outbound'],
      ['assistant', 'inbound'],
    ]);
  });
});

import { Channel } from '@ci/common/rpc';
import type { MessageGrounding } from '@ci/domains/conversations';

import { ChatGenerationBroker } from '../ChatGenerationBroker';
import { ChatTurnService } from '../ChatTurnService';

const payload = {
  ownerId: 'u',
  threadId: 't',
  promptMessageId: 'q',
  assistantMessageId: 'a',
  model: 'local',
  enableTools: false,
  enableThinking: false,
  capability: 'full' as const,
};
const line = {
  text: 'Jane now works at Orbit',
  voice: 'own',
  ref: { type: 'agent-memory', id: 'source-1', at: '2026-10-20T10:00:00Z' },
};

function harness(recall: jest.Mock, answer = 'Jane works at Orbit [M1].') {
  const broker = new ChatGenerationBroker();
  const publish = jest.spyOn(broker, 'publish');
  const messageService = {
    findByThreadId: jest.fn(async () => [
      { id: 'q', role: 'user', content: 'Where does Jane work?', files: [] },
    ]),
    update: jest.fn(async () => ({})),
    create: jest.fn(async () => ({})),
  };
  const chatStream = jest.fn(async () => {
    const stream = (async function* () {
      yield { message: { content: answer } };
    })();

    return Object.assign(stream, { messages: [{ role: 'assistant', content: answer }] });
  });
  const service = new ChatTurnService(
    { send: jest.fn(async () => ['job']) } as never,
    { findByThreadId: jest.fn(async () => null) } as never,
    messageService as never,
    {
      resolveModel: jest.fn(async () => ({ model: 'local', enableThinking: false, enableTools: false })),
      chatStream,
    } as never,
    {
      findById: jest.fn(async () => ({ id: 't', name: 'Thread', generationStatus: 'queued' })),
      update: jest.fn(),
    } as never,
    {} as never,
    { getUserContextForLLM: jest.fn(async () => null) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    broker,
    { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
    { isFeatureEnabled: jest.fn(async (key) => key === 'enable.system.prompt') } as never,
    { get: jest.fn(() => ({ recall })) } as never,
  );

  return { service, publish, messageService, chatStream };
}

describe('chat grounding evidence', () => {
  it('uses numbered attributed evidence and retains the exact source when the answer is reopened', async () => {
    const { service, messageService, chatStream, publish } = harness(
      jest.fn(async () => ({ lines: [line], resultCount: 1, block: '' })),
    );
    await service.execute(payload);
    const prompt = JSON.stringify(chatStream.mock.calls);
    expect(prompt).toContain('[M1] (owner; record date: 2026-10-20T10:00:00Z) Jane now works at Orbit');
    expect(messageService.update).toHaveBeenLastCalledWith(
      expect.anything(),
      'a',
      expect.objectContaining({
        grounding: {
          status: 'retrieved',
          sources: [{ ...line, citation: 1 }],
          citations: { cited: [1], invalid: [] },
        },
      }),
    );
    expect(publish.mock.calls[0][1].channel).toBe(Channel.GROUNDING);
  });

  it('discloses a failed lookup to both model and viewer instead of silently continuing', async () => {
    const { service, messageService, chatStream, publish } = harness(
      jest.fn(async () => {
        throw new Error('search unavailable');
      }),
      'I cannot verify that right now.',
    );
    await service.execute(payload);
    expect(JSON.stringify(chatStream.mock.calls)).toContain('Memory retrieval did not complete');
    expect(
      publish.mock.calls.some(
        ([, chunk]) => chunk.channel === Channel.GROUNDING && JSON.parse(chunk.text).status === 'unavailable',
      ),
    ).toBe(true);
    expect(messageService.update).toHaveBeenLastCalledWith(
      expect.anything(),
      'a',
      expect.objectContaining({ grounding: expect.objectContaining({ status: 'unavailable', sources: [] }) }),
    );
  });

  it('flags invented citation numbers without representing citation existence as factual verification', async () => {
    const { service, messageService } = harness(
      jest.fn(async () => ({ lines: [line] })),
      'Jane works at Orbit [M9].',
    );
    await service.execute(payload);
    expect(messageService.update).toHaveBeenLastCalledWith(
      expect.anything(),
      'a',
      expect.objectContaining({
        grounding: expect.objectContaining({ citations: { cited: [9], invalid: [9] } }),
      }),
    );
  });

  it('omits sources that do not fit the prompt and reports a budget limit', async () => {
    const { service } = harness(jest.fn(async () => ({ lines: [line] })));
    let grounding: MessageGrounding | undefined;
    const section = await (
      service as unknown as {
        buildRecallSection: (
          user: string,
          query: string,
          bytes: number,
          report: (grounding: MessageGrounding) => void,
        ) => Promise<string>;
      }
    ).buildRecallSection('u', 'Jane', 20, (value) => {
      grounding = value;
    });
    expect(section).toBe('');
    expect(grounding).toEqual({ status: 'budget_exhausted', sources: [] });
  });
});

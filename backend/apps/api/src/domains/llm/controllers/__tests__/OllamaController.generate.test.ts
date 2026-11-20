import { ConflictException, UnauthorizedException } from '@nestjs/common';

import { LiveChangesService } from '@ci/domains/live-changes';

import { ChatGenerationBroker } from '../../services/ChatGenerationBroker';
import { OllamaController } from '../OllamaController';

function mockResponse() {
  const closeHandlers: Array<() => void> = [];

  const res = {
    socket: { setNoDelay: jest.fn() },
    writeHead: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
    status: jest.fn().mockReturnThis(),
    on: jest.fn((event: string, handler: () => void) => {
      if (event === 'close') {
        closeHandlers.push(handler);
      }
    }),
    writableEnded: false,
  };

  return { res, closeHandlers };
}

describe('OllamaController generate attach', () => {
  const context = { userId: 'user-1' };
  const thread = { id: 'thread-1', generationStatus: 'idle', name: null };

  function buildController(
    overrides: Record<string, unknown> = {},
    actionService?: unknown,
    liveChanges?: LiveChangesService,
  ) {
    const broker = new ChatGenerationBroker();
    const messageService = {
      create: jest
        .fn()
        .mockResolvedValueOnce({ id: 'user-msg' })
        .mockResolvedValueOnce({ id: 'assistant-msg' }),
    };
    const ollamaService = {
      resolveModel: jest.fn(async () => ({ model: 'Qwen3.8-27B-Uncensored' })),
    };
    const threadService = {
      findById: jest.fn(async () => thread),
      create: jest.fn(async () => thread),
    };
    const chatTurnService = {
      setGenerationStatus: jest.fn(async () => undefined),
      enqueueGenerate: jest.fn(async () => ['job-1']),
    };
    const desktopAppService = {
      isClosed: jest.fn(async () => false),
      rethrow: jest.fn(async (error: unknown) => {
        throw error;
      }),
    };
    const logger = { setContext: jest.fn(), log: jest.fn(), error: jest.fn() };
    const controller = new OllamaController(
      (overrides.messageService ?? messageService) as never,
      (overrides.ollamaService ?? ollamaService) as never,
      (overrides.threadService ?? threadService) as never,
      (overrides.broker ?? broker) as never,
      (overrides.chatTurnService ?? chatTurnService) as never,
      (overrides.desktopAppService ?? desktopAppService) as never,
      (overrides.llmEndpointService ?? { describeConnectionFailure: async () => null }) as never,
      logger as never,
      actionService as never,
      liveChanges,
    );

    return { controller, broker, chatTurnService, threadService, messageService };
  }

  it('enqueues a chat.generate job and does not abort when the SSE client disconnects', async () => {
    const { controller, broker, chatTurnService } = buildController();
    const { res, closeHandlers } = mockResponse();

    await controller.generate(
      context as never,
      {
        prompt: 'hello',
        threadId: 'thread-1',
        enableTools: true,
        enableThinking: false,
      } as never,
      res as never,
      {} as never,
    );

    expect(chatTurnService.enqueueGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'user-1',
        threadId: 'thread-1',
        promptMessageId: 'user-msg',
        assistantMessageId: 'assistant-msg',
      }),
    );

    const signal = broker.signal('thread-1');
    closeHandlers.forEach((handler) => handler());
    expect(signal.aborted).toBe(false);
  });

  it('rejects a second generate while the thread is already queued', async () => {
    const { controller } = buildController({
      threadService: {
        findById: jest.fn(async () => ({ ...thread, generationStatus: 'queued' })),
      },
    });
    const { res } = mockResponse();

    await expect(
      controller.generate(
        context as never,
        { prompt: 'hello', threadId: 'thread-1' } as never,
        res as never,
        {} as never,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('cancel aborts the in-process generation without requiring the viewer to stay attached', async () => {
    const { controller, broker, chatTurnService } = buildController({
      threadService: {
        findById: jest.fn(async () => ({ ...thread, generationStatus: 'running' })),
      },
    });
    broker.ensure('thread-1');
    const signal = broker.signal('thread-1');

    await controller.cancel(context as never, 'thread-1');

    expect(signal.aborted).toBe(true);
    expect(chatTurnService.setGenerationStatus).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      'thread-1',
      'idle',
    );
  });

  describe('a first turn about a Today action', () => {
    const ACTION_ID = '01a17800-0000-7000-8000-0000000000c1';

    function actionService(action: Record<string, unknown> | null) {
      return {
        findById: jest.fn(async () => action),
        attachThread: jest.fn(async () => true),
      };
    }

    it('opens the thread with the action, names it after the action and links the action to it', async () => {
      // A derived action (Confirm home) has no thread. Without this the model
      // saw "Why do you suggest this?" with nothing before it and answered
      // "I'm not sure what 'this' you're referring to".
      const messageService = {
        create: jest
          .fn()
          .mockResolvedValueOnce({ id: 'action-msg' })
          .mockResolvedValueOnce({ id: 'user-msg' })
          .mockResolvedValueOnce({ id: 'assistant-msg' }),
      };
      const actions = actionService({
        id: ACTION_ID,
        title: 'Confirm home',
        text: 'Is Mint Plaza home?',
        threadId: null,
      });
      const { controller, threadService, chatTurnService } = buildController({ messageService }, actions);
      const { res } = mockResponse();

      await controller.generate(
        context as never,
        { prompt: 'Why do you suggest this?', threadId: null, actionId: ACTION_ID } as never,
        res as never,
        {} as never,
      );

      expect(threadService.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1' }),
        expect.objectContaining({ name: 'Confirm home' }),
      );
      expect(messageService.create.mock.calls.map(([, data]) => [data.role, data.content])).toEqual([
        ['assistant', 'Is Mint Plaza home?'],
        ['user', 'Why do you suggest this?'],
        ['assistant', ''],
      ]);
      expect(actions.attachThread).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1' }),
        ACTION_ID,
        'thread-1',
        null,
      );
      expect(chatTurnService.enqueueGenerate).toHaveBeenCalledWith(
        expect.objectContaining({ promptMessageId: 'user-msg', assistantMessageId: 'assistant-msg' }),
      );
    });

    it('relinks an action whose thread was archived to the thread it starts', async () => {
      const actions = actionService({
        id: ACTION_ID,
        title: 'Confirm home',
        text: 'Is Mint Plaza home?',
        threadId: 'thread-archived',
      });
      const threadService = {
        findById: jest.fn(async () => null),
        create: jest.fn(async () => thread),
      };
      const messageService = {
        create: jest
          .fn()
          .mockResolvedValueOnce({ id: 'action-msg' })
          .mockResolvedValueOnce({ id: 'user-msg' })
          .mockResolvedValueOnce({ id: 'assistant-msg' }),
      };
      const { controller } = buildController({ threadService, messageService }, actions);
      const { res } = mockResponse();

      await controller.generate(
        context as never,
        { prompt: 'Why do you suggest this?', threadId: null, actionId: ACTION_ID } as never,
        res as never,
        {} as never,
      );

      expect(threadService.create).toHaveBeenCalled();
      expect(actions.attachThread).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1' }),
        ACTION_ID,
        'thread-1',
        'thread-archived',
      );
    });

    it('continues the thread an action already has instead of starting another', async () => {
      const actions = actionService({
        id: ACTION_ID,
        title: 'Confirm home',
        text: 'x',
        threadId: 'thread-1',
      });
      const { controller, threadService } = buildController({}, actions);
      const { res } = mockResponse();

      await controller.generate(
        context as never,
        { prompt: 'And now?', threadId: null, actionId: ACTION_ID } as never,
        res as never,
        {} as never,
      );

      expect(threadService.create).not.toHaveBeenCalled();
      expect(threadService.findById).toHaveBeenCalledWith(expect.anything(), 'thread-1');
      expect(actions.attachThread).not.toHaveBeenCalled();
    });

    it('starts a plain thread when the action is not the caller’s', async () => {
      const actions = actionService(null);
      const { controller, threadService, messageService } = buildController({}, actions);
      const { res } = mockResponse();

      await controller.generate(
        context as never,
        { prompt: 'hello', threadId: null, actionId: ACTION_ID } as never,
        res as never,
        {} as never,
      );

      expect(threadService.create).toHaveBeenCalledWith(expect.anything(), {
        model: 'Qwen3.8-27B-Uncensored',
      });
      expect(messageService.create.mock.calls.map(([, data]) => data.role)).toEqual(['user', 'assistant']);
      expect(actions.attachThread).not.toHaveBeenCalled();
    });
  });

  it('GET stream returns 204 when the thread is idle and nothing is in flight', async () => {
    const { controller } = buildController();
    const { res } = mockResponse();

    await controller.stream(context as never, 'thread-1', res as never, {} as never);

    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.end).toHaveBeenCalled();
  });

  /**
   * A reply streaming when the key or session it was asked with is revoked used to run to its end and keep
   * sending text.
   */
  describe('when the key or session behind a reply is revoked', () => {
    /** An unsigned JWT: the guard verified the real one, the controller only reads its claims. */
    function bearer(claims: Record<string, unknown>) {
      const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

      return { headers: { authorization: `Bearer ${part({ alg: 'HS256' })}.${part(claims)}.signature` } };
    }

    /** A real LiveChangesService on a fake database whose lookups answer `rows`; `revoke()` empties them and sends the notice. */
    function liveChangesWith(rows: unknown[]) {
      const dataSource = { query: jest.fn(async () => rows) };
      const liveChanges = new LiveChangesService(
        dataSource as never,
        { setContext: jest.fn(), log: jest.fn(), warn: jest.fn() } as never,
      );
      const revoke = async () => {
        dataSource.query.mockResolvedValue([]);
        liveChanges.dispatch(JSON.stringify({ userId: 'user-1', revoked: true }));
        await new Promise(setImmediate);
      };

      return { liveChanges, dataSource, revoke };
    }

    const signedIn = [{ '?column?': 1 }];

    it('refuses with 401 a bearer whose session was signed out, before anything is written', async () => {
      const { liveChanges } = liveChangesWith([]);
      const { controller, messageService, chatTurnService } = buildController({}, undefined, liveChanges);
      const { res } = mockResponse();

      await expect(
        controller.generate(
          context as never,
          { prompt: 'hello', threadId: 'thread-1' } as never,
          res as never,
          bearer({ sub: 'user-1', sid: 'sess-1' }) as never,
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(messageService.create).not.toHaveBeenCalled();
      expect(chatTurnService.enqueueGenerate).not.toHaveBeenCalled();
    });

    it('hands the turn the key that asked for it', async () => {
      const { liveChanges } = liveChangesWith(signedIn);
      const { controller, chatTurnService } = buildController({}, undefined, liveChanges);
      const { res, closeHandlers } = mockResponse();

      await controller.generate(
        context as never,
        { prompt: 'hello', threadId: 'thread-1' } as never,
        res as never,
        { apiKeyId: 'key-1' } as never,
      );

      expect(chatTurnService.enqueueGenerate).toHaveBeenCalledWith(
        expect.objectContaining({ credential: { kind: 'apiKey', keyId: 'key-1' } }),
      );
      closeHandlers.forEach((handler) => handler());
    });

    it('leaves alone a later turn on the thread once its own reply has ended', async () => {
      const { liveChanges, revoke } = liveChangesWith(signedIn);
      const { controller, broker } = buildController({}, undefined, liveChanges);
      const { res } = mockResponse();

      await controller.generate(
        context as never,
        { prompt: 'hello', threadId: 'thread-1' } as never,
        res as never,
        { apiKeyId: 'key-1' } as never,
      );
      // Its turn finished and ended the response; `finish` waits on a slow client.
      broker.complete('thread-1');
      Object.assign(res, { writableEnded: true });
      const later = broker.signal('thread-1');

      await revoke();

      expect(later.aborted).toBe(false);
    });

    it('stops the turn the way Stop does when the session that asked for it signs out', async () => {
      const { liveChanges, revoke } = liveChangesWith(signedIn);
      const { controller, broker } = buildController({}, undefined, liveChanges);
      const { res } = mockResponse();

      await controller.generate(
        context as never,
        { prompt: 'hello', threadId: 'thread-1' } as never,
        res as never,
        bearer({ sub: 'user-1', sid: 'sess-1' }) as never,
      );
      const signal = broker.signal('thread-1');

      await revoke();

      expect(signal.aborted).toBe(true);
      expect(res.end).toHaveBeenCalled();
    });

    it('ends only the viewer whose key was deleted and leaves the turn running', async () => {
      const { liveChanges, revoke } = liveChangesWith(signedIn);
      const { controller, broker } = buildController(
        {
          threadService: { findById: jest.fn(async () => ({ ...thread, generationStatus: 'running' })) },
        },
        undefined,
        liveChanges,
      );
      broker.ensure('thread-1');
      const signal = broker.signal('thread-1');
      const { res } = mockResponse();

      await controller.stream(context as never, 'thread-1', res as never, { apiKeyId: 'key-2' } as never);
      await revoke();

      expect(res.end).toHaveBeenCalled();
      expect(signal.aborted).toBe(false);
    });

    it('does not watch for a client that left before the reply was piped, nor abort the turn later', async () => {
      const { liveChanges, dataSource, revoke } = liveChangesWith(signedIn);
      const { controller, broker } = buildController({}, undefined, liveChanges);
      const { res } = mockResponse();
      // Node's own state once the socket closed during the awaits: `close` has fired, `end` was never called.
      Object.assign(res, { destroyed: true });

      await controller.generate(
        context as never,
        { prompt: 'hello', threadId: 'thread-1' } as never,
        res as never,
        { apiKeyId: 'key-1' } as never,
      );
      const signal = broker.signal('thread-1');
      const lookups = dataSource.query.mock.calls.length;

      await revoke();

      expect(dataSource.query).toHaveBeenCalledTimes(lookups);
      expect(signal.aborted).toBe(false);
    });

    it('refuses to attach a bearer whose session was signed out', async () => {
      const { liveChanges } = liveChangesWith([]);
      const { controller } = buildController({}, undefined, liveChanges);
      const { res } = mockResponse();

      await expect(
        controller.stream(
          context as never,
          'thread-1',
          res as never,
          bearer({ sub: 'user-1', sid: 'sess-1' }) as never,
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(res.writeHead).not.toHaveBeenCalled();
    });
  });
});

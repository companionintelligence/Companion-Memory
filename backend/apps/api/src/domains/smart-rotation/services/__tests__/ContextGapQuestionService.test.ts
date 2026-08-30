import type { LoggerService } from '@ci/common/logging';
import type { QuestionService } from '@ci/domains/intelligence';
import type { OllamaService } from '@ci/domains/llm';
import type { UserContextService } from '@ci/domains/memory';

import { ContextGapQuestionService } from '../ContextGapQuestionService';

function buildService(
  overrides: {
    dataSource?: { query: jest.Mock };
    questionService?: Partial<QuestionService>;
    userContextService?: Partial<UserContextService>;
    ollamaService?: Partial<OllamaService>;
  } = {},
) {
  const dataSource =
    overrides.dataSource ??
    ({
      query: jest.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('EXISTS')) {
          return [{ recent: false }];
        }

        if (sql.includes('category_coverage')) {
          return [{ category: 'health' }];
        }

        if (sql.includes('INSERT INTO ci.feed_queue')) {
          return [];
        }

        return [];
      }),
    } as { query: jest.Mock });

  const questionService = {
    create: jest.fn().mockResolvedValue({ id: 'q-new', text: 'generated?', category: 'health' }),
    ...overrides.questionService,
  } as unknown as QuestionService;

  const userContextService = {
    getUserContextForLLM: jest.fn().mockResolvedValue(null),
    formatContextForSystemPrompt: jest.fn().mockReturnValue(''),
    ...overrides.userContextService,
  } as unknown as UserContextService;

  const ollamaService = {
    chat: jest.fn().mockResolvedValue({
      message: { content: JSON.stringify({ text: 'What matters most to you at work?', category: 'career' }) },
    }),
    ...overrides.ollamaService,
  } as unknown as OllamaService;

  const logger = { setContext() {}, log() {}, warn() {}, error() {} } as unknown as LoggerService;

  const service = new ContextGapQuestionService(
    dataSource as never,
    questionService,
    userContextService,
    ollamaService,
    logger,
  );

  return { service, dataSource, questionService, userContextService, ollamaService };
}

describe('ContextGapQuestionService.tryGenerateAndEnqueue', () => {
  it('returns false without calling the LLM when a recent LLM question is already on cooldown', async () => {
    const { service, ollamaService, questionService } = buildService({
      dataSource: { query: jest.fn().mockResolvedValue([{ recent: true }]) },
    });

    const result = await service.tryGenerateAndEnqueue('user-1');

    expect(result).toBe(false);
    expect(ollamaService.chat).not.toHaveBeenCalled();
    expect(questionService.create).not.toHaveBeenCalled();
  });

  it('generates, creates, and enqueues a new LLM question on a cache/cooldown miss', async () => {
    const { service, questionService, dataSource } = buildService();

    const result = await service.tryGenerateAndEnqueue('user-1');

    expect(result).toBe(true);
    expect(questionService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({
        text: 'What matters most to you at work?',
        category: 'career',
        isSeedQuestion: false,
        createdByLlm: true,
        isActive: true,
        isPrivateTo: 'user-1',
      }),
      { emitCreated: true },
    );

    const insertCall = dataSource.query.mock.calls.find((call: unknown[]) =>
      String(call[0]).includes('INSERT INTO ci.feed_queue'),
    );
    expect(insertCall).toBeDefined();
    const [, params] = insertCall as [string, unknown[]];
    expect(params[1]).toBe('user-1');
    expect(params[2]).toBe('q-new');
  });

  it('names the weakest-coverage category as the target in the LLM prompt', async () => {
    const { service, ollamaService } = buildService({
      dataSource: {
        query: jest.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('EXISTS')) {
            return [{ recent: false }];
          }

          if (sql.includes('category_coverage')) {
            return [{ category: 'finance' }];
          }

          return [];
        }),
      },
    });

    await service.tryGenerateAndEnqueue('user-1');

    const [, messages] = (ollamaService.chat as jest.Mock).mock.calls[0] as [
      unknown,
      Array<{ content: string }>,
    ];
    expect(messages[0].content).toContain('Target category (lowest coverage): finance');
  });

  it('falls back to "General" in the prompt when no category coverage rows exist', async () => {
    const { service, ollamaService } = buildService({
      dataSource: {
        query: jest.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('EXISTS')) {
            return [{ recent: false }];
          }

          if (sql.includes('category_coverage')) {
            return [];
          }

          return [];
        }),
      },
    });

    await service.tryGenerateAndEnqueue('user-1');

    const [, messages] = (ollamaService.chat as jest.Mock).mock.calls[0] as [
      unknown,
      Array<{ content: string }>,
    ];
    expect(messages[0].content).toContain('Target category (lowest coverage): General');
  });

  it('bounds the generation call — signal, output cap, keep_alive — without changing the model', async () => {
    // Previously issued with none of these, so a hung generation blocked its
    // caller (SmartRotationListener) for as long as the fetch took to fail on
    // its own. The model stays PROMPT_MODEL deliberately — this is a
    // bounds-only fix, since the output is the actual question text a person
    // reads on their feed.
    const { service, ollamaService } = buildService({});

    await service.tryGenerateAndEnqueue('user-1');

    const [, , options] = (ollamaService.chat as jest.Mock).mock.calls[0] as [
      unknown,
      unknown,
      { signal?: AbortSignal; maxOutputTokens?: number; keepAlive?: string | number },
    ];

    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal?.aborted).toBe(false);
    expect(options.maxOutputTokens).toBeGreaterThan(0);
    expect(options.keepAlive).toBeTruthy();
  });

  it('does not create a question when the LLM returns malformed JSON', async () => {
    const { service, questionService } = buildService({
      ollamaService: { chat: jest.fn().mockResolvedValue({ message: { content: 'not valid json at all' } }) },
    });

    const result = await service.tryGenerateAndEnqueue('user-1');

    expect(result).toBe(false);
    expect(questionService.create).not.toHaveBeenCalled();
  });

  it('does not create a question when the LLM output fails schema validation', async () => {
    const { service, questionService } = buildService({
      ollamaService: {
        chat: jest.fn().mockResolvedValue({
          message: { content: JSON.stringify({ text: 'short', category: '' }) },
        }),
      },
    });

    const result = await service.tryGenerateAndEnqueue('user-1');

    expect(result).toBe(false);
    expect(questionService.create).not.toHaveBeenCalled();
  });

  it('returns false (and creates nothing) when the LLM call itself throws', async () => {
    const { service, questionService } = buildService({
      ollamaService: { chat: jest.fn().mockRejectedValue(new Error('ollama unreachable')) },
    });

    const result = await service.tryGenerateAndEnqueue('user-1');

    expect(result).toBe(false);
    expect(questionService.create).not.toHaveBeenCalled();
  });

  it('includes the formatted dossier in the prompt when user context is available', async () => {
    const { service, ollamaService } = buildService({
      userContextService: {
        getUserContextForLLM: jest.fn().mockResolvedValue({ some: 'context' }),
        formatContextForSystemPrompt: jest.fn().mockReturnValue('User likes hiking and jazz.'),
      },
    });

    await service.tryGenerateAndEnqueue('user-1');

    const [, messages] = (ollamaService.chat as jest.Mock).mock.calls[0] as [
      unknown,
      Array<{ content: string }>,
    ];
    expect(messages[0].content).toContain('User likes hiking and jazz.');
  });

  it('notes minimal/onboarding context in the prompt when there is no dossier yet', async () => {
    const { service, ollamaService } = buildService({
      userContextService: { getUserContextForLLM: jest.fn().mockResolvedValue(null) },
    });

    await service.tryGenerateAndEnqueue('user-1');

    const [, messages] = (ollamaService.chat as jest.Mock).mock.calls[0] as [
      unknown,
      Array<{ content: string }>,
    ];
    expect(messages[0].content).toContain('Known context: (minimal — user is still onboarding)');
  });
});

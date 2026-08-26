import { ModelTierRouter } from '@ci/domains/model-routing';

import { nearestModelIds, OllamaService, PROMPT_MODEL } from '../OllamaService';

/**
 * The boot-time chat-model check.
 *
 * ── Why this test exists ───────────────────────────────────────────────────
 *
 * `PROMPT_MODEL` is `LLM_DEFAULT_CHAT_MODEL`, read once at import. Every
 * background inference path hands it to `validateModel`, which throws `Invalid
 * model specified: <id>` — per job, forever, with nothing at boot saying the id
 * was wrong. A live appliance carried 94 dead letters of which 36 were exactly
 * that, all from `infer.question.answer`, all naming `qwen/qwen3-vl-30b` against
 * an Ollama backend whose closest real tag is `qwen3-vl:4b`.
 *
 * What is asserted here is therefore not "a method was called". It is the three
 * properties that decide whether an operator ever finds out:
 *
 *  1. an id the backend does not serve logs at **ERROR**, naming the served ids;
 *  2. an UNREACHABLE backend does NOT log at error — at boot the inference
 *     server routinely has not opened its port yet, and crying wolf there
 *     teaches operators to ignore the line that matters;
 *  3. the preflight NEVER throws, because a bad chat model must not stop an
 *     appliance whose main job is ingest from booting.
 */

/** Fake timers, scoped to the one test that drives the preflight's own timeout. */
function useFakeTimersForTimeout() {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
}

// Unconditional, so a failure inside the timeout test cannot leave fake timers
// installed for everything after it.
afterEach(() => {
  jest.useRealTimers();
});

function makeLogger() {
  return {
    setContext: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function buildService(served: string[] | Error) {
  const listModels = jest.fn(async () => {
    if (served instanceof Error) {
      throw served;
    }

    return served;
  });

  const logger = makeLogger();
  const service = new OllamaService(
    { getOpenAiDriver: () => ({ listModels, chat: jest.fn() }) } as never,
    { getAgentFacingTools: () => [] } as never,
    logger as never,
    { isFeatureEnabled: jest.fn(async () => false) } as never,
    new ModelTierRouter(),
  );

  return { service, logger, listModels };
}

/** The ids this appliance's Ollama actually serves, as `/api/tags` reported them. */
const APPLIANCE_TAGS = [
  'gabegoodhart/minimax-m2:230b',
  'qwen3.5:9b',
  'gemma3:1b',
  'qwen3.5:4b',
  'qwen3-vl:4b',
  'qwen3.6:27b',
  'gemma4:e4b',
  'gemma4:31b',
];

describe('OllamaService chat-model preflight', () => {
  it('logs an ERROR naming the served ids when the configured model is absent', async () => {
    const { service, logger } = buildService(APPLIANCE_TAGS.filter((id) => id !== PROMPT_MODEL));

    const result = await service.preflightChatModel();

    expect(result.available).toBe(false);
    expect(result.reachable).toBe(true);
    expect(logger.error).toHaveBeenCalledTimes(1);

    const [message] = logger.error.mock.calls[0] as [string];

    expect(message).toContain(PROMPT_MODEL);
    expect(message).toContain('LLM_DEFAULT_CHAT_MODEL');
    // The operator has to be able to connect this line to the dead letters it
    // predicts, so it quotes the error string those letters carry.
    expect(message).toContain(`Invalid model specified: ${PROMPT_MODEL}`);
    expect(message).toContain('qwen3-vl:4b');
  });

  it('logs at log-level, not error, when the configured model IS served', async () => {
    const { service, logger } = buildService([...APPLIANCE_TAGS, PROMPT_MODEL]);

    const result = await service.preflightChatModel();

    expect(result).toMatchObject({ model: PROMPT_MODEL, available: true, reachable: true });
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalled();
  });

  it('warns rather than errors when the backend did not answer', async () => {
    // "Could not verify" is a different claim from "your model id is wrong", and
    // at boot the inference server routinely is not up yet.
    const { service, logger } = buildService(new Error('connect ECONNREFUSED 127.0.0.1:11434'));

    const result = await service.preflightChatModel();

    expect(result).toMatchObject({ available: false, reachable: false, servedModels: [] });
    expect(result.reason).toContain('ECONNREFUSED');
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('says so plainly when the backend serves no chat models at all', async () => {
    const { service, logger } = buildService([]);

    const result = await service.preflightChatModel();

    expect(result).toMatchObject({ available: false, reachable: true, servedModels: [] });

    const [message] = logger.error.mock.calls[0] as [string];

    expect(message).toContain('serving no chat models at all');
  });

  it('never throws out of onModuleInit — a bad model must not stop the appliance booting', async () => {
    const { service } = buildService(new Error('backend exploded'));

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(service.chatModelPreflight).toMatchObject({ reachable: false });
  });

  it('gives up on a backend that accepts and then never answers', async () => {
    // A refused connection fails instantly; a HANGING one would otherwise hold
    // onModuleInit — and the whole boot — open forever.
    useFakeTimersForTimeout();

    const logger = makeLogger();
    const service = new OllamaService(
      {
        getOpenAiDriver: () => ({
          listModels: () => new Promise<string[]>(() => {}),
          chat: jest.fn(),
        }),
      } as never,
      { getAgentFacingTools: () => [] } as never,
      logger as never,
      { isFeatureEnabled: jest.fn(async () => false) } as never,
      new ModelTierRouter(),
    );

    const preflight = service.preflightChatModel();

    jest.advanceTimersByTime(5_000);

    const result = await preflight;

    expect(result).toMatchObject({ reachable: false });
    expect(result.reason).toMatch(/did not list its models/);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('records the last result for anything that wants to read it', async () => {
    const { service } = buildService([...APPLIANCE_TAGS, PROMPT_MODEL]);

    expect(service.chatModelPreflight).toBeNull();

    await service.onModuleInit();

    expect(service.chatModelPreflight).toMatchObject({ model: PROMPT_MODEL, available: true });
  });
});

describe('nearestModelIds', () => {
  it('turns the real defect into an actionable hint', () => {
    // `qwen/qwen3-vl-30b` is a vLLM/HuggingFace repo id. The Ollama tag that was
    // meant is `qwen3-vl:4b`, and it must outrank the other qwen families rather
    // than losing to them on list order.
    expect(nearestModelIds('qwen/qwen3-vl-30b', APPLIANCE_TAGS)[0]).toBe('qwen3-vl:4b');
  });

  it('matches across separator spelling, which is the whole class of typo', () => {
    expect(nearestModelIds('gemma4-e4b', APPLIANCE_TAGS)).toContain('gemma4:e4b');
  });

  it('suggests nothing when nothing is close, rather than a confident wrong answer', () => {
    expect(nearestModelIds('llama3.3:70b', ['gemma4:e4b', 'qwen3.5:9b'])).toEqual([]);
  });

  it('never suggests more than three', () => {
    const served = ['qwen3.5:2b', 'qwen3.5:4b', 'qwen3.5:9b', 'qwen3.6:27b', 'qwen3.6:35b'];

    expect(nearestModelIds('qwen3.5:30b', served)).toHaveLength(3);
  });

  it('is empty for an unusable configured id instead of matching everything', () => {
    expect(nearestModelIds('///', APPLIANCE_TAGS)).toEqual([]);
  });
});

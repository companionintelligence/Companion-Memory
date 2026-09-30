/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The planner against a fake Ollama, on the box the wedge happened on.
 *
 * `probeGpuMemory` is mocked so the test controls the card's counters; the
 * real one would read this machine's sysfs. `@ci/configuration` is the real
 * module with the three fields the planner reads overridden per test.
 */
import type { CalibrationStore } from '../../residency/calibrationStore';
import { GIB } from '../../residency/footprint';

const psMock = jest.fn();
const listMock = jest.fn();
const showMock = jest.fn();

jest.mock('ollama', () => ({
  Ollama: jest.fn().mockImplementation(() => ({
    ps: (...args: any[]) => psMock(...args),
    list: (...args: any[]) => listMock(...args),
    show: (...args: any[]) => showMock(...args),
  })),
}));

const probeMock = jest.fn();

jest.mock('../../residency/gpuMemory', () => ({
  probeGpuMemory: (...args: any[]) => probeMock(...args),
}));

const QWEN_WEIGHTS = 17_420_432_739;
const QWEN_RESIDENT_32K = 18_496_995_982;
const GEMMA4_WEIGHTS = 9_608_350_718;
const CARD = 25_753_026_560;

const TAGS = {
  models: [
    { name: 'gemma4:e4b', size: GEMMA4_WEIGHTS },
    { name: 'qwen3.6:27b', size: QWEN_WEIGHTS },
    { name: 'nomic-embed-text:latest', size: 274_302_450 },
  ],
};

const SHOW: Record<string, any> = {
  'gemma4:e4b': {
    model_info: {
      'general.architecture': 'gemma4',
      'gemma4.block_count': 42,
      'gemma4.attention.head_count': 8,
      'gemma4.attention.head_count_kv': 2,
      'gemma4.attention.key_length': 512,
      'gemma4.attention.value_length': 512,
      'gemma4.attention.shared_kv_layers': 18,
      'gemma4.context_length': 131_072,
    },
  },
  'nomic-embed-text': {
    model_info: {
      'general.architecture': 'nomic-bert',
      'nomic-bert.block_count': 12,
      'nomic-bert.attention.head_count': 12,
      'nomic-bert.context_length': 2_048,
      'nomic-bert.embedding_length': 768,
    },
  },
};

function makeLogger() {
  return { setContext: jest.fn(), debug: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

interface Overrides {
  mode?: 'auto' | 'off';
  utilityModel?: string;
  chatModel?: string;
  openAi?: boolean;
  /** What the OpenAI-compatible endpoint's `/v1/models` lists; absent, the driver has no `listModels`. */
  servedModels?: string[] | Error;
  loadWatchdogMs?: number;
  cooldownMs?: number;
  calibration?: CalibrationStore;
}

/** A store that keeps everything in memory; tests read `saved` to see what was persisted. */
function memoryStore(initial: Map<string, any> = new Map()) {
  const saved: Map<string, any>[] = [];
  const store = {
    load: () => new Map(initial),
    save: (observations: Map<string, any>) => {
      saved.push(new Map(observations));

      return ['memory'];
    },
  } as unknown as CalibrationStore;

  return { store, saved };
}

function loadService(overrides: Overrides = {}) {
  jest.resetModules();
  jest.doMock('@ci/configuration', () => {
    const actual = jest.requireActual('@ci/configuration');

    return {
      __esModule: true,
      ...actual,
      default: {
        ...actual.default,
        llm: {
          ...actual.default.llm,
          chatModel: overrides.chatModel ?? 'qwen3.6:27b',
          utilityModel: overrides.utilityModel ?? 'gemma4:e4b',
          residency: {
            mode: overrides.mode ?? 'auto',
            vramTotalBytes: 0,
            safetyMarginBytes: GIB,
            maxUtilityContextTokens: 32_768,
            loadWatchdogMs: overrides.loadWatchdogMs ?? 120_000,
            cooldownMs: overrides.cooldownMs ?? 15 * 60_000,
          },
        },
        embedding: { ...actual.default.embedding, model: 'nomic-embed-text' },
      },
    };
  });

  // eslint-disable-next-line @typescript-eslint/no-require-imports -- must load AFTER the mock above
  const { ResidencyPlannerService } = require('../ResidencyPlannerService');
  // The planner recognises the deadline error by `instanceof`, so the test has to
  // construct it from the SAME fresh module registry the planner imported.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- same registry as the planner
  const { LlmFirstResponseTimeoutError } = require('../../firstResponseDeadline');
  const logger = makeLogger();
  const endpoint = {
    getOllamaHost: () => 'http://localhost:11434',
    usesOpenAiDriver: () => overrides.openAi === true,
    getOpenAiDriver: () =>
      overrides.openAi
        ? overrides.servedModels === undefined
          ? {}
          : {
              listModels: jest.fn(async () => {
                if (overrides.servedModels instanceof Error) {
                  throw overrides.servedModels;
                }

                return overrides.servedModels;
              }),
            }
        : null,
  };
  const calibration = overrides.calibration ?? memoryStore().store;
  const service = new ResidencyPlannerService(endpoint as any, logger as any, calibration);

  return { service, logger, LlmFirstResponseTimeoutError };
}

afterEach(() => {
  jest.useRealTimers();
});

beforeEach(() => {
  jest.clearAllMocks();
  listMock.mockResolvedValue(TAGS);
  showMock.mockImplementation(async ({ model }: { model: string }) => {
    const entry = SHOW[model.replace(/:latest$/, '')];

    if (!entry) {
      throw new Error(`model "${model}" not found`);
    }

    return entry;
  });
});

describe('ResidencyPlannerService on the wedge box', () => {
  const residentChatAndEmbed = {
    models: [
      { name: 'qwen3.6:27b', size_vram: QWEN_RESIDENT_32K, context_length: 32_768 },
      { name: 'nomic-embed-text:latest', size_vram: 323_150_151, context_length: 2_048 },
    ],
  };

  it('routes utility calls to the resident 27B at its own window when gemma4 cannot fit beside it', async () => {
    psMock.mockResolvedValue(residentChatAndEmbed);
    probeMock.mockResolvedValue({
      totalBytes: CARD,
      usedBytes: 22_240_452_608,
      source: 'sysfs',
      device: 'card1',
    });
    const { service, logger } = loadService();

    await expect(service.resolveUtilityModel()).resolves.toEqual({
      model: 'qwen3.6:27b',
      numCtx: 32_768,
      kind: 'routed',
    });

    const report = service.residencyReport;

    expect(report?.plan.kind).toBe('routed');
    expect(report?.embedReserveBytes).toBe(0);
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('routed to chat model @32768'));
  });

  it('lets gemma4 load at 32k once the 27B is gone and the card is mostly free', async () => {
    psMock.mockResolvedValue({ models: [residentChatAndEmbed.models[1]] });
    probeMock.mockResolvedValue({ totalBytes: CARD, usedBytes: 3.5 * GIB, source: 'sysfs', device: 'card1' });
    const { service } = loadService();

    await expect(service.resolveUtilityModel()).resolves.toEqual({
      model: 'gemma4:e4b',
      numCtx: 32_768,
      kind: 'load',
    });
    expect(showMock).toHaveBeenCalledWith({ model: 'gemma4:e4b' });
  });

  it('uses a resident utility model at the window it is loaded with, without asking /api/show', async () => {
    psMock.mockResolvedValue({
      models: [
        ...residentChatAndEmbed.models,
        { name: 'gemma4:e4b', size_vram: 11 * GIB, context_length: 8_192 },
      ],
    });
    probeMock.mockResolvedValue({ totalBytes: CARD, usedBytes: CARD - GIB, source: 'sysfs' });
    const { service } = loadService();

    await expect(service.resolveUtilityModel()).resolves.toEqual({
      model: 'gemma4:e4b',
      numCtx: 8_192,
      kind: 'resident',
    });
  });

  it('reserves room for the embedder when it is not resident', async () => {
    psMock.mockResolvedValue({ models: [] });
    probeMock.mockResolvedValue({ totalBytes: CARD, usedBytes: 0, source: 'sysfs' });
    const { service } = loadService();

    await service.resolveUtilityModel();

    const reserve = service.residencyReport?.embedReserveBytes ?? 0;

    // weights (274 MB) + 12 layers × 12 heads × 128 × 2 B × 2048 tokens + fixed overhead
    expect(reserve).toBeGreaterThan(274_302_450);
    expect(reserve).toBeLessThan(1.5 * GIB);
    expect(showMock).toHaveBeenCalledWith({ model: 'nomic-embed-text' });
  });

  it('routes to the chat model when GPU memory cannot be read, and says so at boot', async () => {
    psMock.mockResolvedValue(residentChatAndEmbed);
    probeMock.mockResolvedValue(null);
    const { service, logger } = loadService();

    await expect(service.resolveUtilityModel()).resolves.toEqual({
      model: 'qwen3.6:27b',
      numCtx: 32_768,
      kind: 'routed',
    });

    await service.preflight();

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('GPU memory could not be read'));
  });

  it('shares one backend probe across a burst of concurrent calls', async () => {
    psMock.mockResolvedValue(residentChatAndEmbed);
    probeMock.mockResolvedValue({ totalBytes: CARD, usedBytes: 22 * GIB, source: 'sysfs' });
    const { service } = loadService();

    await Promise.all(Array.from({ length: 10 }, () => service.resolveUtilityModel()));

    expect(psMock).toHaveBeenCalledTimes(1);
    expect(probeMock).toHaveBeenCalledTimes(1);
  });

  it('logs the plan once per CHANGE, not once per call', async () => {
    psMock.mockResolvedValue(residentChatAndEmbed);
    probeMock.mockResolvedValue({ totalBytes: CARD, usedBytes: 22 * GIB, source: 'sysfs' });
    const { service, logger } = loadService();

    await service.resolveUtilityModel();
    await service.resolveUtilityModel();

    expect(logger.log.mock.calls.filter(([line]: [string]) => line.includes('residency plan'))).toHaveLength(
      1,
    );
  });

  it('degrades to the bare configured id when the backend is down, and never throws', async () => {
    psMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const { service, logger } = loadService();

    await expect(service.resolveUtilityModel()).resolves.toEqual({ model: 'gemma4:e4b' });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Residency planning failed'),
      expect.anything(),
    );

    await expect(service.preflight()).resolves.toBeNull();
  });

  it('is inert when LLM_RESIDENCY_MODE=off', async () => {
    const { service } = loadService({ mode: 'off' });

    await expect(service.resolveUtilityModel()).resolves.toEqual({ model: 'gemma4:e4b' });
    expect(psMock).not.toHaveBeenCalled();
  });

  it('is inert on an OpenAI-compatible backend', async () => {
    const { service } = loadService({ openAi: true });

    await expect(service.resolveUtilityModel()).resolves.toEqual({ model: 'gemma4:e4b' });
    expect(psMock).not.toHaveBeenCalled();
  });

  // A Lemonade-only node (2026-09-29): `gemma4:e4b` is the unset default and Lemonade does not serve
  // it, so every utility job failed "Invalid model specified". Same rule as the Ollama planner:
  // not served → the chat model.
  it('runs utility calls on the chat model when the OpenAI-compatible endpoint does not serve the utility model', async () => {
    const { service, logger } = loadService({
      openAi: true,
      chatModel: 'Qwen3.8-27B-GGUF',
      servedModels: ['Qwen3.8-27B-GGUF', 'nomic-embed-text-v1.5-GGUF'],
    });

    await expect(service.resolveUtilityModel()).resolves.toEqual({ model: 'Qwen3.8-27B-GGUF' });
    await expect(service.resolveUtilityModel()).resolves.toEqual({ model: 'Qwen3.8-27B-GGUF' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(psMock).not.toHaveBeenCalled();
  });

  it('keeps a served utility model, and the configured id when the list cannot be read or names neither', async () => {
    await expect(
      loadService({
        openAi: true,
        chatModel: 'Qwen3.8-27B-GGUF',
        servedModels: ['Qwen3.8-27B-GGUF', 'gemma4:e4b'],
      }).service.resolveUtilityModel(),
    ).resolves.toEqual({ model: 'gemma4:e4b' });
    await expect(
      loadService({
        openAi: true,
        chatModel: 'Qwen3.8-27B-GGUF',
        servedModels: new Error('502'),
      }).service.resolveUtilityModel(),
    ).resolves.toEqual({ model: 'gemma4:e4b' });
    await expect(
      loadService({
        openAi: true,
        chatModel: 'Qwen3.8-27B-GGUF',
        servedModels: ['something-else'],
      }).service.resolveUtilityModel(),
    ).resolves.toEqual({ model: 'gemma4:e4b' });
  });
});

describe('persisted calibration', () => {
  const residentChat = {
    models: [{ name: 'qwen3.6:27b', size_vram: QWEN_RESIDENT_32K, context_length: 32_768 }],
  };

  it('writes each new sighting to the store and does not rewrite an unchanged one', async () => {
    psMock.mockResolvedValue(residentChat);
    probeMock.mockResolvedValue({ totalBytes: CARD, usedBytes: 22 * GIB, source: 'sysfs' });
    const { store, saved } = memoryStore();
    const { service } = loadService({ calibration: store });

    await service.resolveUtilityModel();

    expect(saved).toHaveLength(1);
    expect(saved[0].get('qwen3.6:27b')).toMatchObject({
      numCtx: 32_768,
      sizeVramBytes: QWEN_RESIDENT_32K,
      weightBytes: QWEN_WEIGHTS,
      seenAt: expect.any(String),
    });

    // Same residents again, past the snapshot TTL: nothing new to persist.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    jest.setSystemTime(Date.now() + 10_000);
    await service.resolveUtilityModel();

    expect(saved).toHaveLength(1);
  });

  it('uses a sighting loaded from disk to plan a hybrid model at a far larger window than the blind formula allows', async () => {
    // qwen3.6:27b as the UTILITY model, not resident, ~19 GiB of headroom. Blind, the formula counts every
    // fourth layer at full heads: 29 GiB at 32k, 18.5 GiB at 4k — so only the bottom rung fits. With the
    // persisted 32k sighting the whole curve drops to 17.2–18.5 GiB and the top rung fits.
    showMock.mockImplementation(async ({ model }: { model: string }) =>
      model === 'qwen3.6:27b'
        ? {
            model_info: {
              'general.architecture': 'qwen35',
              'qwen35.block_count': 64,
              'qwen35.attention.head_count': 24,
              'qwen35.attention.key_length': 256,
              'qwen35.attention.value_length': 256,
              'qwen35.full_attention_interval': 4,
              'qwen35.context_length': 262_144,
            },
          }
        : SHOW[model.replace(/:latest$/, '')],
    );
    psMock.mockResolvedValue({
      models: [{ name: 'nomic-embed-text:latest', size_vram: 323_150_151, context_length: 2_048 }],
    });
    probeMock.mockResolvedValue({ totalBytes: CARD, usedBytes: 4 * GIB, source: 'sysfs' });

    const blind = loadService({ utilityModel: 'qwen3.6:27b', chatModel: 'gemma4:e4b' });

    await expect(blind.service.resolveUtilityModel()).resolves.toMatchObject({
      model: 'qwen3.6:27b',
      kind: 'load',
      numCtx: 4_096,
    });

    const { store } = memoryStore(
      new Map([
        [
          'qwen3.6:27b',
          { numCtx: 32_768, sizeVramBytes: QWEN_RESIDENT_32K, weightBytes: QWEN_WEIGHTS, seenAt: 'x' },
        ],
      ]),
    );
    const calibrated = loadService({
      utilityModel: 'qwen3.6:27b',
      chatModel: 'gemma4:e4b',
      calibration: store,
    });

    await expect(calibrated.service.resolveUtilityModel()).resolves.toMatchObject({
      model: 'qwen3.6:27b',
      kind: 'load',
      numCtx: 32_768,
    });
    expect(calibrated.logger.log).toHaveBeenCalledWith(
      expect.stringContaining('persisted GPU residency observation'),
      expect.anything(),
    );
  });
});

describe('load watchdog and cooldown', () => {
  const embedOnly = {
    models: [{ name: 'nomic-embed-text:latest', size_vram: 323_150_151, context_length: 2_048 }],
  };
  const roomy = { totalBytes: CARD, usedBytes: 3.5 * GIB, source: 'sysfs' as const };

  it('pauses co-residency when a planned load has not appeared in /api/ps by the deadline, then resumes after the cooldown', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    psMock.mockResolvedValue(embedOnly);
    probeMock.mockResolvedValue(roomy);
    const { service, logger } = loadService({ loadWatchdogMs: 1_000, cooldownMs: 60_000 });

    await expect(service.resolveUtilityModel()).resolves.toMatchObject({ model: 'gemma4:e4b', kind: 'load' });

    // The deadline passes and the model is still not resident.
    await jest.advanceTimersByTimeAsync(1_100);

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('GPU co-residency paused'));

    // Every utility call now goes to the chat model, even though the card has room.
    await expect(service.resolveUtilityModel()).resolves.toMatchObject({
      model: 'qwen3.6:27b',
      kind: 'routed',
    });
    expect(service.residencyReport?.coResidencyBlocked).not.toBeNull();

    // The cooldown ends and loads are planned again.
    await jest.advanceTimersByTimeAsync(61_000);
    await expect(service.resolveUtilityModel()).resolves.toMatchObject({ model: 'gemma4:e4b', kind: 'load' });
    expect(service.residencyReport?.coResidencyBlocked).toBeNull();
  });

  it('stands down when the model shows up before the deadline', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    psMock.mockResolvedValue(embedOnly);
    probeMock.mockResolvedValue(roomy);
    const { service, logger } = loadService({ loadWatchdogMs: 1_000 });

    await service.resolveUtilityModel();

    psMock.mockResolvedValue({
      models: [...embedOnly.models, { name: 'gemma4:e4b', size_vram: 11 * GIB, context_length: 32_768 }],
    });
    await jest.advanceTimersByTimeAsync(1_100);

    expect(logger.error).not.toHaveBeenCalled();
    await expect(service.resolveUtilityModel()).resolves.toMatchObject({
      model: 'gemma4:e4b',
      kind: 'resident',
    });
  });

  it('pauses at once when the load-carrying call hits the first-response deadline', async () => {
    psMock.mockResolvedValue(embedOnly);
    probeMock.mockResolvedValue(roomy);
    const { service, logger, LlmFirstResponseTimeoutError } = loadService();
    const choice = await service.resolveUtilityModel();

    expect(choice.kind).toBe('load');

    service.noteUtilityOutcome(choice, {
      ok: false,
      error: new LlmFirstResponseTimeoutError('gemma4:e4b', 90_000),
    });

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('never started answering'));
    await expect(service.resolveUtilityModel()).resolves.toMatchObject({
      model: 'qwen3.6:27b',
      kind: 'routed',
    });
  });

  it('ignores ordinary errors and non-load choices', async () => {
    psMock.mockResolvedValue(embedOnly);
    probeMock.mockResolvedValue(roomy);
    const { service, logger, LlmFirstResponseTimeoutError } = loadService();
    const choice = await service.resolveUtilityModel();

    service.noteUtilityOutcome(choice, { ok: false, error: new Error('400 invalid schema') });
    service.noteUtilityOutcome(
      { model: 'qwen3.6:27b', kind: 'routed' },
      { ok: false, error: new LlmFirstResponseTimeoutError('qwen3.6:27b', 90_000) },
    );

    expect(logger.error).not.toHaveBeenCalled();
    await expect(service.resolveUtilityModel()).resolves.toMatchObject({ kind: 'load' });
  });

  it('a successful load clears the watchdog and refreshes the snapshot so the sighting is recorded', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    psMock.mockResolvedValue(embedOnly);
    probeMock.mockResolvedValue(roomy);
    const { store, saved } = memoryStore();
    const { service, logger } = loadService({ loadWatchdogMs: 1_000, calibration: store });
    const choice = await service.resolveUtilityModel();

    psMock.mockResolvedValue({
      models: [...embedOnly.models, { name: 'gemma4:e4b', size_vram: 11 * GIB, context_length: 32_768 }],
    });
    service.noteUtilityOutcome(choice, { ok: true });
    await service.resolveUtilityModel();

    expect(saved.at(-1)?.get('gemma4:e4b')).toMatchObject({ numCtx: 32_768, sizeVramBytes: 11 * GIB });

    // Nothing left for the timer to complain about.
    psMock.mockResolvedValue(embedOnly);
    await jest.advanceTimersByTimeAsync(1_100);
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('ResidencyPlannerService.resolveChatContextTokens', () => {
  const residentChatAndEmbed = {
    models: [
      { name: 'qwen3.6:27b', size_vram: QWEN_RESIDENT_32K, context_length: 32_768 },
      { name: 'nomic-embed-text:latest', size_vram: 323_150_151, context_length: 2_048 },
    ],
  };

  it('returns the loaded window of a resident chat model, without asking /api/show for it', async () => {
    psMock.mockResolvedValue(residentChatAndEmbed);
    probeMock.mockResolvedValue({
      totalBytes: CARD,
      usedBytes: 22_240_452_608,
      source: 'sysfs',
      device: 'card1',
    });
    const { service, logger } = loadService();

    await expect(service.resolveChatContextTokens()).resolves.toBe(32_768);
    expect(showMock).not.toHaveBeenCalledWith({ model: 'qwen3.6:27b' });
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('already resident at that window'));

    // Steady state: the same answer again logs nothing new.
    logger.log.mockClear();
    await expect(service.resolveChatContextTokens()).resolves.toBe(32_768);
    expect(logger.log).not.toHaveBeenCalledWith(expect.stringContaining('Chat context'));
  });

  it('plans the largest rung that fits the card when the chat model is not loaded (gemma4 as chat, empty card)', async () => {
    psMock.mockResolvedValue({ models: [] });
    probeMock.mockResolvedValue({ totalBytes: CARD, usedBytes: 0, source: 'sysfs', device: 'card1' });
    const { service, logger } = loadService({ chatModel: 'gemma4:e4b' });

    await expect(service.resolveChatContextTokens()).resolves.toBe(32_768);
    expect(showMock).toHaveBeenCalledWith({ model: 'gemma4:e4b' });
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('Chat context for "gemma4:e4b": 32768 tokens'),
    );
  });

  it('answers null, never a guess, when the planner is off or the backend is OpenAI-compatible', async () => {
    psMock.mockResolvedValue(residentChatAndEmbed);
    probeMock.mockResolvedValue({ totalBytes: CARD, usedBytes: 0, source: 'sysfs' });
    await expect(loadService({ mode: 'off' }).service.resolveChatContextTokens()).resolves.toBeNull();
    await expect(loadService({ openAi: true }).service.resolveChatContextTokens()).resolves.toBeNull();
  });

  it('answers the window it already planned while that load is in flight, and re-plans once it lapses', async () => {
    // Two callers planning from scratch mid-load took turns reloading the 27B at 32k and 4k
    // (2026-09-22). The first plan is now the answer for as long as the load watchdog runs.
    jest.useFakeTimers({ now: new Date('2026-09-22T12:00:00Z') });
    psMock.mockResolvedValue({ models: [] });
    probeMock.mockResolvedValue({ totalBytes: CARD, usedBytes: 0, source: 'sysfs', device: 'card1' });
    const { service } = loadService({ chatModel: 'gemma4:e4b' });

    await expect(service.resolveChatContextTokens()).resolves.toBe(32_768);

    // The card "shrinks" (a different probe answer) — a fresh plan would say 4k or nothing.
    probeMock.mockResolvedValue({ totalBytes: 10 * GIB, usedBytes: 0, source: 'sysfs', device: 'card1' });
    jest.setSystemTime(Date.now() + 30_000);
    await expect(service.resolveChatContextTokens()).resolves.toBe(32_768);

    jest.setSystemTime(Date.now() + 3 * 60_000);
    await expect(service.resolveChatContextTokens()).resolves.not.toBe(32_768);
  });

  it('lets a resident model outrank the memo, at the window it is actually loaded with', async () => {
    jest.useFakeTimers({ now: new Date('2026-09-22T12:00:00Z') });
    psMock.mockResolvedValueOnce({ models: [] }).mockResolvedValue({
      models: [{ name: 'gemma4:e4b', size_vram: 12 * GIB, context_length: 16_384 }],
    });
    probeMock.mockResolvedValue({ totalBytes: CARD, usedBytes: 0, source: 'sysfs', device: 'card1' });
    const { service } = loadService({ chatModel: 'gemma4:e4b' });

    await expect(service.resolveChatContextTokens()).resolves.toBe(32_768);
    jest.setSystemTime(Date.now() + 5_000);
    await expect(service.resolveChatContextTokens()).resolves.toBe(16_384);
  });

  it('answers null when the backend cannot be reached, and says so once', async () => {
    psMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const { service, logger } = loadService();

    await expect(service.resolveChatContextTokens()).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      'Chat context planning failed; the chat path keeps its configured fallback',
      expect.objectContaining({ error: 'ECONNREFUSED' }),
    );
  });
});

describe('card-level calibration', () => {
  const chatAndEmbed = {
    models: [
      { name: 'qwen3.6:27b', size_vram: QWEN_RESIDENT_32K, context_length: 32_768 },
      { name: 'nomic-embed-text:latest', size_vram: 323_150_151, context_length: 2_048 },
    ],
  };
  const sysfs = (usedBytes: number) => ({ totalBytes: CARD, usedBytes, source: 'sysfs', device: 'card1' });

  /** Advance past the snapshot TTL so the next call probes again. */
  const tick = (ms = 5_000) => jest.setSystemTime(Date.now() + ms);

  it('takes no card figure for a runner that was already there at its first look — its age is unknown', async () => {
    // The 2026-09-22 file: a process that boots beside a runner leaking for hours would
    // otherwise record the whole card (23.7 GiB) as that model's footprint.
    psMock.mockResolvedValue(chatAndEmbed);
    probeMock.mockResolvedValue(sysfs(23 * GIB));
    const { store, saved } = memoryStore();
    const { service } = loadService({ calibration: store });

    await service.resolveChatContextTokens();

    const record = saved.at(-1)?.get('qwen3.6:27b');
    expect(record).toMatchObject({ numCtx: 32_768 });
    expect(record?.cardBytes).toBeUndefined();
  });

  it("attributes the card's unaccounted bytes to a runner it saw arrive, and persists them with the layout", async () => {
    jest.useFakeTimers({ now: new Date('2026-09-22T12:00:00Z') });
    psMock.mockResolvedValueOnce({ models: [] }).mockResolvedValue(chatAndEmbed);
    // sysfs says 23 GiB in use once loaded; Ollama's two residents account for ~17.5 GiB of it.
    probeMock.mockResolvedValueOnce(sysfs(0)).mockResolvedValue(sysfs(23 * GIB));
    const { store, saved } = memoryStore();
    const { service } = loadService({ calibration: store });

    await service.resolveChatContextTokens();
    tick();
    await service.resolveChatContextTokens();

    const record = saved.at(-1)?.get('qwen3.6:27b');
    expect(record).toMatchObject({ numCtx: 32_768, totalTokens: 32_768 });
    expect(record?.cardBytes).toBe(23 * GIB - 323_150_151);
    // The embedder never gets a card figure: the buffers are not its.
    expect(saved.at(-1)?.get('nomic-embed-text')?.cardBytes).toBeUndefined();
  });

  it('lets the baseline grow inside the first minutes, then freezes it for the life of that runner', async () => {
    jest.useFakeTimers({ now: new Date('2026-09-22T12:00:00Z') });
    psMock.mockResolvedValueOnce({ models: [] }).mockResolvedValue(chatAndEmbed);
    probeMock
      .mockResolvedValueOnce(sysfs(0))
      .mockResolvedValueOnce(sysfs(22 * GIB)) // t+5s: first look at the new runner
      .mockResolvedValueOnce(sysfs(23 * GIB)) // t+1min: the vision encoder has been exercised
      .mockResolvedValue(sysfs(24.5 * GIB)); // t+11min onward: growth, not baseline
    const { store, saved } = memoryStore();
    const { service } = loadService({ calibration: store });

    await service.resolveChatContextTokens();
    tick();
    await service.resolveChatContextTokens();
    expect(saved.at(-1)?.get('qwen3.6:27b')?.cardBytes).toBe(22 * GIB - 323_150_151);
    tick(60_000);
    await service.resolveChatContextTokens();
    expect(saved.at(-1)?.get('qwen3.6:27b')?.cardBytes).toBe(23 * GIB - 323_150_151);
    tick(10 * 60_000);
    await service.resolveChatContextTokens();
    tick(60_000);
    await service.resolveChatContextTokens();
    expect(saved.at(-1)?.get('qwen3.6:27b')?.cardBytes).toBe(23 * GIB - 323_150_151);
  });

  it('starts a fresh baseline when the runner reloads, replacing the old figure rather than ratcheting', async () => {
    jest.useFakeTimers({ now: new Date('2026-09-22T12:00:00Z') });
    psMock
      .mockResolvedValueOnce({ models: [] })
      .mockResolvedValueOnce(chatAndEmbed)
      .mockResolvedValueOnce({ models: [] })
      .mockResolvedValue(chatAndEmbed);
    probeMock
      .mockResolvedValueOnce(sysfs(0))
      .mockResolvedValueOnce(sysfs(23 * GIB))
      .mockResolvedValueOnce(sysfs(0))
      .mockResolvedValue(sysfs(20 * GIB));
    const { store, saved } = memoryStore();
    const { service } = loadService({ calibration: store });

    for (let i = 0; i < 4; i += 1) {
      await service.resolveChatContextTokens();
      tick();
    }

    expect(saved.at(-1)?.get('qwen3.6:27b')?.cardBytes).toBe(20 * GIB - 323_150_151);
  });

  it('treats a model that arrives after it was planned as a new runner, even at the same window and size', async () => {
    // A reload to an identical layout is invisible in /api/ps; the planned-then-resident
    // transition is the tell. Same-size fixture on both sides, so only the transition can
    // explain a fresh baseline.
    jest.useFakeTimers({ now: new Date('2026-09-22T12:00:00Z') });
    const chatOnly = { models: [{ name: 'gemma4:e4b', size_vram: 12 * GIB, context_length: 32_768 }] };
    psMock
      .mockResolvedValueOnce(chatOnly) // present at first look: unwitnessed, no card figure
      .mockResolvedValueOnce({ models: [] }) // evicted
      .mockResolvedValue(chatOnly); // back, identical
    probeMock
      .mockResolvedValueOnce(sysfs(13 * GIB))
      .mockResolvedValueOnce(sysfs(0))
      .mockResolvedValue(sysfs(14 * GIB));
    const { store, saved } = memoryStore();
    const { service } = loadService({ chatModel: 'gemma4:e4b', calibration: store });

    await service.resolveChatContextTokens();
    expect(saved.at(-1)?.get('gemma4:e4b')?.cardBytes).toBeUndefined();
    tick();
    await expect(service.resolveChatContextTokens()).resolves.toBe(32_768); // planned: memo set
    tick();
    await service.resolveChatContextTokens();

    expect(saved.at(-1)?.get('gemma4:e4b')?.cardBytes).toBe(14 * GIB);
  });

  it('plans 32k from a poisoned file rather than 4k: a sighting the card cannot hold is not a measurement', async () => {
    const poisoned = new Map([
      [
        'gemma4:e4b',
        {
          numCtx: 32_768,
          sizeVramBytes: 12 * GIB,
          weightBytes: GEMMA4_WEIGHTS,
          seenAt: '2026-09-22T16:43:58.922Z',
          cardBytes: 25_421_131_449,
          totalTokens: 32_768,
        },
      ],
    ]);
    psMock.mockResolvedValue({ models: [] });
    probeMock.mockResolvedValue(sysfs(0));
    const { service } = loadService({ chatModel: 'gemma4:e4b', calibration: memoryStore(poisoned).store });

    await expect(service.resolveChatContextTokens()).resolves.toBe(32_768);
  });

  it("records no card figure from the `config` source, which only echoes Ollama's own numbers back", async () => {
    psMock.mockResolvedValue({
      models: [{ name: 'qwen3.6:27b', size_vram: QWEN_RESIDENT_32K, context_length: 32_768 }],
    });
    probeMock.mockResolvedValue({ totalBytes: CARD, usedBytes: QWEN_RESIDENT_32K, source: 'config' });
    const { store, saved } = memoryStore();
    const { service } = loadService({ calibration: store });

    await service.resolveChatContextTokens();

    expect(saved.at(-1)?.get('qwen3.6:27b')?.cardBytes).toBeUndefined();
  });
});

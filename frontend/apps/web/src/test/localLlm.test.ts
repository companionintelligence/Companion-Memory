import { setApiKey } from '@ci/common/src/utils/apiAuth';
import { setApiBaseUrl } from '@ci/common/src/utils/apiBase';
import {
  cancelLocalLlmDownload,
  deleteLocalLlmModel,
  downloadLocalLlmModel,
  ensureLocalLlmLoaded,
  isContextExhausted,
  isLocalLlmReady,
  localLlmPlatform,
  probeLocalLlm,
  resetLocalLlmConversation,
  streamLocalLlm,
} from '@ci/common/src/utils/localLlm';
import { LOCAL_LLM_CATALOG, LOCAL_LLM_DISK_HEADROOM_BYTES } from '@ci/common/src/utils/localLlmCatalog';
import { afterEach, describe, expect, it, vi } from 'vitest';

type GlobalWithWindow = { window?: unknown };
type Listener = (event: never) => void;

const GIB = 1024 * 1024 * 1024;

function setWindow(value: unknown): void {
  (globalThis as GlobalWithWindow).window = value;
}

/**
 * A stand-in for `window.Capacitor.Plugins.LocalLLM`. `emit()` drives the registered listeners the way the
 * native side's `notifyListeners` does, so streaming and progress plumbing run without a device.
 */
function fakeLlm(overrides: Record<string, unknown> = {}) {
  const listeners = new Map<string, Set<Listener>>();
  const removed: string[] = [];

  const plugin = {
    isAvailable: vi.fn(async () => ({ available: true, totalMemoryBytes: 8 * GIB, freeDiskBytes: 40 * GIB })),
    getModelStatus: vi.fn(async () => ({ status: 'not_downloaded' })),
    downloadModel: vi.fn(async () => {}),
    cancelDownload: vi.fn(async () => {}),
    deleteModel: vi.fn(async () => {}),
    loadModel: vi.fn(async ({ accelerator }: { accelerator?: string }) => ({
      toolCount: 0,
      accelerator: accelerator ?? 'cpu',
      fellBackToCpu: false,
      speculativeDecoding: false,
    })),
    getLoadedModel: vi.fn(async () => ({ loaded: false })),
    configureIntentTools: vi.fn(async () => {}),
    resetConversation: vi.fn(async () => {}),
    unloadModel: vi.fn(async () => {}),
    generateStream: vi.fn(
      async (_options: { prompt: string; enableThinking?: boolean; images?: string[] }) => {},
    ),
    cancel: vi.fn(async () => {}),
    addListener: vi.fn(async (event: string, listener: Listener) => {
      const set = listeners.get(event) ?? new Set<Listener>();

      set.add(listener);
      listeners.set(event, set);

      return {
        remove: vi.fn(async () => {
          removed.push(event);
          set.delete(listener);
        }),
      };
    }),
    ...overrides,
  };

  const emit = (event: string, payload: unknown) => {
    listeners.get(event)?.forEach((listener) => (listener as (e: unknown) => void)(payload));
  };

  return { plugin, emit, removed, listenerCount: (event: string) => listeners.get(event)?.size ?? 0 };
}

function nativeWindow(platform: 'ios' | 'android', plugin: unknown) {
  setWindow({
    Capacitor: {
      isNativePlatform: () => true,
      getPlatform: () => platform,
      Plugins: { LocalLLM: plugin },
    },
  });
}

afterEach(() => {
  delete (globalThis as GlobalWithWindow).window;
  setApiBaseUrl('');
  setApiKey(null);
});

describe('localLlmPlatform / probeLocalLlm — off-device', () => {
  it('reports no platform and an unsupported probe on web, without touching any plugin', async () => {
    setWindow({});

    expect(localLlmPlatform()).toBeNull();

    const probe = await probeLocalLlm();

    expect(probe.supported).toBe(false);
    expect(probe.models).toEqual([]);
    expect(probe.availability.reason).toBeTruthy();
  });

  it('is unsupported in a native shell built without the plugin', async () => {
    setWindow({ Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: {} } });

    await expect(probeLocalLlm()).resolves.toMatchObject({ supported: false });
  });

  it('every mutating call rejects rather than pretending', async () => {
    setWindow({});

    await expect(downloadLocalLlmModel('qwen3-0.6b-int4')).rejects.toThrow(/only available/);
    await expect(cancelLocalLlmDownload('qwen3-0.6b-int4')).rejects.toThrow(/only available/);
    await expect(deleteLocalLlmModel('qwen3-0.6b-int4')).rejects.toThrow(/only available/);
    await expect(ensureLocalLlmLoaded('qwen3-0.6b-int4')).rejects.toThrow(/only available/);
    await expect(streamLocalLlm('hi')).rejects.toThrow(/only available/);
  });

  it('resetLocalLlmConversation and isLocalLlmReady are harmless no-ops', async () => {
    setWindow({});

    await expect(resetLocalLlmConversation()).resolves.toBeUndefined();
    await expect(isLocalLlmReady('qwen3-0.6b-int4')).resolves.toBe(false);
  });
});

describe('probeLocalLlm — native', () => {
  it('lists only the models this platform ships, with status and fit for each', async () => {
    const { plugin } = fakeLlm({
      getModelStatus: vi.fn(async ({ modelId }: { modelId: string }) =>
        modelId === 'qwen3-0.6b-int4' ? { status: 'ready' } : { status: 'not_downloaded' },
      ),
      getLoadedModel: vi.fn(async () => ({ loaded: true, modelId: 'qwen3-0.6b-int4', accelerator: 'cpu' })),
    });

    nativeWindow('ios', plugin);

    const probe = await probeLocalLlm();

    expect(probe.supported).toBe(true);
    expect(probe.platform).toBe('ios');
    // Gemma 4 is Android-only until the iOS app carries the increased-memory-limit entitlement.
    expect(probe.models.map((m) => m.spec.modelId)).toEqual(['qwen3-0.6b-int4', 'qwen2.5-1.5b-instruct']);
    expect(probe.models[0].status.status).toBe('ready');
    expect(probe.loaded).toEqual({ loaded: true, modelId: 'qwen3-0.6b-int4', accelerator: 'cpu' });
  });

  it('offers Gemma 4 on Android, and greys out what the device cannot hold', async () => {
    const { plugin } = fakeLlm({
      isAvailable: vi.fn(async () => ({
        available: true,
        totalMemoryBytes: 8 * GIB,
        freeDiskBytes: 40 * GIB,
      })),
    });

    nativeWindow('android', plugin);

    const { models } = await probeLocalLlm();
    const byId = Object.fromEntries(models.map((m) => [m.spec.modelId, m.fit]));

    expect(byId['gemma-4-e2b-it']).toEqual({ ok: true });
    // E4B wants a 12 GB phone.
    expect(byId['gemma-4-e4b-it']).toMatchObject({ ok: false });
  });

  it('never throws: a plugin that rejects reads as unsupported with the reason', async () => {
    const { plugin } = fakeLlm({
      isAvailable: vi.fn(async () => {
        throw new Error('engine offline');
      }),
    });

    nativeWindow('android', plugin);

    const probe = await probeLocalLlm();

    expect(probe.supported).toBe(false);
    expect(probe.availability.reason).toBe('engine offline');
  });

  it('a native build without getLoadedModel still probes, reporting nothing loaded', async () => {
    const { plugin } = fakeLlm({
      getLoadedModel: vi.fn(async () => {
        throw new Error('not implemented');
      }),
    });

    nativeWindow('android', plugin);

    await expect(probeLocalLlm()).resolves.toMatchObject({ supported: true, loaded: { loaded: false } });
  });

  it('counts a partial download toward the disk headroom check (a resume does not re-fetch it)', async () => {
    const spec = LOCAL_LLM_CATALOG['qwen2.5-1.5b-instruct'];
    const { plugin } = fakeLlm({
      // Exactly enough room for the *remaining* bytes plus headroom — not enough for the whole file.
      isAvailable: vi.fn(async () => ({
        available: true,
        totalMemoryBytes: 8 * GIB,
        freeDiskBytes: spec.sizeBytes / 2 + LOCAL_LLM_DISK_HEADROOM_BYTES,
      })),
      getModelStatus: vi.fn(async ({ modelId }: { modelId: string }) =>
        modelId === spec.modelId
          ? { status: 'downloading', bytesDownloaded: spec.sizeBytes / 2, totalBytes: spec.sizeBytes }
          : { status: 'not_downloaded' },
      ),
    });

    nativeWindow('android', plugin);

    const { models } = await probeLocalLlm();

    expect(models.find((m) => m.spec.modelId === spec.modelId)?.fit).toEqual({ ok: true });
  });
});

describe('download management', () => {
  it('downloads from the catalog’s pinned URL, never one the caller supplies', async () => {
    const { plugin } = fakeLlm();

    nativeWindow('android', plugin);

    await downloadLocalLlmModel('gemma-4-e2b-it');

    expect(plugin.downloadModel).toHaveBeenCalledWith({
      modelId: 'gemma-4-e2b-it',
      url: LOCAL_LLM_CATALOG['gemma-4-e2b-it'].url,
    });
    await expect(downloadLocalLlmModel('not-a-model')).rejects.toThrow(/Unknown on-device model/);
  });

  it('unloads a resident model before deleting its file', async () => {
    const order: string[] = [];
    const { plugin } = fakeLlm({
      getLoadedModel: vi.fn(async () => ({ loaded: true, modelId: 'qwen3-0.6b-int4' })),
      unloadModel: vi.fn(async () => void order.push('unload')),
      deleteModel: vi.fn(async () => void order.push('delete')),
    });

    nativeWindow('android', plugin);

    await deleteLocalLlmModel('qwen3-0.6b-int4');

    expect(order).toEqual(['unload', 'delete']);
  });

  it('leaves a different resident model alone when deleting another', async () => {
    const { plugin } = fakeLlm({
      getLoadedModel: vi.fn(async () => ({ loaded: true, modelId: 'gemma-4-e2b-it' })),
    });

    nativeWindow('android', plugin);

    await deleteLocalLlmModel('qwen3-0.6b-int4');

    expect(plugin.unloadModel).not.toHaveBeenCalled();
    expect(plugin.deleteModel).toHaveBeenCalledWith({ modelId: 'qwen3-0.6b-int4' });
  });

  it('cancels a download by model id', async () => {
    const { plugin } = fakeLlm();

    nativeWindow('ios', plugin);

    await cancelLocalLlmDownload('qwen3-0.6b-int4');

    expect(plugin.cancelDownload).toHaveBeenCalledWith({ modelId: 'qwen3-0.6b-int4' });
  });

  it('isLocalLlmReady is true only for a fully downloaded model', async () => {
    const { plugin } = fakeLlm({
      getModelStatus: vi.fn(async ({ modelId }: { modelId: string }) => ({
        status: modelId === 'qwen3-0.6b-int4' ? 'ready' : 'downloading',
      })),
    });

    nativeWindow('android', plugin);

    await expect(isLocalLlmReady('qwen3-0.6b-int4')).resolves.toBe(true);
    await expect(isLocalLlmReady('gemma-4-e2b-it')).resolves.toBe(false);
    await expect(isLocalLlmReady(null)).resolves.toBe(false);
  });
});

describe('ensureLocalLlmLoaded', () => {
  it('loads the model on its default accelerator, toolless with no appliance configured', async () => {
    const { plugin } = fakeLlm();

    nativeWindow('android', plugin);

    await ensureLocalLlmLoaded('gemma-4-e2b-it');

    expect(plugin.configureIntentTools).toHaveBeenCalledWith({ enabled: false });
    expect(plugin.loadModel).toHaveBeenCalledWith({
      modelId: 'gemma-4-e2b-it',
      accelerator: 'gpu',
      enableSpeculativeDecoding: undefined,
    });
  });

  it('does not reload a model that is already resident on the requested backend', async () => {
    const { plugin } = fakeLlm({
      getLoadedModel: vi.fn(async () => ({ loaded: true, modelId: 'gemma-4-e2b-it', accelerator: 'gpu' })),
    });

    nativeWindow('android', plugin);

    await expect(ensureLocalLlmLoaded('gemma-4-e2b-it')).resolves.toEqual({
      alreadyLoaded: true,
      accelerator: 'gpu',
    });
    expect(plugin.loadModel).not.toHaveBeenCalled();
  });

  it('reloads when the requested accelerator differs from the resident one', async () => {
    const { plugin } = fakeLlm({
      getLoadedModel: vi.fn(async () => ({ loaded: true, modelId: 'gemma-4-e2b-it', accelerator: 'gpu' })),
    });

    nativeWindow('android', plugin);

    await ensureLocalLlmLoaded('gemma-4-e2b-it', { accelerator: 'cpu' });

    expect(plugin.loadModel).toHaveBeenCalledWith(expect.objectContaining({ accelerator: 'cpu' }));
  });

  it('asks a CPU-only model for its own backend even when a GPU preference is remembered', async () => {
    // gpu was chosen for Qwen2.5, then the user picked Qwen3 (CPU-only): asking Qwen3 for `gpu` would never match
    // the `cpu` it reports back, and would reload it on every message.
    const { plugin } = fakeLlm({
      getLoadedModel: vi.fn(async () => ({ loaded: true, modelId: 'qwen3-0.6b-int4', accelerator: 'cpu' })),
    });

    nativeWindow('android', plugin);

    await expect(ensureLocalLlmLoaded('qwen3-0.6b-int4', { accelerator: 'gpu' })).resolves.toEqual({
      alreadyLoaded: true,
      accelerator: 'cpu',
    });
    expect(plugin.loadModel).not.toHaveBeenCalled();
  });

  it('does not reload every turn after a GPU request that fell back to the CPU', async () => {
    let loaded: { loaded: boolean; modelId?: string; accelerator?: string } = { loaded: false };
    const { plugin } = fakeLlm({
      getLoadedModel: vi.fn(async () => loaded),
      loadModel: vi.fn(async ({ modelId }: { modelId: string }) => {
        loaded = { loaded: true, modelId, accelerator: 'cpu' };

        return { toolCount: 0, accelerator: 'cpu', fellBackToCpu: true, speculativeDecoding: false };
      }),
    });

    nativeWindow('android', plugin);

    await ensureLocalLlmLoaded('qwen2.5-1.5b-instruct', { accelerator: 'gpu' });
    await ensureLocalLlmLoaded('qwen2.5-1.5b-instruct', { accelerator: 'gpu' });
    await ensureLocalLlmLoaded('qwen2.5-1.5b-instruct', { accelerator: 'gpu' });

    expect(plugin.loadModel).toHaveBeenCalledTimes(1);

    // Explicitly choosing the CPU is a different request and still reloads nothing: it is what is resident.
    await ensureLocalLlmLoaded('qwen2.5-1.5b-instruct', { accelerator: 'cpu' });
    expect(plugin.loadModel).toHaveBeenCalledTimes(1);
  });

  it('reloads when a different model is resident', async () => {
    const { plugin } = fakeLlm({
      getLoadedModel: vi.fn(async () => ({ loaded: true, modelId: 'qwen3-0.6b-int4', accelerator: 'cpu' })),
    });

    nativeWindow('android', plugin);

    await ensureLocalLlmLoaded('gemma-4-e2b-it');

    expect(plugin.loadModel).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'gemma-4-e2b-it' }));
  });

  it('binds the appliance’s intent tools only with an origin, an API key, and a model that can use them', async () => {
    setApiBaseUrl('https://memory.example.com');
    setApiKey('key-123');

    const { plugin } = fakeLlm();

    nativeWindow('android', plugin);

    await ensureLocalLlmLoaded('qwen3-0.6b-int4', { useIntentTools: true });

    expect(plugin.configureIntentTools).toHaveBeenLastCalledWith({
      enabled: true,
      baseUrl: 'https://memory.example.com',
      apiKey: 'key-123',
    });

    // Qwen2.5 has no tool-call slots in its chat template, so tools are never bound to it.
    await ensureLocalLlmLoaded('qwen2.5-1.5b-instruct', { useIntentTools: true });

    expect(plugin.configureIntentTools).toHaveBeenLastCalledWith({ enabled: false });
  });

  it('loads toolless when the user switched tools off, even with credentials present', async () => {
    setApiBaseUrl('https://memory.example.com');
    setApiKey('key-123');

    const { plugin } = fakeLlm();

    nativeWindow('android', plugin);

    await ensureLocalLlmLoaded('qwen3-0.6b-int4', { useIntentTools: false });

    expect(plugin.configureIntentTools).toHaveBeenLastCalledWith({ enabled: false });
  });

  it('rejects an unknown model id before touching the plugin', async () => {
    const { plugin } = fakeLlm();

    nativeWindow('android', plugin);

    await expect(ensureLocalLlmLoaded('nope')).rejects.toThrow(/Unknown on-device model/);
    expect(plugin.loadModel).not.toHaveBeenCalled();
  });
});

describe('resetLocalLlmConversation', () => {
  it('resets only when something is loaded, and swallows a failing reset', async () => {
    const idle = fakeLlm();

    nativeWindow('android', idle.plugin);
    await resetLocalLlmConversation();
    expect(idle.plugin.resetConversation).not.toHaveBeenCalled();

    const loaded = fakeLlm({
      getLoadedModel: vi.fn(async () => ({ loaded: true, modelId: 'qwen3-0.6b-int4' })),
      resetConversation: vi.fn(async () => {
        throw new Error('busy');
      }),
    });

    nativeWindow('android', loaded.plugin);
    await expect(resetLocalLlmConversation()).resolves.toBeUndefined();
    expect(loaded.plugin.resetConversation).toHaveBeenCalledTimes(1);
  });
});

describe('streamLocalLlm', () => {
  const stats = {
    timeToFirstTokenMs: 420,
    totalMs: 3100,
    outputTokens: 54,
    decodeTokensPerSecond: 20.1,
    tokensEstimated: false,
  };

  it('accumulates answer and reasoning separately and returns the stats from the done event', async () => {
    const { plugin, emit } = fakeLlm();

    plugin.generateStream.mockImplementation(async () => {
      emit('llmToken', { thought: 'Let me think. ', partial: '', done: false });
      emit('llmToken', { partial: 'Hello, ', done: false });
      emit('llmToken', { partial: 'world.', done: false });
      emit('llmToken', { partial: '', done: true, stats });
    });
    nativeWindow('android', plugin);

    const onText = vi.fn();
    const onThought = vi.fn();
    const result = await streamLocalLlm('hi', { enableThinking: true, onText, onThought });

    expect(result).toEqual({ text: 'Hello, world.', thought: 'Let me think. ', stats, cancelled: false });
    expect(onText.mock.calls.map(([t]) => t)).toEqual(['Hello, ', 'world.']);
    expect(onThought).toHaveBeenCalledWith('Let me think. ');
    expect(plugin.generateStream).toHaveBeenCalledWith({
      prompt: 'hi',
      enableThinking: true,
      images: undefined,
    });
  });

  it('forwards images, and omits an empty image list', async () => {
    const { plugin } = fakeLlm();

    nativeWindow('android', plugin);

    await streamLocalLlm('what is this?', { images: ['QUJD'] });
    await streamLocalLlm('no photo', { images: [] });

    expect(plugin.generateStream).toHaveBeenNthCalledWith(1, {
      prompt: 'what is this?',
      enableThinking: undefined,
      images: ['QUJD'],
    });
    expect(plugin.generateStream).toHaveBeenNthCalledWith(2, {
      prompt: 'no photo',
      enableThinking: undefined,
      images: undefined,
    });
  });

  it('removes its token listener when the turn ends, even when generation throws', async () => {
    const { plugin, listenerCount } = fakeLlm({
      generateStream: vi.fn(async () => {
        throw new Error('thermal cutoff');
      }),
    });

    nativeWindow('android', plugin);

    await expect(streamLocalLlm('hi')).rejects.toThrow('thermal cutoff');
    // `remove()` resolves asynchronously; give it a tick.
    await Promise.resolve();
    expect(listenerCount('llmToken')).toBe(0);
  });

  it('cancels natively when the caller aborts, and reports the turn as cancelled with no stats', async () => {
    const { plugin, emit } = fakeLlm();
    const controller = new AbortController();

    plugin.generateStream.mockImplementation(async () => {
      emit('llmToken', { partial: 'partial ', done: false });
      controller.abort();
      // The native side resolves normally after a cancel, with a bare terminal event.
      emit('llmToken', { partial: '', done: true });
    });
    nativeWindow('android', plugin);

    const result = await streamLocalLlm('hi', { signal: controller.signal });

    expect(plugin.cancel).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ text: 'partial ', cancelled: true });
    expect(result.stats).toBeUndefined();
  });

  it('reports a turn the device cut short (no stats, no abort) as not completed', async () => {
    const { plugin, emit } = fakeLlm();

    plugin.generateStream.mockImplementation(async () => {
      emit('llmToken', { partial: 'half an ans', done: false });
      // A thermal cutoff ends the stream with a bare terminal event.
      emit('llmToken', { partial: '', done: true });
    });
    nativeWindow('android', plugin);

    const result = await streamLocalLlm('hi');

    expect(result).toMatchObject({ text: 'half an ans', cancelled: true });
    expect(result.stats).toBeUndefined();
  });

  it('does not start generating for a signal that is already aborted', async () => {
    const { plugin } = fakeLlm();
    const controller = new AbortController();

    controller.abort();
    nativeWindow('android', plugin);

    await expect(streamLocalLlm('hi', { signal: controller.signal })).resolves.toEqual({
      text: '',
      thought: '',
      cancelled: true,
    });
    expect(plugin.generateStream).not.toHaveBeenCalled();
  });

  it('serialises overlapping calls so two chats cannot interleave tokens on the shared event', async () => {
    const { plugin, emit } = fakeLlm();
    const order: string[] = [];
    let release!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    plugin.generateStream.mockImplementation(async ({ prompt }: { prompt: string }) => {
      order.push(`start:${prompt}`);

      if (prompt === 'first') {
        await firstGate;
      }

      emit('llmToken', { partial: `answer-${prompt}`, done: false });
      order.push(`end:${prompt}`);
    });
    nativeWindow('android', plugin);

    const first = streamLocalLlm('first');
    const second = streamLocalLlm('second');

    // Let the queue advance as far as it can while the first is held open.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['start:first']);

    release();

    const [a, b] = await Promise.all([first, second]);

    expect(order).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
    expect(a.text).toBe('answer-first');
    expect(b.text).toBe('answer-second');
  });

  it('a failed turn does not wedge the queue for the next one', async () => {
    const { plugin, emit } = fakeLlm();

    plugin.generateStream.mockRejectedValueOnce(new Error('boom'));
    plugin.generateStream.mockImplementationOnce(async () => {
      emit('llmToken', { partial: 'fine', done: false });
      emit('llmToken', {
        partial: '',
        done: true,
        stats: {
          timeToFirstTokenMs: 1,
          totalMs: 2,
          outputTokens: 1,
          decodeTokensPerSecond: 1,
          tokensEstimated: false,
        },
      });
    });
    nativeWindow('android', plugin);

    await expect(streamLocalLlm('one')).rejects.toThrow('boom');
    await expect(streamLocalLlm('two')).resolves.toMatchObject({ text: 'fine', cancelled: false });
  });
});

describe('isContextExhausted', () => {
  const done = {
    timeToFirstTokenMs: 1,
    totalMs: 1,
    outputTokens: 0,
    decodeTokensPerSecond: 0,
    tokensEstimated: false,
  };

  it('matches a completed turn that produced nothing — what a full context window returns', () => {
    expect(isContextExhausted({ text: '', thought: '', stats: done, cancelled: false })).toBe(true);
  });

  it('does not match a real answer, a reasoning-only turn, or a stopped/heat-cut turn', () => {
    expect(
      isContextExhausted({ text: 'Hi', thought: '', stats: { ...done, outputTokens: 1 }, cancelled: false }),
    ).toBe(false);
    expect(
      isContextExhausted({ text: '', thought: 'hmm', stats: { ...done, outputTokens: 1 }, cancelled: false }),
    ).toBe(false);
    expect(isContextExhausted({ text: '', thought: '', stats: undefined, cancelled: true })).toBe(false);
    expect(isContextExhausted({ text: '', thought: '', stats: undefined, cancelled: false })).toBe(false);
  });
});

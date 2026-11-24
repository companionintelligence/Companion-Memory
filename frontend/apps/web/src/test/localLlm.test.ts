import { setApiKey } from '@ci/common/src/utils/apiAuth';
import { setApiBaseUrl } from '@ci/common/src/utils/apiBase';
import {
  cancelLocalLlmDownload,
  deleteLocalLlmModel,
  downloadLocalLlmModel,
  ensureLocalLlmLoaded,
  isAnswerCutShort,
  isContextExhausted,
  isLocalLlmReady,
  LocalLlmGenerationError,
  localLlmPlatform,
  onLocalLlmDownloadProgress,
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

    await expect(downloadLocalLlmModel('gemma-4-e2b-it')).rejects.toThrow(/only available/);
    await expect(cancelLocalLlmDownload('gemma-4-e2b-it')).rejects.toThrow(/only available/);
    await expect(deleteLocalLlmModel('gemma-4-e2b-it')).rejects.toThrow(/only available/);
    await expect(ensureLocalLlmLoaded('gemma-4-e2b-it')).rejects.toThrow(/only available/);
    await expect(streamLocalLlm('hi')).rejects.toThrow(/only available/);
  });

  it('resetLocalLlmConversation and isLocalLlmReady are harmless no-ops', async () => {
    setWindow({});

    await expect(resetLocalLlmConversation()).resolves.toBeUndefined();
    await expect(isLocalLlmReady('gemma-4-e2b-it')).resolves.toBe(false);
  });
});

describe('probeLocalLlm — native', () => {
  it('lists only the models this platform ships, with status and fit for each', async () => {
    const { plugin } = fakeLlm({
      getModelStatus: vi.fn(async ({ modelId }: { modelId: string }) =>
        modelId === 'gemma-4-e2b-it' ? { status: 'ready' } : { status: 'not_downloaded' },
      ),
      getLoadedModel: vi.fn(async () => ({ loaded: true, modelId: 'gemma-4-e2b-it', accelerator: 'cpu' })),
    });

    nativeWindow('ios', plugin);

    const probe = await probeLocalLlm();

    expect(probe.supported).toBe(true);
    expect(probe.platform).toBe('ios');
    // Nothing ships on iOS (since 2026-10-13); the resident model is still reported as the bridge sees it.
    expect(probe.models).toEqual([]);
    expect(probe.loaded).toEqual({ loaded: true, modelId: 'gemma-4-e2b-it', accelerator: 'cpu' });
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
    const spec = LOCAL_LLM_CATALOG['gemma-4-e2b-it'];
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
      getLoadedModel: vi.fn(async () => ({ loaded: true, modelId: 'gemma-4-e2b-it' })),
      unloadModel: vi.fn(async () => void order.push('unload')),
      deleteModel: vi.fn(async () => void order.push('delete')),
    });

    nativeWindow('android', plugin);

    await deleteLocalLlmModel('gemma-4-e2b-it');

    expect(order).toEqual(['unload', 'delete']);
  });

  it('leaves a different resident model alone when deleting another', async () => {
    const { plugin } = fakeLlm({
      getLoadedModel: vi.fn(async () => ({ loaded: true, modelId: 'gemma-4-e4b-it' })),
    });

    nativeWindow('android', plugin);

    await deleteLocalLlmModel('gemma-4-e2b-it');

    expect(plugin.unloadModel).not.toHaveBeenCalled();
    expect(plugin.deleteModel).toHaveBeenCalledWith({ modelId: 'gemma-4-e2b-it' });
  });

  it('cancels a download by model id', async () => {
    const { plugin } = fakeLlm();

    nativeWindow('ios', plugin);

    await cancelLocalLlmDownload('gemma-4-e2b-it');

    expect(plugin.cancelDownload).toHaveBeenCalledWith({ modelId: 'gemma-4-e2b-it' });
  });

  it('isLocalLlmReady is true only for a fully downloaded model', async () => {
    const { plugin } = fakeLlm({
      getModelStatus: vi.fn(async ({ modelId }: { modelId: string }) => ({
        status: modelId === 'gemma-4-e2b-it' ? 'ready' : 'downloading',
      })),
    });

    nativeWindow('android', plugin);

    await expect(isLocalLlmReady('gemma-4-e2b-it')).resolves.toBe(true);
    await expect(isLocalLlmReady('gemma-4-e4b-it')).resolves.toBe(false);
    await expect(isLocalLlmReady(null)).resolves.toBe(false);
  });
});

/**
 * `addListener` as each Capacitor surface really answers it. `window.Capacitor.Plugins.LocalLLM` is the legacy stub the
 * native bridge injects (iOS `JSExport.swift`, Android `JSExport.java`), and its `addListener` forwards to
 * `Capacitor.addListener` in `native-bridge.js`, which returns the BARE `{ remove }` — no Promise. A
 * `registerPlugin()` proxy is the other shape and does return `Promise<{ remove }>`. `fakeLlm()` above only models the
 * second, which is how `.then` on the first shipped.
 */
function listenerRegistry(shape: 'bare' | 'promise') {
  const listeners = new Set<Listener>();
  const removed = vi.fn();

  const addListener = vi.fn((_event: string, listener: Listener) => {
    listeners.add(listener);

    const handle = {
      remove: async () => {
        removed();
        listeners.delete(listener);
      },
    };

    return shape === 'bare' ? handle : Promise.resolve(handle);
  });

  return {
    addListener,
    removed,
    emit: (payload: unknown) => listeners.forEach((listener) => (listener as (e: unknown) => void)(payload)),
    size: () => listeners.size,
  };
}

/** Let the registration (a Promise, or an `await` on a bare object) settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('onLocalLlmDownloadProgress', () => {
  const progress = {
    modelId: 'gemma-4-e2b-it',
    status: 'downloading',
    bytesDownloaded: 1024,
    totalBytes: 2048,
  };

  it('is a no-op off-device and in a shell without the plugin', () => {
    setWindow({});
    expect(() => onLocalLlmDownloadProgress(vi.fn())()).not.toThrow();

    setWindow({ Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: {} } });
    expect(() => onLocalLlmDownloadProgress(vi.fn())()).not.toThrow();
  });

  describe.each([
    ['the legacy stub the native bridge injects (a bare { remove })', 'bare' as const],
    ['a registerPlugin() proxy (a Promise of { remove })', 'promise' as const],
  ])('against %s', (_label, shape) => {
    it('subscribes without throwing, delivers progress, and removes the listener on unsubscribe', async () => {
      const registry = listenerRegistry(shape);

      nativeWindow('ios', fakeLlm({ addListener: registry.addListener }).plugin);

      const listener = vi.fn();
      let unsubscribe!: () => void;

      // The throw this guards escaped from the Settings page's mount effect and replaced the page with the error boundary.
      expect(() => {
        unsubscribe = onLocalLlmDownloadProgress(listener);
      }).not.toThrow();

      await settle();
      expect(registry.addListener).toHaveBeenCalledWith('modelDownloadProgress', listener);

      registry.emit(progress);
      expect(listener).toHaveBeenCalledWith(progress);

      unsubscribe();
      await settle();

      expect(registry.removed).toHaveBeenCalledTimes(1);
      expect(registry.size()).toBe(0);
    });

    it('removes a listener whose registration settled after the caller had already unsubscribed', async () => {
      const registry = listenerRegistry(shape);

      nativeWindow('ios', fakeLlm({ addListener: registry.addListener }).plugin);

      // React unmounts the page before the bridge answers: nothing may be left listening, and nothing removed twice.
      onLocalLlmDownloadProgress(vi.fn())();
      await settle();

      expect(registry.removed).toHaveBeenCalledTimes(1);
      expect(registry.size()).toBe(0);
    });
  });

  it('shrugs off a plugin whose addListener throws or rejects, rather than taking the caller down', async () => {
    const throws = vi.fn(() => {
      throw new Error('bridge not ready');
    });
    const rejects = vi.fn(async () => {
      throw new Error('bridge not ready');
    });

    for (const addListener of [throws, rejects]) {
      nativeWindow('ios', fakeLlm({ addListener }).plugin);

      let unsubscribe!: () => void;

      expect(() => {
        unsubscribe = onLocalLlmDownloadProgress(vi.fn());
      }).not.toThrow();
      await settle();
      expect(() => unsubscribe()).not.toThrow();
    }
  });
});

describe('ensureLocalLlmLoaded', () => {
  it('loads the model on its default accelerator, toolless with no appliance configured', async () => {
    const { plugin } = fakeLlm();

    nativeWindow('android', plugin);

    await ensureLocalLlmLoaded('gemma-4-e2b-it');

    expect(plugin.configureIntentTools).toHaveBeenCalledWith({ enabled: false });
    // The CPU since 2026-10-13: the GPU backend corrupts digits read from tool responses with Gemma 4.
    expect(plugin.loadModel).toHaveBeenCalledWith({
      modelId: 'gemma-4-e2b-it',
      accelerator: 'cpu',
      enableSpeculativeDecoding: undefined,
    });
  });

  it('does not reload a model that is already resident on the requested backend', async () => {
    // The CPU, which is what a default request asks for since 2026-10-13 (see above).
    const { plugin } = fakeLlm({
      getLoadedModel: vi.fn(async () => ({ loaded: true, modelId: 'gemma-4-e2b-it', accelerator: 'cpu' })),
    });

    nativeWindow('android', plugin);

    // toMatchObject: `toolCount` is whatever an earlier load in this module reported, so this test leaves it out.
    await expect(ensureLocalLlmLoaded('gemma-4-e2b-it')).resolves.toMatchObject({
      alreadyLoaded: true,
      accelerator: 'cpu',
    });
    expect(plugin.loadModel).not.toHaveBeenCalled();
  });

  it('asks for the CPU on a phone under the model’s GPU floor, and treats the resident CPU model as a match', async () => {
    let loaded: { loaded: boolean; modelId?: string; accelerator?: string } = { loaded: false };
    const { plugin } = fakeLlm({
      isAvailable: vi.fn(async () => ({
        available: true,
        totalMemoryBytes: 6 * GIB,
        freeDiskBytes: 40 * GIB,
      })),
      getLoadedModel: vi.fn(async () => loaded),
    });

    nativeWindow('android', plugin);

    await ensureLocalLlmLoaded('gemma-4-e2b-it', { accelerator: 'gpu' });

    expect(plugin.loadModel).toHaveBeenCalledWith(expect.objectContaining({ accelerator: 'cpu' }));

    // Resident on the CPU now: a second `gpu` request on this phone must not reload it every turn.
    loaded = { loaded: true, modelId: 'gemma-4-e2b-it', accelerator: 'cpu' };
    await expect(ensureLocalLlmLoaded('gemma-4-e2b-it', { accelerator: 'gpu' })).resolves.toMatchObject({
      alreadyLoaded: true,
      accelerator: 'cpu',
    });
    expect(plugin.loadModel).toHaveBeenCalledTimes(1);
  });

  it('reloads when the requested accelerator differs from the resident one', async () => {
    const { plugin } = fakeLlm({
      getLoadedModel: vi.fn(async () => ({ loaded: true, modelId: 'gemma-4-e2b-it', accelerator: 'gpu' })),
    });

    nativeWindow('android', plugin);

    await ensureLocalLlmLoaded('gemma-4-e2b-it', { accelerator: 'cpu' });

    expect(plugin.loadModel).toHaveBeenCalledWith(expect.objectContaining({ accelerator: 'cpu' }));
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

    await ensureLocalLlmLoaded('gemma-4-e2b-it', { accelerator: 'gpu' });
    await ensureLocalLlmLoaded('gemma-4-e2b-it', { accelerator: 'gpu' });
    await ensureLocalLlmLoaded('gemma-4-e2b-it', { accelerator: 'gpu' });

    expect(plugin.loadModel).toHaveBeenCalledTimes(1);

    // Explicitly choosing the CPU is a different request and still reloads nothing: it is what is resident.
    await ensureLocalLlmLoaded('gemma-4-e2b-it', { accelerator: 'cpu' });
    expect(plugin.loadModel).toHaveBeenCalledTimes(1);
  });

  it('reloads when a different model is resident', async () => {
    const { plugin } = fakeLlm({
      getLoadedModel: vi.fn(async () => ({ loaded: true, modelId: 'gemma-4-e2b-it', accelerator: 'cpu' })),
    });

    nativeWindow('android', plugin);

    await ensureLocalLlmLoaded('gemma-4-e4b-it');

    expect(plugin.loadModel).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'gemma-4-e4b-it' }));
  });

  it('binds the appliance’s intent tools only with an origin, an API key, and a model that can use them', async () => {
    setApiBaseUrl('https://memory.example.com');
    setApiKey('key-123');

    const { plugin } = fakeLlm();

    nativeWindow('android', plugin);

    await ensureLocalLlmLoaded('gemma-4-e2b-it', { useIntentTools: true });

    expect(plugin.configureIntentTools).toHaveBeenLastCalledWith({
      enabled: true,
      baseUrl: 'https://memory.example.com',
      apiKey: 'key-123',
      connectionMode: 'fresh',
      localSearch: undefined,
    });
  });

  it('loads toolless when the user switched tools off, even with credentials present', async () => {
    setApiBaseUrl('https://memory.example.com');
    setApiKey('key-123');

    const { plugin } = fakeLlm();

    nativeWindow('android', plugin);

    await ensureLocalLlmLoaded('gemma-4-e2b-it', { useIntentTools: false });

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
      getLoadedModel: vi.fn(async () => ({ loaded: true, modelId: 'gemma-4-e2b-it' })),
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

  describe('a native failure', () => {
    const failWith = (rejection: unknown) => {
      const { plugin } = fakeLlm({ generateStream: vi.fn().mockRejectedValue(rejection) });

      nativeWindow('ios', plugin);

      return streamLocalLlm('hi').then(
        () => {
          throw new Error('expected the turn to fail');
        },
        (error: unknown) => error,
      );
    };

    it('rejects as a LocalLlmGenerationError carrying the runtime’s own words as its reason', async () => {
      const native = 'Generation failed: Invalid response from native layer: Input token ids are too long.';
      const error = await failWith(new Error(native));

      expect(error).toBeInstanceOf(LocalLlmGenerationError);
      // The message is what the plugin said, unchanged; the reason is the part worth showing.
      expect(error).toMatchObject({
        message: native,
        reason: 'Invalid response from native layer: Input token ids are too long.',
      });
    });

    it('reads the plain { message, code } object the bridge rejects with, not only an Error', async () => {
      const error = await failWith({
        message: 'Generation failed: Device is thermally throttled',
        code: 'X',
      });

      expect(error).toBeInstanceOf(LocalLlmGenerationError);
      expect(error).toMatchObject({ reason: 'Device is thermally throttled' });
    });

    it('keeps a reason that has no “Generation failed:” lead-in as it is (Android rejects some failures bare)', async () => {
      const error = await failWith(
        new Error('A generation is already in progress and did not stop in time.'),
      );

      expect(error).toMatchObject({
        reason: 'A generation is already in progress and did not stop in time.',
      });
    });

    it('bounds the reason to one short line, however much the runtime wrote', async () => {
      const error = (await failWith(
        new Error(`Generation failed: ${'x'.repeat(5000)}\n\nsecond paragraph`),
      )) as LocalLlmGenerationError;

      expect(error.reason.length).toBeLessThanOrEqual(201);
      expect(error.reason).not.toMatch(/\s{2,}|\n/);
      expect(error.reason.endsWith('…')).toBe(true);
    });

    it('has no reason when the plugin said nothing more than the generic wording', async () => {
      const bare = await failWith(new Error('Generation failed'));
      const nothing = await failWith(undefined);

      expect(bare).toMatchObject({ reason: '' });
      expect(nothing).toMatchObject({ reason: '' });
    });
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

describe('isAnswerCutShort', () => {
  const stats = {
    timeToFirstTokenMs: 300,
    totalMs: 2000,
    outputTokens: 350,
    decodeTokensPerSecond: 30,
    tokensEstimated: false,
  };

  it('is the device case: reasoning, then a tool call cut off mid-JSON, no answer', () => {
    expect(
      isAnswerCutShort({
        text: '\n\n<tool_call>\n{"name": "media_findPhotos", "arguments": {"query": "s',
        thought: 'The user asks about photos…',
        stats,
        cancelled: false,
      }),
    ).toBe(true);
  });

  it('is reasoning with nothing after it', () => {
    expect(isAnswerCutShort({ text: '', thought: 'Let me think…', stats, cancelled: false })).toBe(true);
  });

  it('is not an answered turn, a finished tool call, a stop, or an empty second turn', () => {
    expect(isAnswerCutShort({ text: 'Paris.', thought: 'easy', stats, cancelled: false })).toBe(false);
    expect(
      isAnswerCutShort({ text: '<tool_call>{"name":"x"}</tool_call>', thought: '', stats, cancelled: false }),
    ).toBe(false);
    expect(isAnswerCutShort({ text: '', thought: 'cut', stats: undefined, cancelled: true })).toBe(false);
    expect(
      isAnswerCutShort({ text: '', thought: '', stats: { ...stats, outputTokens: 0 }, cancelled: false }),
    ).toBe(false);
  });
});

import { resetLocalLlmPrefsCache } from '@ci/common/src/utils/localLlmPrefs';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OnDeviceModelSection } from './OnDeviceModelSection';

const GIB = 1024 * 1024 * 1024;

type Listener = (event: unknown) => void;

interface FakeState {
  status: Record<string, { status: string; bytesDownloaded?: number; totalBytes?: number; error?: string }>;
  loaded: { loaded: boolean; modelId?: string; accelerator?: string };
  totalMemoryBytes: number;
  freeDiskBytes: number;
}

/** A `window.Capacitor.Plugins.LocalLLM` whose state the test can flip, with `emit` for native events. */
function installFakeNative(platform: 'ios' | 'android', initial: Partial<FakeState> = {}) {
  const state: FakeState = {
    status: {},
    loaded: { loaded: false },
    totalMemoryBytes: 12 * GIB,
    freeDiskBytes: 64 * GIB,
    ...initial,
  };
  const listeners = new Map<string, Set<Listener>>();

  const plugin = {
    isAvailable: vi.fn(async () => ({
      available: true,
      totalMemoryBytes: state.totalMemoryBytes,
      freeDiskBytes: state.freeDiskBytes,
    })),
    getModelStatus: vi.fn(
      async ({ modelId }: { modelId: string }) => state.status[modelId] ?? { status: 'not_downloaded' },
    ),
    getLoadedModel: vi.fn(async () => state.loaded),
    downloadModel: vi.fn(async ({ modelId }: { modelId: string }) => {
      state.status[modelId] = { status: 'downloading', bytesDownloaded: 0 };
    }),
    cancelDownload: vi.fn(async ({ modelId }: { modelId: string }) => {
      delete state.status[modelId];
    }),
    deleteModel: vi.fn(async ({ modelId }: { modelId: string }) => {
      delete state.status[modelId];
    }),
    loadModel: vi.fn(async ({ modelId, accelerator }: { modelId: string; accelerator?: string }) => {
      state.loaded = { loaded: true, modelId, accelerator: accelerator ?? 'cpu' };

      return {
        toolCount: 0,
        accelerator: accelerator ?? 'cpu',
        fellBackToCpu: false,
        speculativeDecoding: false,
      };
    }),
    unloadModel: vi.fn(async () => {
      state.loaded = { loaded: false };
    }),
    configureIntentTools: vi.fn(async () => {}),
    resetConversation: vi.fn(async () => {}),
    generateStream: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    addListener: vi.fn(async (event: string, listener: Listener) => {
      const set = listeners.get(event) ?? new Set<Listener>();

      set.add(listener);
      listeners.set(event, set);

      return { remove: vi.fn(async () => void set.delete(listener)) };
    }),
  };

  (window as unknown as { Capacitor: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => platform,
    Plugins: { LocalLLM: plugin },
  };

  return {
    plugin,
    state,
    emit: (event: string, payload: unknown) => listeners.get(event)?.forEach((listener) => listener(payload)),
  };
}

beforeEach(() => {
  localStorage.clear();
  resetLocalLlmPrefsCache();
});

afterEach(() => {
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  localStorage.clear();
  resetLocalLlmPrefsCache();
});

describe('OnDeviceModelSection', () => {
  it('says so, and offers nothing, off a native shell', async () => {
    render(<OnDeviceModelSection />);

    expect(await screen.findByText(/run in the iOS and Android apps/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /download/i })).not.toBeInTheDocument();
  });

  it('lists the models this platform ships — Gemma 4 on Android, not on iOS', async () => {
    installFakeNative('ios');
    const ios = render(<OnDeviceModelSection />);

    expect(await screen.findByText('Qwen3 0.6B')).toBeInTheDocument();
    expect(screen.getByText('Qwen2.5 1.5B Instruct')).toBeInTheDocument();
    expect(screen.queryByText('Gemma 4 E2B')).not.toBeInTheDocument();

    ios.unmount();
    installFakeNative('android');
    render(<OnDeviceModelSection />);

    expect(await screen.findByText('Gemma 4 E2B')).toBeInTheDocument();
    expect(screen.getByText('Gemma 4 E4B')).toBeInTheDocument();
  });

  it('greys a model the device lacks the RAM for and explains why, instead of offering a doomed download', async () => {
    installFakeNative('android', { totalMemoryBytes: 8 * GIB });
    render(<OnDeviceModelSection />);

    const e4b = await screen.findByTestId('on-device-model-gemma-4-e4b-it');

    expect(within(e4b).queryByRole('button', { name: /download/i })).not.toBeInTheDocument();
    expect(
      within(e4b).getByText(/at least 12\.0 GB of RAM; this device reports 8\.0 GB/i),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('on-device-model-gemma-4-e2b-it')).getByRole('button', { name: /download/i }),
    ).toBeEnabled();
  });

  it('downloads from the pinned catalog URL and shows live progress', async () => {
    const { plugin, emit } = installFakeNative('android');

    render(<OnDeviceModelSection />);

    const row = await screen.findByTestId('on-device-model-qwen3-0.6b-int4');

    fireEvent.click(within(row).getByRole('button', { name: /download/i }));

    expect(plugin.downloadModel).toHaveBeenCalledWith({
      modelId: 'qwen3-0.6b-int4',
      url: expect.stringContaining('/resolve/154c5de0fc0fc5002a7da570ba8c67edffa32ca2/'),
    });

    await act(async () => {
      emit('modelDownloadProgress', {
        modelId: 'qwen3-0.6b-int4',
        status: 'downloading',
        bytesDownloaded: 172_335_872,
        totalBytes: 344_437_808,
      });
    });

    const bar = await within(row).findByRole('progressbar', { name: /downloading qwen3/i });

    expect(bar).toBeInTheDocument();
    expect(within(row).getByText(/164 MB of 328 MB/)).toBeInTheDocument();
  });

  it('cancels an in-flight download', async () => {
    const { plugin } = installFakeNative('android', {
      status: {
        'qwen3-0.6b-int4': { status: 'downloading', bytesDownloaded: 1000, totalBytes: 344_437_808 },
      },
    });

    render(<OnDeviceModelSection />);

    const row = await screen.findByTestId('on-device-model-qwen3-0.6b-int4');

    fireEvent.click(within(row).getByRole('button', { name: /cancel/i }));

    expect(plugin.cancelDownload).toHaveBeenCalledWith({ modelId: 'qwen3-0.6b-int4' });
  });

  it('surfaces a failed download with a retry, and the native error text', async () => {
    installFakeNative('android', {
      status: {
        'qwen3-0.6b-int4': { status: 'error', error: 'Downloaded size (1) did not match expected size (2)' },
      },
    });

    render(<OnDeviceModelSection />);

    const row = await screen.findByTestId('on-device-model-qwen3-0.6b-int4');

    expect(within(row).getByRole('alert')).toHaveTextContent(/did not match expected size/);
    expect(within(row).getByRole('button', { name: /retry download/i })).toBeInTheDocument();
  });

  it('loads a downloaded model, makes it the chat model, and unlocks routing', async () => {
    const { plugin } = installFakeNative('android', {
      status: { 'gemma-4-e2b-it': { status: 'ready' } },
    });

    render(<OnDeviceModelSection />);

    const row = await screen.findByTestId('on-device-model-gemma-4-e2b-it');

    fireEvent.click(within(row).getByRole('button', { name: /use this model/i }));

    await waitFor(() => expect(plugin.loadModel).toHaveBeenCalledTimes(1));
    expect(plugin.loadModel).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'gemma-4-e2b-it', accelerator: 'gpu' }),
    );
    expect(await screen.findByText(/Gemma 4 E2B settings/)).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('ci.localLlm.prefs') ?? '{}')).toMatchObject({
      modelId: 'gemma-4-e2b-it',
      // Choosing a model does not, by itself, redirect chat — routing stays the user's separate call.
      mode: 'appliance',
    });
  });

  it('shows the reasoning and Memory-lookup switches only for a model that supports them', async () => {
    localStorage.setItem('ci.localLlm.prefs', JSON.stringify({ modelId: 'qwen2.5-1.5b-instruct' }));
    installFakeNative('android', { status: { 'qwen2.5-1.5b-instruct': { status: 'ready' } } });
    const first = render(<OnDeviceModelSection />);

    expect(await screen.findByText(/Qwen2\.5 1\.5B Instruct settings/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/think before answering/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/look things up in memory/i)).not.toBeInTheDocument();

    first.unmount();
    resetLocalLlmPrefsCache();
    localStorage.setItem('ci.localLlm.prefs', JSON.stringify({ modelId: 'gemma-4-e2b-it' }));
    installFakeNative('android', { status: { 'gemma-4-e2b-it': { status: 'ready' } } });
    render(<OnDeviceModelSection />);

    expect(await screen.findByLabelText(/think before answering/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/look things up in memory/i)).toBeInTheDocument();
  });

  it('persists the thinking toggle', async () => {
    localStorage.setItem('ci.localLlm.prefs', JSON.stringify({ modelId: 'gemma-4-e2b-it' }));
    installFakeNative('android', { status: { 'gemma-4-e2b-it': { status: 'ready' } } });
    render(<OnDeviceModelSection />);

    fireEvent.click(await screen.findByLabelText(/think before answering/i));

    expect(JSON.parse(localStorage.getItem('ci.localLlm.prefs') ?? '{}').thinking).toBe(true);
  });

  it('deleting the selected model drops the preference and reverts chat to the appliance', async () => {
    const { plugin } = installFakeNative('android', { status: { 'qwen3-0.6b-int4': { status: 'ready' } } });

    localStorage.setItem('ci.localLlm.prefs', JSON.stringify({ modelId: 'qwen3-0.6b-int4', mode: 'device' }));
    render(<OnDeviceModelSection />);

    fireEvent.click(await screen.findByRole('button', { name: /delete qwen3 0\.6b/i }));

    await waitFor(() => expect(plugin.deleteModel).toHaveBeenCalledWith({ modelId: 'qwen3-0.6b-int4' }));
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem('ci.localLlm.prefs') ?? '{}')).toMatchObject({
        modelId: null,
        mode: 'appliance',
      }),
    );
  });

  it('unloads a resident model on request', async () => {
    const { plugin } = installFakeNative('android', {
      status: { 'qwen3-0.6b-int4': { status: 'ready' } },
      loaded: { loaded: true, modelId: 'qwen3-0.6b-int4', accelerator: 'cpu' },
    });

    render(<OnDeviceModelSection />);

    expect(await screen.findByText(/is loaded on the CPU/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /unload to free memory/i }));

    expect(plugin.unloadModel).toHaveBeenCalledTimes(1);
  });

  it('shows a native failure to load instead of swallowing it', async () => {
    const { plugin } = installFakeNative('android', { status: { 'gemma-4-e2b-it': { status: 'ready' } } });

    plugin.loadModel.mockRejectedValueOnce(new Error('Not enough memory to load the model'));
    render(<OnDeviceModelSection />);

    fireEvent.click(
      within(await screen.findByTestId('on-device-model-gemma-4-e2b-it')).getByRole('button', {
        name: /use this model/i,
      }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(/not enough memory/i);
  });
});

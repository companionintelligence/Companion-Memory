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

/**
 * A `window.Capacitor.Plugins.LocalLLM` whose state the test can flip, with `emit` for native events.
 *
 * `bareListenerHandles` makes `addListener` answer the way the real thing does on the shell: that object is the legacy
 * stub the native bridge injects, and its `addListener` returns the bare `{ remove }` rather than a Promise. The default
 * keeps the Promise (a `registerPlugin()` proxy) so the rest of this file is unchanged.
 */
function installFakeNative(
  platform: 'ios' | 'android',
  initial: Partial<FakeState> = {},
  { bareListenerHandles = false }: { bareListenerHandles?: boolean } = {},
) {
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
    addListener: vi.fn((event: string, listener: Listener) => {
      const set = listeners.get(event) ?? new Set<Listener>();

      set.add(listener);
      listeners.set(event, set);

      const handle = { remove: vi.fn(async () => void set.delete(listener)) };

      return bareListenerHandles ? handle : Promise.resolve(handle);
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

    // iOS ships no LiteRT-LM model since 2026-10-13: nothing to list and nothing to download.
    await screen.findByText(/on-device model/i);
    expect(screen.queryByText('Gemma 4 E2B')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /download/i })).not.toBeInTheDocument();

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

    const row = await screen.findByTestId('on-device-model-gemma-4-e2b-it');

    fireEvent.click(within(row).getByRole('button', { name: /download/i }));

    expect(plugin.downloadModel).toHaveBeenCalledWith({
      modelId: 'gemma-4-e2b-it',
      url: expect.stringContaining('/resolve/361a4010ad6d88fc5c86e148e333c0342b99763d/'),
    });

    await act(async () => {
      emit('modelDownloadProgress', {
        modelId: 'gemma-4-e2b-it',
        status: 'downloading',
        bytesDownloaded: 172_335_872,
        totalBytes: 344_437_808,
      });
    });

    const bar = await within(row).findByRole('progressbar', { name: /downloading gemma 4 e2b/i });

    expect(bar).toBeInTheDocument();
    expect(within(row).getByText(/164 MB of 328 MB/)).toBeInTheDocument();
  });

  it('renders, and still shows live progress, when the bridge hands back a bare listener handle (the real iOS shell)', async () => {
    // The mount effect used to chain `.then` onto `addListener(...)`; the shell's legacy stub returns no Promise, so the
    // page threw out of its effect and fell to the error boundary instead of showing the models.
    // Android, because iOS lists no model since 2026-10-13 and the assertion needs a row to update.
    const { emit } = installFakeNative('android', {}, { bareListenerHandles: true });

    render(<OnDeviceModelSection />);

    const row = await screen.findByTestId('on-device-model-gemma-4-e2b-it');

    await act(async () => {
      emit('modelDownloadProgress', {
        modelId: 'gemma-4-e2b-it',
        status: 'downloading',
        bytesDownloaded: 172_335_872,
        totalBytes: 344_437_808,
      });
    });

    expect(
      await within(row).findByRole('progressbar', { name: /downloading gemma 4 e2b/i }),
    ).toBeInTheDocument();
  });

  it('cancels an in-flight download', async () => {
    const { plugin } = installFakeNative('android', {
      status: {
        'gemma-4-e2b-it': { status: 'downloading', bytesDownloaded: 1000, totalBytes: 344_437_808 },
      },
    });

    render(<OnDeviceModelSection />);

    const row = await screen.findByTestId('on-device-model-gemma-4-e2b-it');

    fireEvent.click(within(row).getByRole('button', { name: /cancel/i }));

    expect(plugin.cancelDownload).toHaveBeenCalledWith({ modelId: 'gemma-4-e2b-it' });
  });

  it('surfaces a failed download with a retry, and the native error text', async () => {
    installFakeNative('android', {
      status: {
        'gemma-4-e2b-it': { status: 'error', error: 'Downloaded size (1) did not match expected size (2)' },
      },
    });

    render(<OnDeviceModelSection />);

    const row = await screen.findByTestId('on-device-model-gemma-4-e2b-it');

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
      expect.objectContaining({ modelId: 'gemma-4-e2b-it', accelerator: 'cpu' }),
    );
    expect(await screen.findByText(/Gemma 4 E2B settings/)).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('ci.localLlm.prefs') ?? '{}')).toMatchObject({
      modelId: 'gemma-4-e2b-it',
      // Choosing a model does not, by itself, redirect chat — routing stays the user's separate call.
      mode: 'appliance',
    });
  });

  it('shows the reasoning and Memory-lookup switches for a model that supports them', async () => {
    // Every catalog model can think and call tools since 2026-10-13 (Qwen2.5, which could do neither, was
    // dropped), so there is no longer a live case for the switches being hidden.
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

  it('saves bounded answer controls without reloading immediately and resets model defaults', async () => {
    localStorage.setItem('ci.localLlm.prefs', JSON.stringify({ modelId: 'gemma-4-e2b-it' }));
    const { plugin } = installFakeNative('android', { status: { 'gemma-4-e2b-it': { status: 'ready' } } });
    render(<OnDeviceModelSection />);

    await screen.findByText('Answer settings');
    fireEvent.change(screen.getByLabelText('Temperature'), { target: { value: '0.3' } });
    fireEvent.change(screen.getByLabelText('Top K'), { target: { value: '500' } });
    expect(JSON.parse(localStorage.getItem('ci.localLlm.prefs') ?? '{}').sampling).toEqual({
      temperature: 0.3,
      topK: 100,
    });
    expect(plugin.loadModel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Reset to model defaults' }));
    expect(JSON.parse(localStorage.getItem('ci.localLlm.prefs') ?? '{}').sampling).toBeUndefined();
    expect(screen.getByLabelText('Top K')).toHaveValue(64);
  });

  describe('answer settings', () => {
    const savedPrefs = () => JSON.parse(localStorage.getItem('ci.localLlm.prefs') ?? '{}');

    /** A selected, downloaded Gemma 4 E2B — the state in which the answer settings are offered. */
    function renderSelected(prefs: object = {}, native: Parameters<typeof installFakeNative>[1] = {}) {
      localStorage.setItem('ci.localLlm.prefs', JSON.stringify({ modelId: 'gemma-4-e2b-it', ...prefs }));

      const fake = installFakeNative('android', {
        status: { 'gemma-4-e2b-it': { status: 'ready' } },
        ...native,
      });

      render(<OnDeviceModelSection />);

      return fake;
    }

    it('is offered for a downloaded model that has been chosen, and not before', async () => {
      installFakeNative('android', { status: { 'gemma-4-e2b-it': { status: 'ready' } } });
      render(<OnDeviceModelSection />);

      // Downloaded, not chosen yet: the models are listed, the settings for answering are not.
      await screen.findByTestId('on-device-model-gemma-4-e2b-it');
      expect(screen.queryByText('Answer settings')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Temperature')).not.toBeInTheDocument();
    });

    it('shows the model’s own defaults until a field is changed, over the same ranges the saved value is clamped to', async () => {
      renderSelected();

      expect(await screen.findByLabelText('Temperature')).toHaveValue(1);
      expect(screen.getByLabelText('Top P')).toHaveValue(0.95);
      expect(screen.getByLabelText('Top K')).toHaveValue(64);
      expect(screen.getByRole('combobox', { name: 'Reply limit' })).toHaveTextContent('Default');

      // Pinned here, with the clamp's own numbers pinned in localLlmCatalog.test.ts: if the two ever drifted, a
      // field would offer a number the saved value would silently change.
      expect(screen.getByLabelText('Temperature')).toHaveAttribute('min', '0');
      expect(screen.getByLabelText('Temperature')).toHaveAttribute('max', '2');
      expect(screen.getByLabelText('Top P')).toHaveAttribute('min', '0.05');
      expect(screen.getByLabelText('Top P')).toHaveAttribute('max', '1');
      expect(screen.getByLabelText('Top K')).toHaveAttribute('min', '1');
      expect(screen.getByLabelText('Top K')).toHaveAttribute('max', '100');

      // Nothing has been changed, so there is nothing to reset.
      expect(screen.getByRole('button', { name: 'Reset to model defaults' })).toBeDisabled();
      expect(savedPrefs()).not.toHaveProperty('sampling');
    });

    it('shows a saved value in place of the default, and offers the reset', async () => {
      renderSelected({ sampling: { temperature: 0.4, topP: 0.8, topK: 12 }, maxOutputTokens: 512 });

      expect(await screen.findByLabelText('Temperature')).toHaveValue(0.4);
      expect(screen.getByLabelText('Top P')).toHaveValue(0.8);
      expect(screen.getByLabelText('Top K')).toHaveValue(12);
      expect(screen.getByRole('combobox', { name: 'Reply limit' })).toHaveTextContent('512 tokens');
      expect(screen.getByRole('button', { name: 'Reset to model defaults' })).toBeEnabled();
    });

    it('shows a temperature of 0 as 0, not as the default', async () => {
      renderSelected({ sampling: { temperature: 0 } });

      expect(await screen.findByLabelText('Temperature')).toHaveValue(0);
    });

    it('lets a number be typed digit by digit, and shows the clamped value once the field is left', async () => {
      renderSelected();

      const topP = await screen.findByLabelText('Top P');

      // "0" on the way to "0.5": it is saved at the 0.05 floor, but the field is not rewritten under the cursor.
      fireEvent.focus(topP);
      fireEvent.change(topP, { target: { value: '0' } });
      expect(topP).toHaveValue(0);
      expect(savedPrefs().sampling).toEqual({ topP: 0.05 });

      fireEvent.change(topP, { target: { value: '0.5' } });
      expect(topP).toHaveValue(0.5);
      expect(savedPrefs().sampling).toEqual({ topP: 0.5 });

      // Emptied to retype it: the field stays empty and nothing is saved over the old value.
      fireEvent.change(topP, { target: { value: '' } });
      expect(topP).toHaveValue(null);
      expect(savedPrefs().sampling).toEqual({ topP: 0.5 });

      // Left empty, it goes back to what is saved.
      fireEvent.blur(topP);
      expect(topP).toHaveValue(0.5);

      // Past the end: saved at the end, and shown at the end as soon as the field is left.
      fireEvent.focus(topP);
      fireEvent.change(topP, { target: { value: '7' } });
      expect(topP).toHaveValue(7);
      expect(savedPrefs().sampling).toEqual({ topP: 1 });
      fireEvent.blur(topP);
      expect(topP).toHaveValue(1);
    });

    it('keeps the other fields when one changes, and does not reload a model that is already loaded', async () => {
      const { plugin } = renderSelected(
        { sampling: { temperature: 0.4 } },
        { loaded: { loaded: true, modelId: 'gemma-4-e2b-it', accelerator: 'cpu' } },
      );

      fireEvent.change(await screen.findByLabelText('Top K'), { target: { value: '20' } });

      expect(savedPrefs().sampling).toEqual({ temperature: 0.4, topK: 20 });
      // The sampler is applied by the next message (ensureLocalLlmLoaded), not by editing a field.
      expect(plugin.unloadModel).not.toHaveBeenCalled();
      expect(plugin.loadModel).not.toHaveBeenCalled();
    });

    it.each([128, 300, 8192])(
      'keeps a stored reply limit of %i tokens selectable, so the picker is never blank',
      async (tokens) => {
        renderSelected({ maxOutputTokens: tokens });

        expect(await screen.findByRole('combobox', { name: 'Reply limit' })).toHaveTextContent(
          `${tokens} tokens`,
        );
      },
    );

    it('sets the reply limit from the picker, and Default clears it', async () => {
      renderSelected();

      const picker = await screen.findByRole('combobox', { name: 'Reply limit' });

      fireEvent.keyDown(picker, { key: 'Enter' });
      fireEvent.keyDown(await screen.findByRole('option', { name: '512 tokens' }), { key: 'Enter' });
      expect(savedPrefs().maxOutputTokens).toBe(512);
      expect(picker).toHaveTextContent('512 tokens');

      fireEvent.keyDown(picker, { key: 'Enter' });
      fireEvent.keyDown(await screen.findByRole('option', { name: 'Default' }), { key: 'Enter' });
      expect(savedPrefs()).not.toHaveProperty('maxOutputTokens');
      expect(picker).toHaveTextContent('Default');
    });

    it('resets the limits too, including a reasoning budget the screen has no field for', async () => {
      renderSelected({ sampling: { topK: 12 }, maxOutputTokens: 1024, thinkingTokenBudget: 256 });

      fireEvent.click(await screen.findByRole('button', { name: 'Reset to model defaults' }));

      expect(savedPrefs()).not.toHaveProperty('sampling');
      expect(savedPrefs()).not.toHaveProperty('maxOutputTokens');
      expect(savedPrefs()).not.toHaveProperty('thinkingTokenBudget');
      // The model, the routing and the other switches are not part of the reset.
      expect(savedPrefs()).toMatchObject({ modelId: 'gemma-4-e2b-it', mode: 'appliance' });
      expect(screen.getByRole('combobox', { name: 'Reply limit' })).toHaveTextContent('Default');
      expect(screen.getByRole('button', { name: 'Reset to model defaults' })).toBeDisabled();
    });
  });

  it('deleting the selected model drops the preference and reverts chat to the appliance', async () => {
    const { plugin } = installFakeNative('android', { status: { 'gemma-4-e2b-it': { status: 'ready' } } });

    localStorage.setItem('ci.localLlm.prefs', JSON.stringify({ modelId: 'gemma-4-e2b-it', mode: 'device' }));
    render(<OnDeviceModelSection />);

    fireEvent.click(await screen.findByRole('button', { name: /delete gemma 4 e2b/i }));

    await waitFor(() => expect(plugin.deleteModel).toHaveBeenCalledWith({ modelId: 'gemma-4-e2b-it' }));
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem('ci.localLlm.prefs') ?? '{}')).toMatchObject({
        modelId: null,
        mode: 'appliance',
      }),
    );
  });

  it('withholds the GPU on a phone under the model’s GPU floor and says why', async () => {
    installFakeNative('android', {
      totalMemoryBytes: 6 * GIB,
      status: { 'gemma-4-e2b-it': { status: 'ready' } },
      loaded: { loaded: true, modelId: 'gemma-4-e2b-it', accelerator: 'cpu' },
    });
    localStorage.setItem(
      'ci.localLlm.prefs',
      JSON.stringify({ mode: 'device', modelId: 'gemma-4-e2b-it', accelerator: 'gpu' }),
    );

    render(<OnDeviceModelSection />);

    expect(
      await screen.findByText(/needs at least 8\.0 GB to run on the GPU, so it runs on the CPU/i),
    ).toBeInTheDocument();
    // The picker shows what will actually be used, not the stored preference.
    expect(screen.getByRole('combobox', { name: /run on/i })).toHaveTextContent(/CPU/);
  });

  it('unloads a resident model on request', async () => {
    const { plugin } = installFakeNative('android', {
      status: { 'gemma-4-e2b-it': { status: 'ready' } },
      loaded: { loaded: true, modelId: 'gemma-4-e2b-it', accelerator: 'cpu' },
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

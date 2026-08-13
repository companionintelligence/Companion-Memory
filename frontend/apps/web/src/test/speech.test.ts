import {
  ensureSpeechPermissions,
  installSynthesisLanguage,
  isSpeaking,
  listSpeechVoices,
  listSynthesisLanguages,
  probeSpeechRecognition,
  probeSpeechSynthesis,
  speakText,
  speechPlugin,
  startDictation,
  stopSpeaking,
} from '@ci/common/src/utils/speech';
import { afterEach, describe, expect, it, vi } from 'vitest';

type GlobalWithWindow = { window?: unknown };

function setWindow(value: unknown): void {
  (globalThis as GlobalWithWindow).window = value;
}

/** A listener handle whose `remove` is observable, matching the plugin's contract. */
function handle() {
  return { remove: vi.fn(async () => {}) };
}

type Listener = (event: unknown) => void;

/**
 * A stand-in for `window.Capacitor.Plugins.Speech`. `emit()` drives the registered
 * listeners the way the native side's `notifyListeners` would, so event plumbing can be
 * exercised without a device.
 */
function fakeSpeech(overrides: Record<string, unknown> = {}) {
  const listeners = new Map<string, Listener[]>();
  const handles: Array<ReturnType<typeof handle>> = [];

  const plugin = {
    checkPermissions: vi.fn(async () => ({ microphone: 'granted', speechRecognition: 'granted' })),
    requestPermissions: vi.fn(async () => ({ microphone: 'granted', speechRecognition: 'granted' })),
    getRecognitionCapability: vi.fn(async () => ({
      available: true,
      mode: 'on-device',
      guaranteedOnDevice: true,
      languagePack: 'installed',
      language: 'en-US',
      tier: 'android-checked-on-device',
    })),
    getRecognitionLanguages: vi.fn(async () => ({ languages: [], enumerable: false })),
    downloadRecognitionLanguage: vi.fn(async () => ({ started: true, languagePack: 'downloading' })),
    startListening: vi.fn(async () => ({
      mode: 'on-device',
      guaranteedOnDevice: true,
      tier: 'android-checked-on-device',
      language: 'en-US',
    })),
    stopListening: vi.fn(async () => {}),
    cancelListening: vi.fn(async () => {}),
    isListening: vi.fn(async () => ({ listening: false })),
    getSynthesisCapability: vi.fn(async () => ({
      available: true,
      offlineVoiceAvailable: true,
      languageStatus: 'available',
      language: 'en-US',
      maxInputLength: 4000,
    })),
    getVoices: vi.fn(async () => ({
      voices: [{ id: 'v1', name: 'Local', language: 'en-US', offline: true }],
    })),
    getSynthesisLanguages: vi.fn(async () => ({
      languages: [
        { tag: 'en-US', status: 'available' },
        { tag: 'fr-FR', status: 'missing-data' },
      ],
    })),
    installSynthesisLanguage: vi.fn(async () => ({ started: true })),
    speak: vi.fn(async () => ({
      completed: true,
      interrupted: false,
      voiceId: 'v1',
      offlineVoice: true,
      chunkCount: 1,
    })),
    stopSpeaking: vi.fn(async () => {}),
    isSpeaking: vi.fn(async () => ({ speaking: false })),
    addListener: vi.fn(async (eventName: string, listener: Listener) => {
      listeners.set(eventName, [...(listeners.get(eventName) ?? []), listener]);
      const created = handle();
      handles.push(created);

      return created;
    }),
    ...overrides,
  };

  return {
    plugin,
    handles,
    emit(eventName: string, event: unknown) {
      (listeners.get(eventName) ?? []).forEach((listener) => listener(event));
    },
    listenerCount(eventName: string) {
      return (listeners.get(eventName) ?? []).length;
    },
  };
}

/** `window` as the native shell presents it, with the Speech plugin bridged in. */
function setNativeWindow(plugin: unknown): void {
  setWindow({ Capacitor: { isNativePlatform: () => true, Plugins: { Speech: plugin } } });
}

afterEach(() => {
  delete (globalThis as GlobalWithWindow).window;
  vi.unstubAllGlobals();
});

describe('speech — inert on web', () => {
  it('reports recognition unavailable on web and never touches a browser speech API', async () => {
    // A browser SpeechRecognition constructor is present, as it would be in Chrome. The
    // wrapper must ignore it: Chrome's implementation is cloud-backed, and this product
    // does not silently route microphone audio to a third party as a "fallback".
    const webSpeechCtor = vi.fn();
    setWindow({ SpeechRecognition: webSpeechCtor, webkitSpeechRecognition: webSpeechCtor });

    const capability = await probeSpeechRecognition();

    expect(capability.available).toBe(false);
    expect(capability.mode).toBe('unavailable');
    expect(capability.guaranteedOnDevice).toBe(false);
    expect(capability.reason).toBeTruthy();
    expect(webSpeechCtor).not.toHaveBeenCalled();
  });

  it('reports synthesis unavailable on web and never touches window.speechSynthesis', async () => {
    const speak = vi.fn();
    setWindow({ speechSynthesis: { speak, getVoices: () => [{ name: 'Cloud' }] } });

    const capability = await probeSpeechSynthesis();

    expect(capability.available).toBe(false);
    expect(capability.offlineVoiceAvailable).toBe(false);
    expect(await listSpeechVoices()).toEqual([]);
    expect(await speakText('hello')).toBe(false);
    expect(await isSpeaking()).toBe(false);
    expect(speak).not.toHaveBeenCalled();
  });

  it('never starts a dictation session on web, even when a Speech plugin object is present', async () => {
    const { plugin } = fakeSpeech();

    // Closest approximation of the web build: `Capacitor` may exist (dev shell, tests)
    // but isNativePlatform() is false. Assert the gate itself, not just its absence.
    setWindow({ Capacitor: { isNativePlatform: () => false, Plugins: { Speech: plugin } } });

    expect(await startDictation()).toBeNull();
    expect(plugin.startListening).not.toHaveBeenCalled();
    expect(plugin.addListener).not.toHaveBeenCalled();
  });

  it('stopSpeaking and permission checks degrade quietly instead of throwing', async () => {
    setWindow({});

    await expect(stopSpeaking()).resolves.toBeUndefined();
    await expect(ensureSpeechPermissions()).resolves.toBe(false);
  });

  it('returns undefined from speechPlugin() when there is no window at all (SSR)', () => {
    delete (globalThis as GlobalWithWindow).window;

    expect(speechPlugin()).toBeUndefined();
  });
});

describe('speech — capability probe tiers', () => {
  it('passes through a guaranteed on-device answer from the API 33+ tier', async () => {
    const { plugin } = fakeSpeech();
    setNativeWindow(plugin);

    const capability = await probeSpeechRecognition('en-US');

    expect(capability).toMatchObject({
      available: true,
      mode: 'on-device',
      guaranteedOnDevice: true,
      languagePack: 'installed',
      tier: 'android-checked-on-device',
    });
    expect(plugin.getRecognitionCapability).toHaveBeenCalledWith({ language: 'en-US' });
  });

  it('reports the API 31–32 tier as guaranteed but with an unknown language pack', async () => {
    // isOnDeviceRecognitionAvailable() is only a framework-resource lookup, so on 31–32 the
    // recognizer is genuinely local while the *model* state is unknowable until runtime.
    const { plugin } = fakeSpeech({
      getRecognitionCapability: vi.fn(async () => ({
        available: true,
        mode: 'on-device',
        guaranteedOnDevice: true,
        languagePack: 'unknown',
        language: 'en-US',
        tier: 'android-on-device',
      })),
    });
    setNativeWindow(plugin);

    const capability = await probeSpeechRecognition();

    expect(capability.guaranteedOnDevice).toBe(true);
    expect(capability.languagePack).toBe('unknown');
    expect(capability.tier).toBe('android-on-device');
  });

  it('keeps best-effort distinct from on-device: available, but NOT guaranteed', async () => {
    // The whole point of the API. EXTRA_PREFER_OFFLINE is a hint AOSP says "may have no
    // effect", so a UI must be able to tell these two apart and say so.
    const { plugin } = fakeSpeech({
      getRecognitionCapability: vi.fn(async () => ({
        available: true,
        mode: 'best-effort',
        guaranteedOnDevice: false,
        languagePack: 'unknown',
        language: 'en-US',
        tier: 'android-prefer-offline-hint',
        reason: 'Android 30 can only be asked to prefer offline recognition.',
      })),
    });
    setNativeWindow(plugin);

    const capability = await probeSpeechRecognition();

    expect(capability.available).toBe(true);
    expect(capability.mode).toBe('best-effort');
    expect(capability.guaranteedOnDevice).toBe(false);
    expect(capability.reason).toBeTruthy();
  });

  it('surfaces a downloadable language pack rather than collapsing it into "unavailable"', async () => {
    const { plugin } = fakeSpeech({
      getRecognitionCapability: vi.fn(async () => ({
        available: true,
        mode: 'on-device',
        guaranteedOnDevice: true,
        languagePack: 'downloadable',
        language: 'fr-FR',
        tier: 'android-checked-on-device',
        reason: 'The on-device model for fr-FR is supported but not installed yet.',
      })),
    });
    setNativeWindow(plugin);

    const capability = await probeSpeechRecognition('fr-FR');

    expect(capability.available).toBe(true);
    expect(capability.languagePack).toBe('downloadable');
  });

  it('reports the iOS server tier as available but not guaranteed, with its duration cap', async () => {
    const { plugin } = fakeSpeech({
      getRecognitionCapability: vi.fn(async () => ({
        available: true,
        mode: 'network',
        guaranteedOnDevice: false,
        languagePack: 'unknown',
        language: 'en-US',
        tier: 'ios-server',
        maxDurationMs: 55_000,
      })),
    });
    setNativeWindow(plugin);

    const capability = await probeSpeechRecognition();

    expect(capability.mode).toBe('network');
    expect(capability.guaranteedOnDevice).toBe(false);
    expect(capability.maxDurationMs).toBe(55_000);
  });

  it('degrades to an unavailable answer with a reason when the native probe rejects', async () => {
    const { plugin } = fakeSpeech({
      getRecognitionCapability: vi.fn(async () => {
        throw new Error('recognition service crashed');
      }),
    });
    setNativeWindow(plugin);

    const capability = await probeSpeechRecognition('de-DE');

    // Never throws: a settings screen renders this answer directly.
    expect(capability.available).toBe(false);
    expect(capability.guaranteedOnDevice).toBe(false);
    expect(capability.reason).toBe('recognition service crashed');
    expect(capability.language).toBe('de-DE');
  });
});

describe('speech — permissions', () => {
  it('does not prompt when both grants are already in place', async () => {
    const { plugin } = fakeSpeech();
    setNativeWindow(plugin);

    expect(await ensureSpeechPermissions()).toBe(true);
    expect(plugin.requestPermissions).not.toHaveBeenCalled();
  });

  it('prompts when a grant is undecided and reports the post-prompt answer', async () => {
    const { plugin } = fakeSpeech({
      checkPermissions: vi.fn(async () => ({ microphone: 'prompt', speechRecognition: 'granted' })),
      requestPermissions: vi.fn(async () => ({ microphone: 'granted', speechRecognition: 'granted' })),
    });
    setNativeWindow(plugin);

    expect(await ensureSpeechPermissions()).toBe(true);
    expect(plugin.requestPermissions).toHaveBeenCalledTimes(1);
  });

  it('does not re-prompt a permanently denied grant', async () => {
    const { plugin } = fakeSpeech({
      checkPermissions: vi.fn(async () => ({ microphone: 'denied', speechRecognition: 'granted' })),
    });
    setNativeWindow(plugin);

    expect(await ensureSpeechPermissions()).toBe(false);
    expect(plugin.requestPermissions).not.toHaveBeenCalled();
  });

  it('treats a refused iOS speech-recognition grant as failure even when the mic is granted', async () => {
    // iOS needs SFSpeechRecognizer authorization *in addition to* the microphone one.
    const { plugin } = fakeSpeech({
      checkPermissions: vi.fn(async () => ({ microphone: 'granted', speechRecognition: 'prompt' })),
      requestPermissions: vi.fn(async () => ({ microphone: 'granted', speechRecognition: 'denied' })),
    });
    setNativeWindow(plugin);

    expect(await ensureSpeechPermissions()).toBe(false);
  });
});

describe('speech — dictation session', () => {
  it('subscribes before starting, so no partial result can be missed', async () => {
    const calls: string[] = [];
    const { plugin } = fakeSpeech({
      addListener: vi.fn(async (eventName: string) => {
        calls.push(`listen:${eventName}`);

        return handle();
      }),
      startListening: vi.fn(async () => {
        calls.push('start');

        return {
          mode: 'on-device',
          guaranteedOnDevice: true,
          tier: 'android-checked-on-device',
          language: 'en-US',
        };
      }),
    });
    setNativeWindow(plugin);

    await startDictation({ onPartial: vi.fn(), onResult: vi.fn() });

    expect(calls[calls.length - 1]).toBe('start');
    expect(calls.filter((entry) => entry.startsWith('listen:')).length).toBeGreaterThan(0);
  });

  it('plumbs partial results through, carrying guaranteedOnDevice on every event', async () => {
    const speech = fakeSpeech();
    setNativeWindow(speech.plugin);

    const onPartial = vi.fn();
    const session = await startDictation({ onPartial });

    expect(session).not.toBeNull();
    speech.emit('speechPartialResult', { transcript: 'hello', mode: 'on-device', guaranteedOnDevice: true });
    speech.emit('speechPartialResult', {
      transcript: 'hello there',
      mode: 'on-device',
      guaranteedOnDevice: true,
    });

    expect(onPartial).toHaveBeenNthCalledWith(1, 'hello', true);
    expect(onPartial).toHaveBeenNthCalledWith(2, 'hello there', true);
  });

  it('forwards a best-effort session honestly: the guarantee flag stays false on every partial', async () => {
    const speech = fakeSpeech({
      startListening: vi.fn(async () => ({
        mode: 'best-effort',
        guaranteedOnDevice: false,
        tier: 'android-prefer-offline-hint',
        language: 'en-US',
      })),
    });
    setNativeWindow(speech.plugin);

    const onPartial = vi.fn();
    const session = await startDictation({ onDevicePolicy: 'prefer', onPartial });

    expect(session?.mode).toBe('best-effort');
    expect(session?.guaranteedOnDevice).toBe(false);

    speech.emit('speechPartialResult', {
      transcript: 'maybe local',
      mode: 'best-effort',
      guaranteedOnDevice: false,
    });

    expect(onPartial).toHaveBeenCalledWith('maybe local', false);
  });

  it('defaults to the require policy so the private path is what you get by doing nothing', async () => {
    const { plugin } = fakeSpeech();
    setNativeWindow(plugin);

    await startDictation();

    expect(plugin.startListening).toHaveBeenCalledWith(
      expect.objectContaining({ onDevicePolicy: 'require', partialResults: true }),
    );
  });

  it('passes an explicit policy through unchanged', async () => {
    const { plugin } = fakeSpeech();
    setNativeWindow(plugin);

    await startDictation({ onDevicePolicy: 'allow', language: 'es-ES', silenceTimeoutMs: 1500 });

    expect(plugin.startListening).toHaveBeenCalledWith(
      expect.objectContaining({ onDevicePolicy: 'allow', language: 'es-ES', silenceTimeoutMs: 1500 }),
    );
  });

  it('delivers the final transcript and then unsubscribes when the session ends', async () => {
    const speech = fakeSpeech();
    setNativeWindow(speech.plugin);

    const onResult = vi.fn();
    const onEnd = vi.fn();
    await startDictation({ onResult, onEnd });

    speech.emit('speechResult', {
      transcript: 'remember the milk',
      alternatives: ['remember the milk', 'remember the silk'],
      mode: 'on-device',
      guaranteedOnDevice: true,
    });
    speech.emit('speechEnd', { reason: 'final-result' });

    expect(onResult).toHaveBeenCalledWith('remember the milk', true);
    expect(onEnd).toHaveBeenCalledWith('final-result');
    // A session that ends on its own must not leave listeners attached.
    expect(speech.handles.length).toBeGreaterThan(0);
    speech.handles.forEach((created) => expect(created.remove).toHaveBeenCalled());
  });

  it('unsubscribes every listener on stop()', async () => {
    const speech = fakeSpeech();
    setNativeWindow(speech.plugin);

    const session = await startDictation({ onPartial: vi.fn(), onResult: vi.fn(), onError: vi.fn() });
    // partial + result + error + the always-on end listener.
    expect(speech.handles).toHaveLength(4);

    await session?.stop();

    expect(speech.plugin.stopListening).toHaveBeenCalledTimes(1);
    speech.handles.forEach((created) => expect(created.remove).toHaveBeenCalledTimes(1));
  });

  it('unsubscribes on cancel() too, and does not finalize', async () => {
    const speech = fakeSpeech();
    setNativeWindow(speech.plugin);

    const session = await startDictation({ onResult: vi.fn() });
    await session?.cancel();

    expect(speech.plugin.cancelListening).toHaveBeenCalledTimes(1);
    expect(speech.plugin.stopListening).not.toHaveBeenCalled();
    speech.handles.forEach((created) => expect(created.remove).toHaveBeenCalledTimes(1));
  });

  it('reports errors through onError with their code', async () => {
    const speech = fakeSpeech();
    setNativeWindow(speech.plugin);

    const onError = vi.fn();
    await startDictation({ onError });

    speech.emit('speechError', {
      code: 'language-unavailable',
      message: 'The on-device model for this language is not installed.',
      recoverable: false,
    });

    expect(onError).toHaveBeenCalledWith('language-unavailable', expect.stringContaining('not installed'));
  });

  it('returns null and leaves nothing subscribed when the require policy cannot be met', async () => {
    const speech = fakeSpeech({
      startListening: vi.fn(async () => {
        throw new Error('on-device-unavailable');
      }),
    });
    setNativeWindow(speech.plugin);

    expect(await startDictation({ onPartial: vi.fn() })).toBeNull();
    // A refused start must not leak the listeners it registered in preparation.
    expect(speech.handles.length).toBeGreaterThan(0);
    speech.handles.forEach((created) => expect(created.remove).toHaveBeenCalled());
  });

  it('returns null without starting when permissions are refused', async () => {
    const { plugin } = fakeSpeech({
      checkPermissions: vi.fn(async () => ({ microphone: 'denied', speechRecognition: 'denied' })),
    });
    setNativeWindow(plugin);

    expect(await startDictation()).toBeNull();
    expect(plugin.startListening).not.toHaveBeenCalled();
    expect(plugin.addListener).not.toHaveBeenCalled();
  });
});

describe('speech — synthesis', () => {
  it('resolves speakText only once the utterance reports completion', async () => {
    let settle: ((value: unknown) => void) | undefined;
    const { plugin } = fakeSpeech({
      speak: vi.fn(
        () =>
          new Promise((resolve) => {
            settle = resolve;
          }),
      ),
    });
    setNativeWindow(plugin);

    const pending = speakText('the answer is 42');
    let resolved = false;
    void pending.then(() => {
      resolved = true;
    });

    // The native side resolves on the utterance's onDone, not when speak() is queued —
    // a talk-then-listen loop depends on this ordering.
    await Promise.resolve();
    expect(resolved).toBe(false);

    settle?.({ completed: true, interrupted: false, voiceId: 'v1', offlineVoice: true, chunkCount: 3 });

    expect(await pending).toBe(true);
  });

  it('reports false when the utterance was interrupted rather than completed', async () => {
    const { plugin } = fakeSpeech({
      speak: vi.fn(async () => ({
        completed: false,
        interrupted: true,
        voiceId: 'v1',
        offlineVoice: true,
        chunkCount: 1,
      })),
    });
    setNativeWindow(plugin);

    expect(await speakText('cut me off')).toBe(false);
  });

  it('requires an offline voice by default and forwards an explicit opt-out', async () => {
    const { plugin } = fakeSpeech();
    setNativeWindow(plugin);

    await speakText('hello');
    expect(plugin.speak).toHaveBeenCalledWith(
      expect.objectContaining({ requireOfflineVoice: true, interrupt: true }),
    );

    await speakText('hello', { requireOfflineVoice: false, rate: 1.2, pitch: 0.9, voiceId: 'v2' });
    expect(plugin.speak).toHaveBeenLastCalledWith(
      expect.objectContaining({ requireOfflineVoice: false, rate: 1.2, pitch: 0.9, voiceId: 'v2' }),
    );
  });

  it('returns false instead of throwing when the engine refuses the utterance', async () => {
    const { plugin } = fakeSpeech({
      speak: vi.fn(async () => {
        throw new Error('Voice data for fr-FR is not installed.');
      }),
    });
    setNativeWindow(plugin);

    await expect(speakText('bonjour', { language: 'fr-FR' })).resolves.toBe(false);
  });

  it('lists voices with the platform offline flag intact', async () => {
    const { plugin } = fakeSpeech({
      getVoices: vi.fn(async () => ({
        voices: [
          { id: 'local', name: 'Local', language: 'en-US', offline: true, quality: 'high' },
          { id: 'cloud', name: 'Cloud', language: 'en-US', offline: false },
        ],
      })),
    });
    setNativeWindow(plugin);

    const voices = await listSpeechVoices('en-US');

    expect(voices.map((voice) => voice.offline)).toEqual([true, false]);
    expect(plugin.getVoices).toHaveBeenCalledWith({ language: 'en-US' });
  });

  it('enumerates synthesis languages, keeping missing-data actionable', async () => {
    const { plugin } = fakeSpeech();
    setNativeWindow(plugin);

    const languages = await listSynthesisLanguages();

    // 'missing-data' must survive as its own state — collapsing it into "unavailable"
    // would hide the one thing the user can act on (installing the voice data).
    expect(languages).toEqual([
      { tag: 'en-US', status: 'available' },
      { tag: 'fr-FR', status: 'missing-data' },
    ]);
    expect(await installSynthesisLanguage()).toBe(true);
  });

  it('reports no synthesis languages and no installer on web', async () => {
    setWindow({});

    expect(await listSynthesisLanguages()).toEqual([]);
    expect(await installSynthesisLanguage()).toBe(false);
  });

  it('reports synthesis capability and speaking state from the plugin', async () => {
    const { plugin } = fakeSpeech({
      isSpeaking: vi.fn(async () => ({ speaking: true })),
    });
    setNativeWindow(plugin);

    await expect(probeSpeechSynthesis()).resolves.toMatchObject({
      available: true,
      offlineVoiceAvailable: true,
      maxInputLength: 4000,
    });
    await expect(isSpeaking()).resolves.toBe(true);
  });
});

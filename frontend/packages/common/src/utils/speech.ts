/**
 * Web-facing access layer over the native `Speech` plugin
 * (`frontend/packages/capacitor-speech`): offline speech recognition (STT) and synthesis
 * (TTS).
 *
 * Reached through the runtime `window.Capacitor.Plugins` bridge Capacitor injects —
 * deliberately NOT via a `@capacitor/*` or `@ci/capacitor-speech` import — so the web bundle
 * never pulls in native dependencies. The plugin interfaces below are structural mirrors of
 * that package's `src/definitions.ts`, which stays the source of truth; this is the same
 * convention `nativeBridge.ts` and `localHub.ts` follow.
 *
 * ## Graceful degradation on web: report unavailable, do not fall back to the cloud
 *
 * Every function here is gated on `isNativePlatform()` and degrades to an explicit
 * "unavailable" answer on web, never to a browser API.
 *
 * The browser *does* offer `SpeechRecognition`, but Chrome's implementation streams captured
 * audio to Google's servers and gives no way to verify a session ran locally. Wiring it in
 * as a "graceful fallback" would mean a privacy-first memory app quietly shipping the user's
 * voice to a third party at the exact moment the UI is most likely to be reassuring them it
 * does not — so it is not wired in. `speechSynthesis` is a weaker case (it sends text, not
 * microphone audio) but still exposes no reliable "this voice is local" signal, so it is
 * left out too rather than reporting an `offline` guarantee that isn't one.
 *
 * Callers therefore get `{ available: false, mode: 'unavailable' }` on web and should keep
 * their existing typed-input path. If a web voice feature is ever wanted, add it as an
 * explicit opt-in whose return value says plainly that it is not local — not here.
 */

import { isNativePlatform } from './apiBase';

/** See `SpeechOnDevicePolicy` in `@ci/capacitor-speech`. */
export type SpeechOnDevicePolicy = 'require' | 'prefer' | 'allow';

/** See `SpeechRecognitionMode` in `@ci/capacitor-speech`. */
export type SpeechRecognitionMode = 'on-device' | 'best-effort' | 'network' | 'unavailable';

export type SpeechRecognitionTier =
  | 'android-checked-on-device'
  | 'android-on-device'
  | 'android-prefer-offline-hint'
  | 'ios-on-device'
  | 'ios-server'
  | 'none';

export type SpeechLanguagePackState =
  | 'installed'
  | 'downloadable'
  | 'downloading'
  | 'unsupported'
  | 'unknown';

export interface SpeechRecognitionCapability {
  available: boolean;
  mode: SpeechRecognitionMode;
  /**
   * True only when the platform *guarantees* audio never leaves the device. Drive any
   * "stays private" UI copy off this, never off `available` — a `best-effort` session is
   * available and is not guaranteed.
   */
  guaranteedOnDevice: boolean;
  languagePack: SpeechLanguagePackState;
  language: string;
  tier: SpeechRecognitionTier;
  reason?: string;
  /** Platform cap on one session (iOS ~1 minute). Absent when the platform documents none. */
  maxDurationMs?: number;
}

export type SpeechSynthesisLanguageStatus = 'available' | 'missing-data' | 'not-supported' | 'unknown';

export interface SpeechSynthesisLanguage {
  tag: string;
  /** `missing-data` means the engine knows the language but its voice data is not installed. */
  status: SpeechSynthesisLanguageStatus;
}

export interface SpeechSynthesisCapability {
  available: boolean;
  offlineVoiceAvailable: boolean;
  languageStatus: SpeechSynthesisLanguageStatus;
  language: string;
  maxInputLength?: number;
  engine?: string;
  reason?: string;
}

export interface SpeechVoice {
  id: string;
  name: string;
  language: string;
  /** True only when the platform *states* no network is needed. False means unknown. */
  offline: boolean;
  quality?: 'low' | 'normal' | 'high';
}

export type SpeechErrorCode =
  | 'permission-denied'
  | 'no-match'
  | 'speech-timeout'
  | 'audio'
  | 'network'
  | 'busy'
  | 'client'
  | 'server'
  | 'language-unavailable'
  | 'language-not-supported'
  | 'on-device-unavailable'
  | 'max-duration'
  | 'not-supported'
  | 'unknown';

export type SpeechEndReason = 'final-result' | 'stopped' | 'cancelled' | 'silence' | 'error' | 'max-duration';

interface PluginListenerHandle {
  remove(): Promise<void> | void;
}

interface SpeechPermissionStatus {
  microphone: 'prompt' | 'prompt-with-rationale' | 'granted' | 'denied';
  speechRecognition: 'prompt' | 'prompt-with-rationale' | 'granted' | 'denied';
}

interface StartListeningResult {
  mode: SpeechRecognitionMode;
  guaranteedOnDevice: boolean;
  tier: SpeechRecognitionTier;
  language: string;
  maxDurationMs?: number;
}

interface SpeakResult {
  completed: boolean;
  interrupted: boolean;
  voiceId?: string;
  offlineVoice: boolean;
  chunkCount: number;
}

/** Structural mirror of `@ci/capacitor-speech`'s `SpeechPlugin` — see this file's header. */
interface SpeechPlugin {
  checkPermissions(): Promise<SpeechPermissionStatus>;
  requestPermissions(options?: {
    permissions?: Array<'microphone' | 'speechRecognition'>;
  }): Promise<SpeechPermissionStatus>;
  getRecognitionCapability(options?: { language?: string }): Promise<SpeechRecognitionCapability>;
  getRecognitionLanguages(): Promise<{
    languages: Array<{ tag: string; installed: boolean; downloadable: boolean; pending: boolean }>;
    enumerable: boolean;
  }>;
  downloadRecognitionLanguage(options: { language: string }): Promise<{
    started: boolean;
    languagePack: SpeechLanguagePackState;
    reason?: string;
  }>;
  startListening(options?: {
    language?: string;
    partialResults?: boolean;
    onDevicePolicy?: SpeechOnDevicePolicy;
    maxAlternatives?: number;
    silenceTimeoutMs?: number;
  }): Promise<StartListeningResult>;
  stopListening(): Promise<void>;
  cancelListening(): Promise<void>;
  isListening(): Promise<{ listening: boolean }>;
  getSynthesisCapability(options?: { language?: string }): Promise<SpeechSynthesisCapability>;
  getVoices(options?: { language?: string }): Promise<{ voices: SpeechVoice[] }>;
  getSynthesisLanguages(): Promise<{ languages: SpeechSynthesisLanguage[] }>;
  installSynthesisLanguage(): Promise<{ started: boolean; reason?: string }>;
  speak(options: {
    text: string;
    language?: string;
    voiceId?: string;
    rate?: number;
    pitch?: number;
    interrupt?: boolean;
    requireOfflineVoice?: boolean;
  }): Promise<SpeakResult>;
  stopSpeaking(): Promise<void>;
  isSpeaking(): Promise<{ speaking: boolean }>;
  addListener(
    eventName: 'speechPartialResult',
    listener: (event: {
      transcript: string;
      mode: SpeechRecognitionMode;
      guaranteedOnDevice: boolean;
    }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'speechResult',
    listener: (event: {
      transcript: string;
      alternatives: string[];
      mode: SpeechRecognitionMode;
      guaranteedOnDevice: boolean;
    }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'speechError',
    listener: (event: { code: SpeechErrorCode; message: string; recoverable: boolean }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'speechEnd',
    listener: (event: { reason: SpeechEndReason }) => void,
  ): Promise<PluginListenerHandle>;
}

/**
 * Why web reports unavailable rather than using the browser's `SpeechRecognition`. Exposed
 * so a settings screen can show the actual reason instead of inventing its own copy.
 */
export const WEB_SPEECH_UNAVAILABLE_REASON =
  'Speech is only available in the Companion app, where it runs on your device. The browser’s ' +
  'speech recognition sends audio to a cloud service, so it is not used here.';

const UNAVAILABLE_RECOGNITION: SpeechRecognitionCapability = {
  available: false,
  mode: 'unavailable',
  guaranteedOnDevice: false,
  languagePack: 'unknown',
  language: '',
  tier: 'none',
  reason: WEB_SPEECH_UNAVAILABLE_REASON,
};

const UNAVAILABLE_SYNTHESIS: SpeechSynthesisCapability = {
  available: false,
  offlineVoiceAvailable: false,
  languageStatus: 'unknown',
  language: '',
  reason: WEB_SPEECH_UNAVAILABLE_REASON,
};

/** The `Speech` plugin off the runtime Capacitor bridge, or undefined when absent. */
export function speechPlugin(): SpeechPlugin | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  return (window as unknown as { Capacitor?: { Plugins?: { Speech?: SpeechPlugin } } }).Capacitor?.Plugins
    ?.Speech;
}

/** Whether the native plugin is reachable at all (native shell + plugin synced in). */
function activePlugin(): SpeechPlugin | undefined {
  return isNativePlatform() ? speechPlugin() : undefined;
}

/**
 * What recognition this device can actually do. Never throws and never prompts: on web,
 * when the plugin isn't synced into the shell, or when the probe itself fails, it reports
 * unavailable with a `reason` rather than rejecting, so a settings screen can render the
 * answer directly.
 */
export async function probeSpeechRecognition(language?: string): Promise<SpeechRecognitionCapability> {
  const speech = activePlugin();

  if (!speech) {
    return UNAVAILABLE_RECOGNITION;
  }

  try {
    return await speech.getRecognitionCapability(language ? { language } : undefined);
  } catch (error) {
    return {
      ...UNAVAILABLE_RECOGNITION,
      language: language ?? '',
      reason: error instanceof Error ? error.message : 'Speech recognition could not be probed.',
    };
  }
}

/** What synthesis this device can actually do. Same never-throws contract as above. */
export async function probeSpeechSynthesis(language?: string): Promise<SpeechSynthesisCapability> {
  const speech = activePlugin();

  if (!speech) {
    return UNAVAILABLE_SYNTHESIS;
  }

  try {
    return await speech.getSynthesisCapability(language ? { language } : undefined);
  } catch (error) {
    return {
      ...UNAVAILABLE_SYNTHESIS,
      language: language ?? '',
      reason: error instanceof Error ? error.message : 'Speech synthesis could not be probed.',
    };
  }
}

/**
 * Ensure the microphone (and, on iOS, the separate speech-recognition) grants are in place.
 * Returns whether recognition can proceed. Prompts at most once per undecided permission —
 * `requestPermissions` is a no-op for a grant the user already answered. False on web.
 */
export async function ensureSpeechPermissions(): Promise<boolean> {
  const speech = activePlugin();

  if (!speech) {
    return false;
  }

  try {
    const current = await speech.checkPermissions();

    if (current.microphone === 'granted' && current.speechRecognition === 'granted') {
      return true;
    }

    if (current.microphone === 'denied' || current.speechRecognition === 'denied') {
      // Permanently denied: prompting again does nothing, the user has to visit Settings.
      return false;
    }

    const after = await speech.requestPermissions();

    return after.microphone === 'granted' && after.speechRecognition === 'granted';
  } catch {
    return false;
  }
}

/** Installed on-device recognition languages. Empty when the platform cannot enumerate. */
export async function listRecognitionLanguages(): Promise<
  Array<{ tag: string; installed: boolean; downloadable: boolean; pending: boolean }>
> {
  const speech = activePlugin();

  if (!speech) {
    return [];
  }

  try {
    const { languages } = await speech.getRecognitionLanguages();

    return languages;
  } catch {
    return [];
  }
}

/**
 * Ask the platform to fetch a missing on-device language model. Returns whether a download
 * was actually requested — false (never a throw) on web, on platforms with no such API, and
 * on failure.
 */
export async function downloadRecognitionLanguage(language: string): Promise<boolean> {
  const speech = activePlugin();

  if (!speech) {
    return false;
  }

  try {
    const { started } = await speech.downloadRecognitionLanguage({ language });

    return started;
  } catch {
    return false;
  }
}

export interface DictationOptions {
  language?: string;
  /** Default `'require'` — start only when local processing is guaranteed. */
  onDevicePolicy?: SpeechOnDevicePolicy;
  /** Set false to suppress `onPartial` entirely. Default true. */
  partialResults?: boolean;
  maxAlternatives?: number;
  silenceTimeoutMs?: number;
  /**
   * Incremental transcript while the user is still speaking. `guaranteedOnDevice` is passed
   * through on every call so a long session's UI cannot drift away from the truth.
   */
  onPartial?: (transcript: string, guaranteedOnDevice: boolean) => void;
  /** The final transcript for the session. */
  onResult?: (transcript: string, guaranteedOnDevice: boolean) => void;
  onError?: (code: SpeechErrorCode, message: string) => void;
  /** Fired once when the session ends, whatever ended it. */
  onEnd?: (reason: SpeechEndReason) => void;
}

/** A running dictation session. `stop`/`cancel` also unsubscribe every listener. */
export interface DictationSession {
  mode: SpeechRecognitionMode;
  /** See {@link SpeechRecognitionCapability.guaranteedOnDevice}. */
  guaranteedOnDevice: boolean;
  tier: SpeechRecognitionTier;
  language: string;
  /** Platform cap on this session (iOS ~1 minute), when one exists. */
  maxDurationMs?: number;
  /** Stop capturing and let the recognizer finalize — `onResult` still fires. */
  stop(): Promise<void>;
  /** Abandon with no final result. */
  cancel(): Promise<void>;
}

/**
 * Start dictation, returning the session's *actual* guarantees, or `null` when there is
 * nothing to dictate into (web, plugin not synced, permission refused, or the device cannot
 * satisfy `onDevicePolicy`). Failures that happen after the session starts arrive through
 * `onError`.
 *
 * Listeners are registered *before* `startListening()` so no partial result can be missed in
 * the gap, and are removed by `stop()`/`cancel()` — the same listener→unsubscribe idiom
 * `nativeBridge.ts` uses for `addBackButtonListener` and friends.
 */
export async function startDictation(options: DictationOptions = {}): Promise<DictationSession | null> {
  const speech = activePlugin();

  if (!speech) {
    return null;
  }

  if (!(await ensureSpeechPermissions())) {
    return null;
  }

  const handles: PluginListenerHandle[] = [];
  const unsubscribe = () => {
    handles.splice(0).forEach((handle) => {
      void handle.remove();
    });
  };

  try {
    if (options.onPartial) {
      const onPartial = options.onPartial;

      handles.push(
        await speech.addListener('speechPartialResult', (event) => {
          onPartial(event.transcript, event.guaranteedOnDevice);
        }),
      );
    }

    if (options.onResult) {
      const onResult = options.onResult;

      handles.push(
        await speech.addListener('speechResult', (event) => {
          onResult(event.transcript, event.guaranteedOnDevice);
        }),
      );
    }

    if (options.onError) {
      const onError = options.onError;

      handles.push(
        await speech.addListener('speechError', (event) => {
          onError(event.code, event.message);
        }),
      );
    }

    // Always subscribed: the session's listeners have to be torn down when it ends on its
    // own (silence, final result, iOS's duration cap), not only when the caller stops it.
    handles.push(
      await speech.addListener('speechEnd', (event) => {
        unsubscribe();
        options.onEnd?.(event.reason);
      }),
    );

    const started = await speech.startListening({
      language: options.language,
      partialResults: options.partialResults ?? true,
      onDevicePolicy: options.onDevicePolicy ?? 'require',
      maxAlternatives: options.maxAlternatives,
      silenceTimeoutMs: options.silenceTimeoutMs,
    });

    return {
      mode: started.mode,
      guaranteedOnDevice: started.guaranteedOnDevice,
      tier: started.tier,
      language: started.language,
      maxDurationMs: started.maxDurationMs,
      stop: async () => {
        try {
          await speech.stopListening();
        } finally {
          unsubscribe();
        }
      },
      cancel: async () => {
        try {
          await speech.cancelListening();
        } finally {
          unsubscribe();
        }
      },
    };
  } catch {
    // The session never started (policy refused, recognizer busy, permission revoked
    // between the check and the call) — leave nothing subscribed behind.
    unsubscribe();

    return null;
  }
}

/** Installed synthesis voices, best-first as the platform ordered them. Empty on web. */
export async function listSpeechVoices(language?: string): Promise<SpeechVoice[]> {
  const speech = activePlugin();

  if (!speech) {
    return [];
  }

  try {
    const { voices } = await speech.getVoices(language ? { language } : undefined);

    return voices;
  } catch {
    return [];
  }
}

/**
 * Languages the synthesis engine knows, each with its voice-data status. A `missing-data`
 * entry is actionable: {@link installSynthesisLanguage} launches the platform's installer.
 * Empty on web.
 */
export async function listSynthesisLanguages(): Promise<SpeechSynthesisLanguage[]> {
  const speech = activePlugin();

  if (!speech) {
    return [];
  }

  try {
    const { languages } = await speech.getSynthesisLanguages();

    return languages;
  } catch {
    return [];
  }
}

/**
 * Launch the platform's voice-data installer (Android `ACTION_INSTALL_TTS_DATA`) so the user
 * can add a missing language. Returns whether an installer actually opened — false on web
 * and on iOS, which installs voices only through Settings.
 */
export async function installSynthesisLanguage(): Promise<boolean> {
  const speech = activePlugin();

  if (!speech) {
    return false;
  }

  try {
    const { started } = await speech.installSynthesisLanguage();

    return started;
  } catch {
    return false;
  }
}

export interface SpeakTextOptions {
  language?: string;
  voiceId?: string;
  /** 1.0 = the platform's normal rate. */
  rate?: number;
  /** 1.0 = the platform's normal pitch. */
  pitch?: number;
  /** Flush anything currently speaking rather than queueing behind it. Default true. */
  interrupt?: boolean;
  /**
   * Refuse a voice the platform *states* needs a network. Default true. Only Android
   * publishes that flag, so this is effectively a no-op on iOS — see the plugin's README.
   */
  requireOfflineVoice?: boolean;
}

/**
 * Speak `text`, resolving when the utterance has actually finished — so a talk-then-listen
 * loop can await it before opening the microphone. Returns false on web, when the plugin is
 * absent, when the engine refuses (no offline voice, missing language data), or when the
 * utterance was cut short.
 */
export async function speakText(text: string, options: SpeakTextOptions = {}): Promise<boolean> {
  const speech = activePlugin();

  if (!speech) {
    return false;
  }

  try {
    const result = await speech.speak({
      text,
      language: options.language,
      voiceId: options.voiceId,
      rate: options.rate,
      pitch: options.pitch,
      interrupt: options.interrupt ?? true,
      requireOfflineVoice: options.requireOfflineVoice ?? true,
    });

    return result.completed;
  } catch {
    return false;
  }
}

/** Stop any in-flight utterance. No-op on web. */
export async function stopSpeaking(): Promise<void> {
  const speech = activePlugin();

  if (!speech) {
    return;
  }

  try {
    await speech.stopSpeaking();
  } catch {
    // Nothing speaking, or the engine is gone — nothing to stop.
  }
}

/** Whether the device is speaking right now. False on web. */
export async function isSpeaking(): Promise<boolean> {
  const speech = activePlugin();

  if (!speech) {
    return false;
  }

  try {
    const { speaking } = await speech.isSpeaking();

    return speaking;
  } catch {
    return false;
  }
}

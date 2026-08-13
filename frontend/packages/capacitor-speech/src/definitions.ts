import type { PermissionState, PluginListenerHandle } from '@capacitor/core';

/**
 * How hard the caller insists that captured audio never leaves the device.
 *
 * This exists because "offline speech recognition" is not a single guarantee across
 * Android API levels. Only some tiers let the OS *confirm* that recognition ran locally;
 * the oldest tier can only be *asked* to prefer offline (see
 * {@link SpeechRecognitionTier}). A privacy-positioned product must not paper over that
 * difference, so the caller picks the policy explicitly and the plugin reports back what
 * it actually got.
 *
 * - `require` (default) — start only when the platform guarantees on-device recognition.
 *   Otherwise `startListening()` rejects with `on-device-unavailable`.
 * - `prefer` — use a guaranteed on-device recognizer when one exists; otherwise fall back
 *   to the best-effort offline *hint* and report `guaranteedOnDevice: false` on the start
 *   result **and on every event**, so the UI can keep telling the truth.
 * - `allow` — additionally permit a recognizer that may send audio to a server. Never the
 *   default; a caller has to type this out.
 */
export type SpeechOnDevicePolicy = 'require' | 'prefer' | 'allow';

/**
 * What the recognizer that actually ran (or would run) does with the audio.
 *
 * - `on-device` — the platform guarantees local recognition (Android
 *   `createOnDeviceSpeechRecognizer`, iOS `requiresOnDeviceRecognition` on a recognizer
 *   whose `supportsOnDeviceRecognition` is true).
 * - `best-effort` — we asked for offline and cannot verify we got it. On Android 23–30
 *   this is `RecognizerIntent.EXTRA_PREFER_OFFLINE`, which AOSP documents as a hint that
 *   "may have no effect" depending on the recognizer implementation, with no callback
 *   confirming it was honored.
 * - `network` — a recognizer that may send audio off-device (only reachable under the
 *   `allow` policy).
 * - `unavailable` — no usable recognizer.
 */
export type SpeechRecognitionMode = 'on-device' | 'best-effort' | 'network' | 'unavailable';

/**
 * Which implementation path the plugin selected, for diagnostics and for explaining the
 * `guaranteedOnDevice` value to a user or a bug report.
 *
 * - `android-checked-on-device` — API 33+: `checkRecognitionSupport()` pre-flighted the
 *   language and `createOnDeviceSpeechRecognizer()` runs it. Strongest signal available.
 * - `android-on-device` — API 31–32: `isOnDeviceRecognitionAvailable()` +
 *   `createOnDeviceSpeechRecognizer()`. The recognizer is on-device, but there is no
 *   `checkRecognitionSupport()` yet, so a *missing language model* only shows up at
 *   runtime as `ERROR_LANGUAGE_UNAVAILABLE`.
 * - `android-prefer-offline-hint` — API 23–30: plain `createSpeechRecognizer()` plus the
 *   `EXTRA_PREFER_OFFLINE` hint. Never `guaranteedOnDevice`.
 * - `ios-on-device` / `ios-server` — `SFSpeechRecognizer` with, or without, a true
 *   `supportsOnDeviceRecognition` for the requested locale.
 * - `none` — nothing usable (also the web fallback's value).
 */
export type SpeechRecognitionTier =
  | 'android-checked-on-device'
  | 'android-on-device'
  | 'android-prefer-offline-hint'
  | 'ios-on-device'
  | 'ios-server'
  | 'none';

/**
 * State of the *language model* for a given language, which is separate from whether a
 * recognizer exists at all. Android's `isOnDeviceRecognitionAvailable()` is only a
 * framework-resource lookup: it answers "is there an on-device recognition service",
 * not "is a model for this language downloaded". Availability is not usability.
 *
 * - `installed` — usable right now, fully offline.
 * - `downloadable` — supported on-device but the pack must be fetched first; see
 *   {@link SpeechPlugin.downloadRecognitionLanguage}.
 * - `downloading` — a download is already queued or in flight (Android
 *   `RecognitionSupport.getPendingOnDeviceLanguages()`).
 * - `unsupported` — the on-device recognizer does not support this language at all.
 * - `unknown` — the platform exposes no way to tell (Android 23–32, iOS).
 */
export type SpeechLanguagePackState =
  | 'installed'
  | 'downloadable'
  | 'downloading'
  | 'unsupported'
  | 'unknown';

/** Result of {@link SpeechPlugin.getRecognitionCapability} — a pure probe, no side effects. */
export interface SpeechRecognitionCapability {
  /** Whether any recognizer at all could serve a request under the *current* policy-free view. */
  available: boolean;
  mode: SpeechRecognitionMode;
  /**
   * True only when the platform *guarantees* the audio stays on the device. Never true
   * for `best-effort`. Callers must drive any "stays private" UI copy off this flag, not
   * off `available`.
   */
  guaranteedOnDevice: boolean;
  languagePack: SpeechLanguagePackState;
  /** BCP-47 tag this answer is about (the requested language, or the device default). */
  language: string;
  tier: SpeechRecognitionTier;
  /** Human-readable explanation, always present when `available` is false. */
  reason?: string;
  /**
   * Hard platform cap on one recognition session, when the platform documents one.
   * iOS documents roughly a one-minute limit per `SFSpeechRecognitionTask`; Android's
   * recognizers end on silence rather than a fixed cap, so this is usually absent there.
   * A caller doing long dictation must segment rather than assume it can run forever.
   */
  maxDurationMs?: number;
}

/** One language the on-device recognizer knows about. */
export interface SpeechRecognitionLanguage {
  /** BCP-47 tag, as reported by the platform. */
  tag: string;
  /** Model present on disk — usable offline right now. */
  installed: boolean;
  /** Supported on-device, but the model still has to be downloaded. */
  downloadable: boolean;
  /** A download for this language is queued or in flight. */
  pending: boolean;
}

export interface SpeechRecognitionLanguagesResult {
  languages: SpeechRecognitionLanguage[];
  /**
   * False when the platform cannot enumerate on-device languages (Android 23–32, iOS),
   * in which case `languages` is empty and absence proves nothing.
   */
  enumerable: boolean;
}

export interface DownloadRecognitionLanguageOptions {
  /** BCP-47 tag to fetch, e.g. `'en-US'`. */
  language: string;
}

export interface DownloadRecognitionLanguageResult {
  /** Whether a download was actually requested of the platform. */
  started: boolean;
  /** Pack state after the request (`downloading` when `started`). */
  languagePack: SpeechLanguagePackState;
  /** Why nothing was started, when `started` is false. */
  reason?: string;
}

export interface StartListeningOptions {
  /** BCP-47 tag. Defaults to the device locale. */
  language?: string;
  /** Emit `speechPartialResult` events while the user is still talking. Default true. */
  partialResults?: boolean;
  /** How strictly to insist on local recognition. Default `'require'`. */
  onDevicePolicy?: SpeechOnDevicePolicy;
  /** Max alternative transcripts on the final result. Default 1. */
  maxAlternatives?: number;
  /**
   * Silence after speech that ends the session, in ms (Android
   * `EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS`). The recognizer treats this as a
   * hint and may clamp it. Ignored on iOS, which has no equivalent knob.
   */
  silenceTimeoutMs?: number;
}

/** What {@link SpeechPlugin.startListening} resolved with — the session's actual guarantees. */
export interface StartListeningResult {
  mode: SpeechRecognitionMode;
  /** See {@link SpeechRecognitionCapability.guaranteedOnDevice}. */
  guaranteedOnDevice: boolean;
  tier: SpeechRecognitionTier;
  language: string;
  /** Platform cap on this session, if any. See {@link SpeechRecognitionCapability.maxDurationMs}. */
  maxDurationMs?: number;
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

/** Incremental transcript while the user is still speaking. */
export interface SpeechPartialResultEvent {
  transcript: string;
  /** Repeated on every event on purpose: a long session must not lose the privacy context. */
  mode: SpeechRecognitionMode;
  guaranteedOnDevice: boolean;
}

/** The recognizer's final transcript for a session. */
export interface SpeechResultEvent {
  transcript: string;
  /** Ranked alternatives, best first; `transcript` is always `alternatives[0]`. */
  alternatives: string[];
  mode: SpeechRecognitionMode;
  guaranteedOnDevice: boolean;
}

export interface SpeechErrorEvent {
  code: SpeechErrorCode;
  message: string;
  /** Whether retrying the same call could plausibly succeed (e.g. `no-match`, `busy`). */
  recoverable: boolean;
}

export interface SpeechEndEvent {
  reason: SpeechEndReason;
}

/** Normalized voice quality. Android's 100–500 scale and iOS's enum both map onto this. */
export type SpeechVoiceQuality = 'low' | 'normal' | 'high';

export interface SpeechVoice {
  /** Stable platform identifier to pass back as {@link SpeakOptions.voiceId}. */
  id: string;
  name: string;
  /** BCP-47 tag. */
  language: string;
  /**
   * True only when the platform *states* this voice needs no network connection (Android
   * `Voice.isNetworkConnectionRequired() == false`).
   *
   * **False means "not stated", not "requires network."** Apple publishes no per-voice
   * offline flag at all, so every iOS voice reports `false` here — that is an absence of
   * evidence, not evidence of network use. Do not render `offline: false` as "this voice
   * sends your text to a server"; render it as unknown.
   */
  offline: boolean;
  quality?: SpeechVoiceQuality;
}

export interface SpeechVoicesResult {
  voices: SpeechVoice[];
}

export type SpeechSynthesisLanguageStatus = 'available' | 'missing-data' | 'not-supported' | 'unknown';

export interface SpeechSynthesisLanguage {
  tag: string;
  status: SpeechSynthesisLanguageStatus;
}

export interface SpeechSynthesisLanguagesResult {
  languages: SpeechSynthesisLanguage[];
}

/** Result of {@link SpeechPlugin.getSynthesisCapability} — a pure probe, no side effects. */
export interface SpeechSynthesisCapability {
  /** Whether a speech engine is bound and usable. */
  available: boolean;
  /** Whether at least one installed voice is reported as needing no network connection. */
  offlineVoiceAvailable: boolean;
  languageStatus: SpeechSynthesisLanguageStatus;
  /** BCP-47 tag this answer is about. */
  language: string;
  /**
   * Longest string a single native `speak()` accepts (Android
   * `TextToSpeech.getMaxSpeechInputLength()`). Longer text is chunked internally, so this
   * is informational — callers do not have to pre-split.
   */
  maxInputLength?: number;
  /** Engine package/identifier, when the platform exposes one. */
  engine?: string;
  reason?: string;
}

export interface SpeakOptions {
  text: string;
  /** BCP-47 tag. Defaults to the engine's current language. */
  language?: string;
  /** Voice id from {@link SpeechPlugin.getVoices}. Wins over `language` when both are given. */
  voiceId?: string;
  /** 1.0 = the engine's normal rate. Clamped to a sane range by the native side. */
  rate?: number;
  /** 1.0 = the engine's normal pitch. Clamped to a sane range by the native side. */
  pitch?: number;
  /** Flush anything currently speaking instead of queueing behind it. Default true. */
  interrupt?: boolean;
  /**
   * Refuse to speak with a voice the platform *states* needs a network connection. Default
   * true — matching this product's privacy posture. Set false only for a deliberate,
   * disclosed online-voice feature.
   *
   * Because only Android publishes that flag (see {@link SpeechVoice.offline}), this is
   * effectively a no-op on iOS: there is no voice iOS declares as network-requiring, so
   * nothing gets refused. It is not a guarantee, it is a filter on a signal one platform
   * gives us.
   */
  requireOfflineVoice?: boolean;
}

export interface SpeakResult {
  /** True when the utterance finished speaking. */
  completed: boolean;
  /** True when a later `speak({ interrupt: true })` or `stopSpeaking()` cut it short. */
  interrupted: boolean;
  /** The voice that actually spoke, when the platform reports one. */
  voiceId?: string;
  /** Whether that voice is reported as needing no network. See {@link SpeechVoice.offline}. */
  offlineVoice: boolean;
  /** How many native utterances the text was split into (see `maxInputLength`). */
  chunkCount: number;
}

export interface IsListeningResult {
  listening: boolean;
}

export interface IsSpeakingResult {
  speaking: boolean;
}

export interface InstallSynthesisLanguageResult {
  /** Whether the platform's voice-data installer was launched. */
  started: boolean;
  reason?: string;
}

/**
 * Permission aliases this plugin manages. On Android `speechRecognition` has no
 * corresponding OS permission and is always reported `granted`; iOS requires a separate
 * `SFSpeechRecognizer.requestAuthorization` grant *in addition to* the microphone one.
 */
export type SpeechPermissionAlias = 'microphone' | 'speechRecognition';

export interface SpeechPermissionStatus {
  microphone: PermissionState;
  speechRecognition: PermissionState;
}

export interface RequestSpeechPermissionsOptions {
  /** Subset to request. Omit to request all of them. */
  permissions?: SpeechPermissionAlias[];
}

export interface RecognitionCapabilityOptions {
  /** BCP-47 tag to probe. Defaults to the device locale. */
  language?: string;
}

export interface SynthesisCapabilityOptions {
  /** BCP-47 tag to probe. Defaults to the engine's current language. */
  language?: string;
}

export interface GetVoicesOptions {
  /** Restrict to voices whose language matches this BCP-47 tag (prefix match on the base language). */
  language?: string;
}

/**
 * Offline speech: on-device recognition (STT) and synthesis (TTS) for the mobile shell.
 * Reached at runtime via `window.Capacitor.Plugins.Speech` — see
 * `@ci/common/src/utils/speech.ts` for the wrappers the web app actually calls; the web
 * bundle never imports this package directly.
 *
 * The whole surface is built around one rule: **never let a caller believe audio stayed
 * on the device when that cannot be proven.** Every capability, start result, and result
 * event carries `guaranteedOnDevice`, and the default {@link SpeechOnDevicePolicy} is
 * `require`, so the privacy-preserving behavior is what you get by doing nothing.
 */
export interface SpeechPlugin {
  /** Current grant state for both aliases. Never prompts. */
  checkPermissions(): Promise<SpeechPermissionStatus>;

  /** Prompt for the missing grants (no-op for ones already decided). */
  requestPermissions(options?: RequestSpeechPermissionsOptions): Promise<SpeechPermissionStatus>;

  /**
   * Pure capability probe for recognition: which tier applies on this OS version, whether
   * the result is a real on-device guarantee, and whether the language model is present.
   * No microphone access, no permission prompt, no downloads.
   */
  getRecognitionCapability(options?: RecognitionCapabilityOptions): Promise<SpeechRecognitionCapability>;

  /**
   * Enumerate on-device recognition languages and their model state. Only Android 33+
   * can answer this; elsewhere `enumerable` is false and `languages` is empty.
   */
  getRecognitionLanguages(): Promise<SpeechRecognitionLanguagesResult>;

  /**
   * Ask the platform to fetch a missing on-device language model (Android 33+
   * `triggerModelDownload`). Resolves once the download has been *requested*, not once it
   * completes — poll {@link getRecognitionCapability} or {@link getRecognitionLanguages}.
   * Rejects as `not-supported` where the platform offers no such API (iOS, Android ≤ 32).
   */
  downloadRecognitionLanguage(
    options: DownloadRecognitionLanguageOptions,
  ): Promise<DownloadRecognitionLanguageResult>;

  /**
   * Begin a recognition session. Resolves as soon as the recognizer is listening, with the
   * guarantees that session actually has; transcripts arrive as `speechPartialResult` /
   * `speechResult` events, so subscribe *before* calling. Rejects with
   * `on-device-unavailable` when the policy is `require` and the platform cannot guarantee
   * local recognition, and with `permission-denied` when the microphone grant is missing.
   */
  startListening(options?: StartListeningOptions): Promise<StartListeningResult>;

  /** Stop capturing and let the recognizer finalize; a `speechResult` still follows. */
  stopListening(): Promise<void>;

  /** Abandon the session with no final result. Emits `speechEnd` with reason `cancelled`. */
  cancelListening(): Promise<void>;

  isListening(): Promise<IsListeningResult>;

  /** Pure capability probe for synthesis. No audio is produced. */
  getSynthesisCapability(options?: SynthesisCapabilityOptions): Promise<SpeechSynthesisCapability>;

  /** Installed voices, with the platform's own "needs network" answer per voice. */
  getVoices(options?: GetVoicesOptions): Promise<SpeechVoicesResult>;

  /** Languages the synthesis engine can speak, with per-language data status. */
  getSynthesisLanguages(): Promise<SpeechSynthesisLanguagesResult>;

  /**
   * Launch the platform's voice-data installer (Android `ACTION_INSTALL_TTS_DATA`) so the
   * user can add a missing language. Resolves `{ started: false }` where unsupported.
   */
  installSynthesisLanguage(): Promise<InstallSynthesisLanguageResult>;

  /**
   * Speak `text`. Resolves when the utterance finishes (or is interrupted) — not when it
   * starts — so a talk-then-listen loop can await it before opening the microphone.
   */
  speak(options: SpeakOptions): Promise<SpeakResult>;

  /** Stop any in-flight utterance. Pending `speak()` promises resolve with `interrupted: true`. */
  stopSpeaking(): Promise<void>;

  isSpeaking(): Promise<IsSpeakingResult>;

  addListener(
    eventName: 'speechPartialResult',
    listenerFunc: (event: SpeechPartialResultEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'speechResult',
    listenerFunc: (event: SpeechResultEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'speechError',
    listenerFunc: (event: SpeechErrorEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'speechEnd',
    listenerFunc: (event: SpeechEndEvent) => void,
  ): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}

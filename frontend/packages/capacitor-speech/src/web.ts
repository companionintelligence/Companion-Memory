import { WebPlugin } from '@capacitor/core';

import type {
  DownloadRecognitionLanguageResult,
  InstallSynthesisLanguageResult,
  IsListeningResult,
  IsSpeakingResult,
  SpeakResult,
  SpeechPermissionStatus,
  SpeechPlugin,
  SpeechRecognitionCapability,
  SpeechRecognitionLanguagesResult,
  SpeechSynthesisCapability,
  SpeechSynthesisLanguagesResult,
  SpeechVoicesResult,
  StartListeningResult,
} from './definitions';

/**
 * Web/no-op implementation.
 *
 * **This deliberately does not bridge to the browser's Web Speech API.** A browser
 * `SpeechRecognition` is available in Chrome, but Chrome's implementation streams the
 * captured audio to Google's servers for recognition; Chrome exposes no way to verify
 * that a given session ran locally. Silently routing a privacy-first memory app's
 * microphone through a cloud recognizer as a "graceful fallback" would be exactly the
 * kind of thing this plugin's API is shaped to prevent, so the web path reports
 * `unavailable` instead and callers keep their existing typed-input flow.
 *
 * `speechSynthesis` (TTS) is a weaker case — it sends text, not microphone audio, and
 * several browsers do use local voices — but the platform still gives no reliable
 * "this voice is local" signal, so it is left out too rather than shipping an
 * `offline: true` we cannot stand behind. If a web voice feature is ever wanted, add it
 * as an explicit opt-in that reports `offline: false`, not here.
 *
 * Methods intentionally ignore their arguments (TS allows implementing a narrower
 * arity) — nothing on web can act on a language/voice/text.
 */
export class SpeechWeb extends WebPlugin implements SpeechPlugin {
  async checkPermissions(): Promise<SpeechPermissionStatus> {
    return { microphone: 'denied', speechRecognition: 'denied' };
  }

  async requestPermissions(): Promise<SpeechPermissionStatus> {
    return { microphone: 'denied', speechRecognition: 'denied' };
  }

  async getRecognitionCapability(): Promise<SpeechRecognitionCapability> {
    return {
      available: false,
      mode: 'unavailable',
      guaranteedOnDevice: false,
      languagePack: 'unknown',
      language: '',
      tier: 'none',
      reason:
        'On-device speech recognition is only available in the native app. The browser Web Speech API is not used because it sends audio to a cloud recognizer.',
    };
  }

  async getRecognitionLanguages(): Promise<SpeechRecognitionLanguagesResult> {
    return { languages: [], enumerable: false };
  }

  async downloadRecognitionLanguage(): Promise<DownloadRecognitionLanguageResult> {
    return {
      started: false,
      languagePack: 'unknown',
      reason: 'Language packs are only managed by the native app.',
    };
  }

  async startListening(): Promise<StartListeningResult> {
    throw this.unavailable('Speech recognition is only available in the native app.');
  }

  async stopListening(): Promise<void> {
    // Nothing listening on web — no-op.
  }

  async cancelListening(): Promise<void> {
    // Nothing listening on web — no-op.
  }

  async isListening(): Promise<IsListeningResult> {
    return { listening: false };
  }

  async getSynthesisCapability(): Promise<SpeechSynthesisCapability> {
    return {
      available: false,
      offlineVoiceAvailable: false,
      languageStatus: 'unknown',
      language: '',
      reason: 'Speech synthesis is only available in the native app.',
    };
  }

  async getVoices(): Promise<SpeechVoicesResult> {
    return { voices: [] };
  }

  async getSynthesisLanguages(): Promise<SpeechSynthesisLanguagesResult> {
    return { languages: [] };
  }

  async installSynthesisLanguage(): Promise<InstallSynthesisLanguageResult> {
    return { started: false, reason: 'Voice data is only installed by the native app.' };
  }

  async speak(): Promise<SpeakResult> {
    throw this.unavailable('Speech synthesis is only available in the native app.');
  }

  async stopSpeaking(): Promise<void> {
    // Nothing speaking on web — no-op.
  }

  async isSpeaking(): Promise<IsSpeakingResult> {
    return { speaking: false };
  }
}

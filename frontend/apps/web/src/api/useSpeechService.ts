import { useCallback, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { convertBlobToBase64, convertBase64ToBlob, AUDIO_CONSTANTS } from '@/lib/audio-utils';

interface SpeechServiceState {
  loading: boolean;
  error: string | null;
}

interface UseSpeechServiceReturn {
  state: SpeechServiceState;
  transcribeAudio: (audioBlob: Blob) => Promise<string>;
  synthesizeSpeech: (text: string) => Promise<Blob>;
}

export function useSpeechService(): UseSpeechServiceReturn {
  const [{ authToken }] = useAuth();
  const [state, setState] = useState<SpeechServiceState>({
    loading: false,
    error: null,
  });

  const transcribeAudio = useCallback(
    async (audioBlob: Blob): Promise<string> => {
      setState({ loading: true, error: null });

      try {
        if (!authToken) {
          throw new Error('Authentication token not found');
        }

        // Convert audio blob to base64 using utility function
        const base64Audio = await convertBlobToBase64(audioBlob);

        console.log('Sending STT request with audio size:', base64Audio.length, 'characters');

        // Create an AbortController for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), AUDIO_CONSTANTS.TIMEOUT_MS);

        const response = await fetch('/api/stt/transcribe', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({ audio: base64Audio }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          if (response.status === 401) {
            throw new Error('Unauthorized: Please log in again');
          } else if (response.status === 403) {
            throw new Error('Forbidden: Access denied');
          } else if (response.status === 422) {
            throw new Error('Invalid audio format: Please try again');
          } else {
            throw new Error(`STT request failed: ${response.statusText}`);
          }
        }

        const result = await response.json();
        setState({ loading: false, error: null });

        return result.text || result.transcription || '';
      } catch (error) {
        let errorMessage = 'Unknown error';

        if (error instanceof Error) {
          if (error.name === 'AbortError') {
            errorMessage = 'Request timeout: Audio processing took too long';
          } else {
            errorMessage = error.message;
          }
        }

        setState({ loading: false, error: errorMessage });
        throw error;
      }
    },
    [authToken],
  );

  const synthesizeSpeech = useCallback(
    async (text: string): Promise<Blob> => {
      setState({ loading: true, error: null });

      try {
        if (!authToken) {
          throw new Error('Authentication token not found');
        }

        const response = await fetch('/api/tts/convert', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({ text }),
        });

        if (!response.ok) {
          if (response.status === 401) {
            throw new Error('Unauthorized: Please log in again');
          } else if (response.status === 403) {
            throw new Error('Forbidden: Access denied');
          } else {
            throw new Error(`TTS request failed: ${response.statusText}`);
          }
        }

        // The TTS service returns a JSON response with base64-encoded WAV data
        const result = await response.json();
        console.log('🎤 TTS response received:', {
          hasAudio: !!result.audio,
          audioLength: result.audio?.length,
          sampleRate: result.sample_rate,
          duration: result.duration,
        });

        if (!result.audio) {
          throw new Error('No audio data received from TTS service');
        }

        // Convert base64 to audio blob using utility function
        const audioBlob = convertBase64ToBlob(result.audio, AUDIO_CONSTANTS.MIME_TYPES.WAV);
        console.log('🎤 Created audio blob:', { size: audioBlob.size, type: audioBlob.type });

        setState({ loading: false, error: null });

        return audioBlob;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        setState({ loading: false, error: errorMessage });
        throw error;
      }
    },
    [authToken],
  );

  return {
    state,
    transcribeAudio,
    synthesizeSpeech,
  };
}

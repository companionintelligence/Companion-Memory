import { useCallback, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';

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

        // Convert audio blob to base64 using FileReader (more reliable)
        const base64Audio = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const result = reader.result as string;
            // Remove the data URL prefix (e.g., "data:audio/webm;base64,")
            const base64 = result.split(',')[1];
            resolve(base64);
          };

          reader.onerror = () => reject(new Error('Failed to read audio file'));
          reader.readAsDataURL(audioBlob);
        });

        console.log('Sending STT request with audio size:', base64Audio.length, 'characters');

        // Create an AbortController for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 120000); // 120 second timeout

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

        // Convert base64 to binary data
        const binaryString = atob(result.audio);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }

        // Create a WAV blob with proper MIME type
        const audioBlob = new Blob([bytes], { type: 'audio/wav' });
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

import React, { useState, useCallback, useEffect } from 'react';
import { Button } from '@ci/shadcn';
import { Volume2, Loader2 } from '@ci/shadcn/icons';

interface TTSButtonProps {
  text: string;
  disabled?: boolean;
  className?: string;
  voiceServiceUrl?: string;
}

interface TTSHealthResponse {
  status: string;
  voice_model: string;
  higgs_loaded: boolean | null;
  piper_loaded: boolean | null;
}

export const TTSButton: React.FC<TTSButtonProps> = ({
  text,
  disabled = false,
  className = '',
  voiceServiceUrl = '/tts/v1/chat/completions',
}) => {
  // Ensure we use the same protocol as the current page
  const getFullUrl = (path: string) => {
    if (path.startsWith('https')) {
      return path;
    }

    // Use the same protocol as the current page
    return `${window.location.protocol}//${window.location.host}${path}`;
  };

  const [isPlaying, setIsPlaying] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voiceModel, setVoiceModel] = useState<string | null>(null);
  const [isHealthChecked, setIsHealthChecked] = useState(false);

  const audioRef = React.useRef<HTMLAudioElement | null>(null);

  // Check TTS service health on mount
  useEffect(() => {
    const checkHealth = async () => {
      try {
        // Use vLLM health endpoint
        const healthUrl = voiceServiceUrl.replace('/v1/chat/completions', '/health');

        const fullHealthUrl = getFullUrl(healthUrl);
        console.log(`Checking TTS health at: ${fullHealthUrl}`);

        const response = await fetch(fullHealthUrl, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
          },
        });

        if (response.ok) {
          const health: TTSHealthResponse = await response.json();
          setVoiceModel(health.voice_model);
          console.log(`TTS service health: ${health.voice_model} model loaded`);
        } else {
          console.warn('TTS health check failed, using default parameters');
        }
      } catch (err) {
        console.warn('TTS health check error, using default parameters:', err);
      } finally {
        setIsHealthChecked(true);
      }
    };

    checkHealth();
  }, [voiceServiceUrl]);

  const playTTS = useCallback(async () => {
    if (!text.trim() || isPlaying || isProcessing) {
      return;
    }

    try {
      setError(null);
      setIsProcessing(true);

      // Prepare request body for Higgs Audio vLLM
      const requestBody = {
        model: 'higgs-audio-v2-generation-3B-base',
        messages: [
          {
            role: 'user',
            content: text.trim(),
          },
        ],
        max_tokens: 2048,
      };

      const fullTtsUrl = getFullUrl(voiceServiceUrl);
      //console.log(`Sending TTS request to ${fullTtsUrl} with model: ${voiceModel}`);
      console.log('Request body:', requestBody);

      // Send TTS request to voice service
      const response = await fetch(fullTtsUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      console.log(`TTS response status: ${response.status}`);

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`TTS service error: ${response.status} - ${errorText}`);
        throw new Error(`TTS service error: ${response.status} - ${errorText}`);
      }

      const result = await response.json();
      console.log('TTS response received:', result);

      // Extract audio data from Higgs Audio vLLM response
      if (result.choices && result.choices.length > 0) {
        const choice = result.choices[0];
        if (choice.message && choice.message.audio && choice.message.audio.data) {
          const audioData = choice.message.audio.data;

          // Convert base64 to audio blob
          const binaryString = atob(audioData);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }

          // Use MP3 format for better browser compatibility
          const audioBlob = new Blob([bytes], { type: 'audio/mpeg' });
          const audioUrl = URL.createObjectURL(audioBlob);

          // Create and play audio
          const audio = new Audio(audioUrl);
          audioRef.current = audio;

          audio.onended = () => {
            setIsPlaying(false);
            URL.revokeObjectURL(audioUrl);
          };

          audio.onerror = () => {
            setIsPlaying(false);
            setError('Failed to play audio');
            URL.revokeObjectURL(audioUrl);
          };

          await audio.play();
          setIsPlaying(true);
        } else {
          throw new Error('No audio data found in response');
        }
      } else {
        throw new Error('No audio data received');
      }
    } catch (err) {
      console.error('TTS error:', err);
      setError(err instanceof Error ? err.message : 'Failed to generate speech');
    } finally {
      setIsProcessing(false);
    }
  }, [text, isPlaying, isProcessing, voiceServiceUrl, voiceModel]);

  const stopTTS = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      setIsPlaying(false);
    }
  }, []);

  const toggleTTS = useCallback(() => {
    if (isPlaying) {
      stopTTS();
    } else {
      playTTS();
    }
  }, [isPlaying, playTTS, stopTTS]);

  // Cleanup on unmount
  React.useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  // Show loading state while checking health
  if (!isHealthChecked) {
    return (
      <div className={`flex items-center gap-2 ${className}`}>
        <Button type="button" variant="outline" size="sm" disabled={true} className="gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Checking...
        </Button>
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={toggleTTS}
        disabled={disabled || isProcessing || !text.trim()}
        className="gap-2 bg-background/80 backdrop-blur-sm border-border/50"
        title={voiceModel ? `Using ${voiceModel} TTS model` : 'TTS service'}
      >
        {isProcessing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Volume2 className="h-4 w-4" />}
        {isProcessing ? 'Generating...' : isPlaying ? 'Stop' : 'Listen'}
      </Button>

      {error && <div className="text-sm text-destructive">{error}</div>}
    </div>
  );
};

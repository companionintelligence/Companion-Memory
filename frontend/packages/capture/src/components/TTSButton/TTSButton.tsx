import React, { useState, useCallback } from 'react';
import { Button } from '@ci/shadcn';
import { Volume2, Loader2 } from '@ci/shadcn/icons';

interface TTSButtonProps {
  text: string;
  disabled?: boolean;
  className?: string;
}

export const TTSButton: React.FC<TTSButtonProps> = ({
  text,
  disabled = false,
  className = '',
}) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const audioRef = React.useRef<HTMLAudioElement | null>(null);

  const playTTS = useCallback(async () => {
    if (!text.trim() || isPlaying || isProcessing) {
      return;
    }

    try {
      setError(null);
      setIsProcessing(true);

      // Send TTS request to voice service
      const response = await fetch('/voice/tts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: text.trim(),
          voice: 'alloy',
          speed: 1.0,
          pitch: 1.0,
        }),
      });

      if (!response.ok) {
        throw new Error(`TTS service error: ${response.statusText}`);
      }

      const result = await response.json();

      if (result.audio_data) {
        // Convert base64 to audio blob
        const binaryString = atob(result.audio_data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        
        const audioBlob = new Blob([bytes], { type: 'audio/wav' });
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
        throw new Error('No audio data received');
      }

    } catch (err) {
      console.error('TTS error:', err);
      setError(err instanceof Error ? err.message : 'Failed to generate speech');
    } finally {
      setIsProcessing(false);
    }
  }, [text, isPlaying, isProcessing]);

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

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={toggleTTS}
        disabled={disabled || isProcessing || !text.trim()}
        className="gap-2"
      >
        {isProcessing ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Volume2 className="h-4 w-4" />
        )}
        {isProcessing ? 'Generating...' : isPlaying ? 'Stop' : 'Listen'}
      </Button>
      
      {error && (
        <div className="text-sm text-destructive">
          {error}
        </div>
      )}
    </div>
  );
};

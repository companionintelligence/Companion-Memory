import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Button } from '@ci/shadcn';
import { Mic, MicOff, Loader2 } from '@ci/shadcn/icons';

interface VoiceInputProps {
  onTranscription: (text: string) => void;
  disabled?: boolean;
  className?: string;
  voiceServiceUrl?: string; // Add configurable voice service URL
}

export const VoiceInput: React.FC<VoiceInputProps> = ({
  onTranscription,
  disabled = false,
  className = '',
  voiceServiceUrl = '/stt/transcribe', // Default to STT service
}) => {
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const startRecording = useCallback(async () => {
    try {
      setError(null);

      // Debug logging

      console.log('Starting voice recording...');

      console.log('navigator:', navigator);

      console.log('navigator.mediaDevices:', navigator?.mediaDevices);

      console.log('window:', typeof window);

      // Check if we're in a browser environment
      if (typeof window === 'undefined') {
        throw new Error('Voice input is not available in this environment');
      }

      // Check if navigator is available
      if (!navigator) {
        throw new Error('Navigator API not available');
      }

      // Check if mediaDevices is available
      if (!navigator.mediaDevices) {
        throw new Error(
          'MediaDevices API not supported in this browser. Please use a modern browser with microphone support.',
        );
      }

      // Check if getUserMedia is available
      if (!navigator.mediaDevices.getUserMedia) {
        throw new Error(
          'getUserMedia not supported in this browser. Please use a modern browser with microphone support.',
        );
      }

      // Check if MediaRecorder is available
      if (!window.MediaRecorder) {
        throw new Error('MediaRecorder not supported in this browser. Please use a modern browser.');
      }

      console.log('All browser APIs are available, requesting microphone access...');

      // Request microphone access
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      console.log('Microphone access granted, creating MediaRecorder...');

      streamRef.current = stream;

      // Create MediaRecorder
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm;codecs=opus',
      });

      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      // Handle data available
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      // Handle recording stop
      mediaRecorder.onstop = async () => {
        setIsProcessing(true);

        try {
          // Create audio blob
          const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });

          // Convert to base64 using FileReader for better binary handling
          const base64Audio = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              const result = reader.result as string;
              // Remove data URL prefix if present
              const base64 = result.includes(',') ? result.split(',')[1] : result;
              resolve(base64);
            };

            reader.onerror = reject;
            reader.readAsDataURL(audioBlob);
          });

          // Send to voice service
          const response = await fetch(voiceServiceUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              audio_data: base64Audio,
              sample_rate: 16000,
              language: 'en',
              model_size: 'base',
            }),
          });

          if (!response.ok) {
            throw new Error(`Voice service error: ${response.statusText}`);
          }

          const result = await response.json();

          if (result.text && result.text.trim()) {
            onTranscription(result.text.trim());
          }
        } catch (err) {
          console.error('Voice transcription error:', err);
          setError(err instanceof Error ? err.message : 'Failed to transcribe audio');
        } finally {
          setIsProcessing(false);
        }
      };

      // Start recording
      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      console.error('Failed to start recording:', err);
      setError(err instanceof Error ? err.message : 'Failed to access microphone');
    }
  }, [onTranscription, voiceServiceUrl]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }

    // Stop all tracks
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }, [isRecording]);

  const toggleRecording = useCallback(() => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }, [isRecording, startRecording, stopRecording]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  // Check for browser compatibility on mount
  useEffect(() => {
    const checkBrowserCompatibility = async () => {
      try {
        // Check if we're in a browser environment
        if (typeof window === 'undefined') {
          setError('Voice input is not available in this environment');

          return;
        }

        console.log('Checking browser compatibility...');
        console.log('navigator:', navigator);
        console.log('navigator.mediaDevices:', navigator?.mediaDevices);
        console.log('window.MediaRecorder:', window.MediaRecorder);

        // Check if mediaDevices is supported
        if (!navigator.mediaDevices) {
          setError(
            'MediaDevices API not supported in this browser. Please use a modern browser with microphone support.',
          );

          return;
        }

        if (!navigator.mediaDevices.getUserMedia) {
          setError(
            'getUserMedia not supported in this browser. Please use a modern browser with microphone support.',
          );

          return;
        }

        // Check if MediaRecorder is supported
        if (!window.MediaRecorder) {
          setError('MediaRecorder not supported in this browser. Please use a modern browser.');

          return;
        }

        // Test if we can actually access the microphone (this will trigger permission request)
        console.log('Testing microphone access...');
        try {
          const testStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          testStream.getTracks().forEach((track) => track.stop());
          console.log('Microphone access test successful');
          setError(null);
        } catch (permissionError) {
          console.error('Microphone permission error:', permissionError);
          if (permissionError instanceof Error) {
            if (permissionError.name === 'NotAllowedError') {
              setError('Microphone access denied. Please allow microphone access and try again.');
            } else if (permissionError.name === 'NotFoundError') {
              setError('No microphone found. Please connect a microphone and try again.');
            } else {
              setError(`Microphone error: ${permissionError.message}`);
            }
          } else {
            setError('Failed to access microphone. Please check your browser settings.');
          }
        }
      } catch (error) {
        console.error('Browser compatibility check error:', error);
        setError('Failed to check browser compatibility. Please refresh the page and try again.');
      }
    };

    // Delay the check slightly to ensure the component is fully mounted
    const timeoutId = setTimeout(checkBrowserCompatibility, 100);

    return () => clearTimeout(timeoutId);
  }, []);

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {error && (
        <div className="text-sm text-destructive mr-2">
          {error}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setError(null);
              // Retry the browser compatibility check
              setTimeout(() => {
                const checkBrowserCompatibility = async () => {
                  try {
                    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
                      const testStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                      testStream.getTracks().forEach((track) => track.stop());
                      setError(null);
                    }
                  } catch (error) {
                    console.error('Retry failed:', error);
                  }
                };

                checkBrowserCompatibility();
              }, 100);
            }}
            className="ml-2 text-xs"
          >
            Retry
          </Button>
        </div>
      )}
      <Button
        type="button"
        variant={isRecording ? 'destructive' : 'outline'}
        size="sm"
        onClick={toggleRecording}
        disabled={disabled || isProcessing || !!error}
        className="gap-2"
      >
        {isProcessing ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : isRecording ? (
          <MicOff className="h-4 w-4" />
        ) : (
          <Mic className="h-4 w-4" />
        )}
        {isProcessing ? 'Processing...' : isRecording ? 'Stop' : 'Voice'}
      </Button>
    </div>
  );
};

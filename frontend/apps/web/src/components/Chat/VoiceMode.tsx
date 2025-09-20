import { useCallback, useEffect, useRef, useState } from 'react';

import { Button, cn } from '@ci/shadcn';
import { Mic, MicOff, Volume2, X } from '@ci/shadcn/icons';

import { useSpeechService } from '@/api';
import { cleanTextForTTS } from '@/lib/text-utils';

import { AudioWaveform } from './AudioWaveform';

interface VoiceModeProps {
  isActive: boolean;
  onToggle: () => void;
  onSubmitMessage?: (message: string) => void;
  companionResponse?: string;
  className?: string;
}

export function VoiceMode({
  isActive,
  onToggle,
  onSubmitMessage,
  companionResponse,
  className,
}: VoiceModeProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [userStream, setUserStream] = useState<MediaStream | null>(null);
  const [companionStream, setCompanionStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const userStreamRef = useRef<MediaStream | null>(null);
  const companionAudioContextRef = useRef<AudioContext | null>(null);
  const companionAnalyserRef = useRef<AnalyserNode | null>(null);
  const companionStreamRef = useRef<MediaStream | null>(null);

  const { state: speechState, transcribeAudio, synthesizeSpeech } = useSpeechService();

  // Set up companion audio stream for waveform visualization
  const setupCompanionAudioStream = useCallback((audioElement: HTMLAudioElement) => {
    try {
      // Create audio context and analyser
      const audioContext = new (window.AudioContext ||
        (window as typeof window & { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      const analyser = audioContext.createAnalyser();

      // Create a media element source from the audio element
      const source = audioContext.createMediaElementSource(audioElement);

      // Connect the source to the analyser and then to the destination
      source.connect(analyser);
      analyser.connect(audioContext.destination);

      // Configure analyser
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;

      // Create a MediaStream from the analyser
      const stream = audioContext.createMediaStreamDestination();
      source.connect(stream);

      // Store references
      companionAudioContextRef.current = audioContext;
      companionAnalyserRef.current = analyser;
      companionStreamRef.current = stream.stream;
      setCompanionStream(stream.stream);

      console.log('🎤 Companion audio stream set up for waveform');
    } catch (err) {
      console.error('Error setting up companion audio stream:', err);
    }
  }, []);

  // Initialize microphone access
  const initializeMicrophone = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      userStreamRef.current = stream;
      setUserStream(stream);
      setError(null);
    } catch (err) {
      console.error('Error accessing microphone:', err);
      setError('Could not access microphone. Please check permissions.');
    }
  }, []);

  // Cleanup streams
  const cleanupStreams = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }

    if (userStreamRef.current) {
      userStreamRef.current.getTracks().forEach((track) => track.stop());
      userStreamRef.current = null;
      setUserStream(null);
    }

    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
    }

    if (companionAudioContextRef.current) {
      companionAudioContextRef.current.close();
      companionAudioContextRef.current = null;
    }

    companionStreamRef.current = null;
    setCompanionStream(null);

    setIsRecording(false);
    setIsPlaying(false);
    audioChunksRef.current = [];
  }, []);

  // Start recording
  const startRecording = useCallback(async () => {
    if (!userStreamRef.current) {
      return;
    }

    try {
      const mediaRecorder = new MediaRecorder(userStreamRef.current, {
        mimeType: 'audio/webm;codecs=opus',
      });
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        if (audioChunksRef.current.length > 0) {
          const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm;codecs=opus' });
          try {
            const transcription = await transcribeAudio(audioBlob);
            if (transcription && transcription.trim()) {
              onSubmitMessage?.(transcription.trim());
            }
          } catch (err) {
            console.error('Error transcribing audio:', err);
            setError('Failed to transcribe audio');
          }
        }

        audioChunksRef.current = [];
      };

      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      console.error('Error starting recording:', err);
      setError('Failed to start recording');
    }
  }, [transcribeAudio, onSubmitMessage]);

  // Stop recording
  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  }, []);

  // Initialize microphone when voice mode becomes active (but don't start recording)
  useEffect(() => {
    if (isActive) {
      initializeMicrophone();
    } else {
      cleanupStreams();
    }

    return () => {
      cleanupStreams();
    };
  }, [isActive, initializeMicrophone, cleanupStreams]);

  // Toggle recording
  const toggleRecording = useCallback(() => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }, [isRecording, startRecording, stopRecording]);

  // TTS and audio playback
  const playCompanionResponse = useCallback(
    async (text: string) => {
      if (!text.trim()) {
        return;
      }

      // Clean the text before sending to TTS
      const cleanedText = cleanTextForTTS(text);

      console.log('🎤 Starting TTS for text:', cleanedText.substring(0, 100) + '...');
      setIsPlaying(true);

      try {
        const audioBlob = await synthesizeSpeech(cleanedText);
        console.log('🎤 TTS completed, blob size:', audioBlob.size, 'type:', audioBlob.type);

        const audioUrl = URL.createObjectURL(audioBlob);
        const audio = new Audio(audioUrl);

        // Set up audio stream for waveform visualization
        setupCompanionAudioStream(audio);

        audio.onended = () => {
          console.log('🎤 Audio playback ended');
          URL.revokeObjectURL(audioUrl);
          setIsPlaying(false);
          // Clean up companion stream when audio ends
          if (companionAudioContextRef.current) {
            companionAudioContextRef.current.close();
            companionAudioContextRef.current = null;
          }

          companionStreamRef.current = null;
          setCompanionStream(null);
        };

        audio.onerror = (e) => {
          console.error('🎤 Audio playback error:', e);
          URL.revokeObjectURL(audioUrl);
          setIsPlaying(false);
          setError('Failed to play audio - check browser console for details');
          // Clean up on error
          if (companionAudioContextRef.current) {
            companionAudioContextRef.current.close();
            companionAudioContextRef.current = null;
          }

          companionStreamRef.current = null;
          setCompanionStream(null);
        };

        audio.onloadstart = () => console.log('🎤 Audio loading started');
        audio.oncanplay = () => console.log('🎤 Audio can play');
        audio.oncanplaythrough = () => console.log('🎤 Audio can play through');

        currentAudioRef.current = audio;
        console.log('🎤 Starting audio playback...');
        await audio.play();
        console.log('🎤 Audio playback started successfully');
      } catch (err) {
        console.error('🎤 Error in TTS/playback:', err);
        setError(`Failed to play audio: ${err instanceof Error ? err.message : 'Unknown error'}`);
        setIsPlaying(false);
      }
    },
    [synthesizeSpeech, setupCompanionAudioStream],
  );

  // Auto-play companion responses when they become available
  useEffect(() => {
    if (companionResponse && companionResponse.trim()) {
      playCompanionResponse(companionResponse);
    }
  }, [companionResponse, playCompanionResponse]);

  if (!isActive) {
    return null;
  }

  return (
    <div className={cn('w-full p-3 bg-muted/30 border rounded-lg mb-3', className)}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-blue-500" />
          <span className="text-xs font-medium">Voice Mode</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            {isRecording ? (
              <>
                <div className="w-1.5 h-1.5 bg-red-500 rounded-full animate-pulse" />
                Recording
              </>
            ) : isPlaying ? (
              <>
                <Volume2 className="w-3 h-3" />
                Speaking
              </>
            ) : userStream ? (
              <>
                <div className="w-1.5 h-1.5 bg-green-500 rounded-full" />
                Ready
              </>
            ) : (
              <>
                <div className="w-1.5 h-1.5 bg-yellow-500 rounded-full" />
                Initializing
              </>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={onToggle} className="h-6 w-6 p-0">
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {(error || speechState.error) && (
        <div className="mb-3 p-2 bg-destructive/10 border border-destructive/20 rounded text-xs">
          <p className="text-destructive">{error || speechState.error}</p>
        </div>
      )}

      <div className="flex items-center gap-3">
        {/* User Audio Waveform */}
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />
            <span className="text-xs text-muted-foreground">You</span>
          </div>
          <AudioWaveform
            audioStream={userStream || undefined}
            isActive={isRecording}
            color="user"
            className="w-full h-12"
          />
        </div>

        {/* Companion Audio Waveform */}
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            <span className="text-xs text-muted-foreground">Companion</span>
          </div>
          <AudioWaveform
            audioStream={companionStream || undefined}
            isActive={isPlaying}
            color="companion"
            className="w-full h-12"
          />
        </div>

        {/* Record/Stop Button */}
        <div className="flex flex-col items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            onClick={toggleRecording}
            disabled={!userStream || speechState.loading}
            className={`h-8 w-8 rounded-full p-0 ${
              isRecording
                ? 'bg-red-500 hover:bg-red-600 text-white border-red-500 hover:border-red-600'
                : 'bg-blue-500 hover:bg-blue-600 text-white border-blue-500 hover:border-blue-600'
            }`}
          >
            {isRecording ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          </Button>
          <span className="text-xs text-muted-foreground">{isRecording ? 'Stop' : 'Record'}</span>
        </div>
      </div>
    </div>
  );
}

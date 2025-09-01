import { useCallback, useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { AudioStreamState, AudioStreamEvents, AudioChunkingOptions, TranscriptSegment } from '../types';
import { useAudioChunking } from './useAudioChunking';

interface UseTranscriptStreamProps {
  serverUrl?: string;
  streamId?: string;
  chunkingOptions?: AudioChunkingOptions;
  autoStart?: boolean;
}

const DEFAULT_SERVER_URL = 'ws://localhost:3030';

export function useTranscriptStream({ 
  serverUrl = DEFAULT_SERVER_URL, 
  streamId: initialStreamId,
  chunkingOptions,
  autoStart = false 
}: UseTranscriptStreamProps = {}) {
  const [state, setState] = useState<AudioStreamState>({
    isRecording: false,
    isConnected: false,
    streamId: null,
    error: null,
    transcriptSegments: [],
    currentInterimText: '',
  });

  const socketRef = useRef<Socket | null>(null);
  const streamIdRef = useRef<string | null>(initialStreamId || null);

  // Audio chunking hook
  const { 
    isRecording, 
    startRecording: startAudioRecording, 
    stopRecording: stopAudioRecording,
    error: audioError 
  } = useAudioChunking({
    options: chunkingOptions,
    onChunk: useCallback((chunk: ArrayBuffer) => {
      // Send audio chunk to server
      if (socketRef.current && streamIdRef.current) {
        socketRef.current.emit('audioData', {
          streamId: streamIdRef.current,
          audioData: chunk,
        });
      }
    }, []),
  });

  // Connect to WebSocket server
  const connect = useCallback(() => {
    if (socketRef.current?.connected) {
      return;
    }

    const socket = io(`${serverUrl}/audio-stream`, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setState(prev => ({ ...prev, isConnected: true, error: null }));
    });

    socket.on('disconnect', () => {
      setState(prev => ({ ...prev, isConnected: false }));
    });

    socket.on('streamStarted', ({ streamId, success }: AudioStreamEvents['streamStarted']) => {
      if (success) {
        streamIdRef.current = streamId;
        setState(prev => ({ ...prev, streamId, error: null }));
      }
    });

    socket.on('streamStopped', ({ streamId, success }: AudioStreamEvents['streamStopped']) => {
      if (success && streamId === streamIdRef.current) {
        streamIdRef.current = null;
        setState(prev => ({ 
          ...prev, 
          streamId: null, 
          currentInterimText: '',
          error: null 
        }));
      }
    });

    socket.on('streamError', ({ streamId, error, details }: AudioStreamEvents['streamError']) => {
      if (streamId === streamIdRef.current) {
        setState(prev => ({ 
          ...prev, 
          error: details ? `${error}: ${details}` : error 
        }));
      }
    });

    socket.on('transcriptSegment', ({ streamId, segment }: AudioStreamEvents['transcriptSegment']) => {
      if (streamId === streamIdRef.current) {
        setState(prev => ({
          ...prev,
          transcriptSegments: [...prev.transcriptSegments, segment],
          currentInterimText: '', // Clear interim text when we get a final segment
        }));
      }
    });

    socket.on('interimTranscript', ({ streamId, text }: AudioStreamEvents['interimTranscript']) => {
      if (streamId === streamIdRef.current) {
        setState(prev => ({
          ...prev,
          currentInterimText: text,
        }));
      }
    });

    socket.on('audioChunk', ({ streamId, chunkId, timestamp, duration, size }) => {
      // Optional: Handle audio chunk events for monitoring
      console.debug('Audio chunk processed:', { streamId, chunkId, timestamp, duration, size });
    });

  }, [serverUrl]);

  // Disconnect from WebSocket server
  const disconnect = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    setState(prev => ({ 
      ...prev, 
      isConnected: false, 
      streamId: null, 
      error: null 
    }));
    streamIdRef.current = null;
  }, []);

  // Start streaming
  const startStream = useCallback(async () => {
    if (!socketRef.current?.connected) {
      setState(prev => ({ ...prev, error: 'Not connected to server' }));
      return;
    }

    const newStreamId = initialStreamId || `stream-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    // Start WebSocket stream
    socketRef.current.emit('startStream', {
      streamId: newStreamId,
      options: chunkingOptions,
    });

    // Start audio recording
    await startAudioRecording();

    setState(prev => ({ ...prev, isRecording: true }));
  }, [initialStreamId, chunkingOptions, startAudioRecording]);

  // Stop streaming
  const stopStream = useCallback(() => {
    // Stop audio recording
    stopAudioRecording();

    // Stop WebSocket stream
    if (socketRef.current && streamIdRef.current) {
      socketRef.current.emit('stopStream', {
        streamId: streamIdRef.current,
      });
    }

    setState(prev => ({ ...prev, isRecording: false }));
  }, [stopAudioRecording]);

  // Toggle streaming
  const toggleStream = useCallback(async () => {
    if (state.isRecording) {
      stopStream();
    } else {
      await startStream();
    }
  }, [state.isRecording, startStream, stopStream]);

  // Get full transcript
  const getFullTranscript = useCallback(() => {
    const finalText = state.transcriptSegments
      .filter(s => s.isFinal)
      .map(s => s.text)
      .join(' ');
    
    return state.currentInterimText 
      ? `${finalText} ${state.currentInterimText}`.trim()
      : finalText;
  }, [state.transcriptSegments, state.currentInterimText]);

  // Get stream statistics
  const getStreamStats = useCallback(() => {
    if (socketRef.current && streamIdRef.current) {
      socketRef.current.emit('getStreamStats', {
        streamId: streamIdRef.current,
      });
    }
  }, []);

  // Auto-connect on mount
  useEffect(() => {
    connect();
    
    return () => {
      disconnect();
    };
  }, [connect, disconnect]);

  // Auto-start if specified
  useEffect(() => {
    if (autoStart && state.isConnected && !state.isRecording) {
      startStream();
    }
  }, [autoStart, state.isConnected, state.isRecording, startStream]);

  // Update state with audio errors
  useEffect(() => {
    if (audioError) {
      setState(prev => ({ ...prev, error: audioError }));
    }
  }, [audioError]);

  // Update recording state
  useEffect(() => {
    setState(prev => ({ ...prev, isRecording }));
  }, [isRecording]);

  return {
    ...state,
    connect,
    disconnect,
    startStream,
    stopStream,
    toggleStream,
    getFullTranscript,
    getStreamStats,
    isAudioRecording: isRecording,
  };
}
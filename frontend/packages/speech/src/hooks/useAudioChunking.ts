import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioChunkingOptions, AudioStreamState } from '../types';

interface UseAudioChunkingProps {
  onChunk?: (chunk: ArrayBuffer) => void;
  options?: AudioChunkingOptions;
}

const DEFAULT_OPTIONS: Required<AudioChunkingOptions> = {
  chunkDurationMs: 2000, // 2 seconds
  overlapMs: 200, // 200ms overlap
  minChunkSize: 8192, // 8KB minimum
  maxChunkSize: 65536, // 64KB maximum
  sampleRate: 16000, // 16kHz
  channels: 1, // Mono
};

export function useAudioChunking({ onChunk, options }: UseAudioChunkingProps = {}) {
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunksBufferRef = useRef<Blob[]>([]);
  const chunkIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  
  const mergedOptions = { ...DEFAULT_OPTIONS, ...options };

  const startRecording = useCallback(async () => {
    try {
      setError(null);
      
      // Get user media
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: mergedOptions.sampleRate,
          channelCount: mergedOptions.channels,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      
      mediaStreamRef.current = stream;
      
      // Create AudioContext for real-time processing
      const audioContext = new AudioContext({
        sampleRate: mergedOptions.sampleRate,
      });
      audioContextRef.current = audioContext;
      
      // Create audio source from stream
      const sourceNode = audioContext.createMediaStreamSource(stream);
      sourceNodeRef.current = sourceNode;
      
      // Create script processor for chunking
      const processorNode = audioContext.createScriptProcessor(4096, mergedOptions.channels, mergedOptions.channels);
      processorNodeRef.current = processorNode;
      
      let audioBuffer: Float32Array[] = [];
      const targetSamples = Math.floor((mergedOptions.chunkDurationMs / 1000) * mergedOptions.sampleRate);
      const overlapSamples = Math.floor((mergedOptions.overlapMs / 1000) * mergedOptions.sampleRate);
      
      processorNode.onaudioprocess = (event) => {
        const inputBuffer = event.inputBuffer;
        
        // Extract audio data from all channels
        for (let channel = 0; channel < inputBuffer.numberOfChannels; channel++) {
          const channelData = inputBuffer.getChannelData(channel);
          if (!audioBuffer[channel]) {
            audioBuffer[channel] = new Float32Array(0);
          }
          
          // Append new data to buffer
          const newBuffer = new Float32Array(audioBuffer[channel].length + channelData.length);
          newBuffer.set(audioBuffer[channel]);
          newBuffer.set(channelData, audioBuffer[channel].length);
          audioBuffer[channel] = newBuffer;
        }
        
        // Process chunks when we have enough data
        if (audioBuffer[0] && audioBuffer[0].length >= targetSamples) {
          const chunkData = audioBuffer.map(channelBuffer => 
            channelBuffer.slice(0, targetSamples)
          );
          
          // Convert to interleaved PCM16 ArrayBuffer
          const pcmBuffer = convertToPCM16(chunkData, mergedOptions.channels);
          
          // Send chunk
          if (onChunk) {
            onChunk(pcmBuffer);
          }
          
          // Remove processed data, keeping overlap
          const removeCount = Math.max(targetSamples - overlapSamples, targetSamples / 2);
          audioBuffer = audioBuffer.map(channelBuffer => 
            channelBuffer.slice(removeCount)
          );
        }
      };
      
      // Connect nodes
      sourceNode.connect(processorNode);
      processorNode.connect(audioContext.destination);
      
      setIsRecording(true);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to start audio recording';
      setError(errorMessage);
      console.error('Error starting audio recording:', err);
    }
  }, [onChunk, mergedOptions]);

  const stopRecording = useCallback(() => {
    try {
      // Stop and clean up audio context
      if (processorNodeRef.current) {
        processorNodeRef.current.disconnect();
        processorNodeRef.current = null;
      }
      
      if (sourceNodeRef.current) {
        sourceNodeRef.current.disconnect();
        sourceNodeRef.current = null;
      }
      
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
      
      // Stop media stream
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach(track => track.stop());
        mediaStreamRef.current = null;
      }
      
      // Clean up interval
      if (chunkIntervalRef.current) {
        clearInterval(chunkIntervalRef.current);
        chunkIntervalRef.current = null;
      }
      
      setIsRecording(false);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to stop audio recording';
      setError(errorMessage);
      console.error('Error stopping audio recording:', err);
    }
  }, []);

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
      stopRecording();
    };
  }, [stopRecording]);

  return {
    isRecording,
    error,
    startRecording,
    stopRecording,
    toggleRecording,
    options: mergedOptions,
  };
}

/**
 * Converts Float32Array audio data to PCM16 ArrayBuffer
 */
function convertToPCM16(channelData: Float32Array[], channels: number): ArrayBuffer {
  const totalSamples = channelData[0].length;
  const buffer = new ArrayBuffer(totalSamples * channels * 2); // 2 bytes per sample (16-bit)
  const view = new DataView(buffer);
  
  let offset = 0;
  for (let i = 0; i < totalSamples; i++) {
    for (let channel = 0; channel < channels; channel++) {
      // Convert float32 [-1, 1] to int16 [-32768, 32767]
      const sample = Math.max(-1, Math.min(1, channelData[channel][i]));
      const pcmSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      view.setInt16(offset, pcmSample, true); // Little-endian
      offset += 2;
    }
  }
  
  return buffer;
}
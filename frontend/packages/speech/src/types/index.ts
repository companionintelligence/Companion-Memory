export interface AudioChunkingOptions {
  chunkDurationMs?: number;
  overlapMs?: number;
  minChunkSize?: number;
  maxChunkSize?: number;
  sampleRate?: number;
  channels?: number;
}

export interface AudioChunk {
  id: string;
  data: ArrayBuffer;
  timestamp: number;
  duration: number;
  sampleRate: number;
  channels: number;
  format: string;
}

export interface TranscriptSegment {
  id: string;
  text: string;
  confidence: number;
  startTime: number;
  endTime: number;
  isFinal: boolean;
  audioChunkId: string;
}

export interface AudioStreamState {
  isRecording: boolean;
  isConnected: boolean;
  streamId: string | null;
  error: string | null;
  transcriptSegments: TranscriptSegment[];
  currentInterimText: string;
}

export interface AudioStreamEvents {
  streamStarted: { streamId: string; success: boolean };
  streamStopped: { streamId: string; success: boolean };
  streamError: { streamId: string; error: string; details?: string };
  audioChunk: { streamId: string; chunkId: string; timestamp: number; duration: number; size: number };
  transcriptSegment: { streamId: string; segment: TranscriptSegment };
  interimTranscript: { streamId: string; text: string };
  streamStats: {
    streamId: string;
    audio: any;
    transcript: any;
    exists: boolean;
  };
}
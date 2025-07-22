export interface AudioChunk {
  data: Buffer;
  timestamp: number;
  sampleRate: number;
  channels: number;
}

export interface TranscriptionResult {
  text: string;
  confidence: number;
  timestamp: number;
  isFinal: boolean;
}

export interface TTSRequest {
  text: string;
  voice?: string;
  speed?: number;
  pitch?: number;
}

export interface TTSResponse {
  audioData: Buffer;
  duration: number;
  format: string;
}

export interface VoiceStreamRequest {
  conversationId: string;
  userId: string;
}

export interface VoiceStreamResponse {
  type: 'transcription' | 'tts' | 'error';
  data: TranscriptionResult | TTSResponse | string;
  timestamp: number;
} 
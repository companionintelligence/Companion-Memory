import { Injectable, Logger } from '@nestjs/common';
import { WhisperXService } from './whisperx.service';
import { SesameAIService } from './sesameai.service';
import { VoiceApiService } from './voice-api.service';
import { 
  AudioChunk, 
  TranscriptionResult, 
  TTSRequest, 
  TTSResponse,
  VoiceStreamResponse 
} from '../types';

@Injectable()
export class VoiceService {
  private readonly logger = new Logger(VoiceService.name);
  private activeStreams = new Map<string, {
    audioChunks: AudioChunk[];
    startTime: number;
    isActive: boolean;
  }>();

  constructor(
    private readonly whisperXService: WhisperXService,
    private readonly sesameAIService: SesameAIService,
    private readonly voiceApiService: VoiceApiService,
  ) {}

  /**
   * Start a new voice stream session
   */
  async startVoiceStream(sessionId: string): Promise<void> {
    this.logger.log(`Starting voice stream session: ${sessionId}`);
    
    // Check if session already exists and reactivate it
    const existingSession = this.activeStreams.get(sessionId);
    if (existingSession) {
      this.logger.debug(`Reactivating existing session: ${sessionId}`);
      existingSession.isActive = true;
      existingSession.startTime = Date.now();
      existingSession.audioChunks = [];
    } else {
      this.activeStreams.set(sessionId, {
        audioChunks: [],
        startTime: Date.now(),
        isActive: true,
      });
      this.logger.debug(`Session ${sessionId} created. Total active sessions: ${this.activeStreams.size}`);
    }
    
    // Log all active sessions for debugging
    this.logger.debug(`Active sessions after creation: ${Array.from(this.activeStreams.keys()).join(', ')}`);
  }

  /**
   * Process incoming audio chunk and return real-time transcription
   */
  async processAudioChunk(
    sessionId: string, 
    audioChunk: AudioChunk
  ): Promise<VoiceStreamResponse> {
    try {
      const stream = this.activeStreams.get(sessionId);
      this.logger.debug(`Processing audio chunk for session ${sessionId}: stream exists=${!!stream}, isActive=${stream?.isActive}`);
      
      if (!stream || !stream.isActive) {
        this.logger.error(`Session ${sessionId} not found or inactive. Active sessions: ${Array.from(this.activeStreams.keys()).join(', ')}`);
        throw new Error(`Voice stream session ${sessionId} not found or inactive`);
      }

      // Update session activity time to keep it alive
      stream.startTime = Date.now();
      this.logger.debug(`Updated session ${sessionId} activity time`);

      // Validate audio format
      if (!this.whisperXService.validateAudioFormat(audioChunk.sampleRate, audioChunk.channels)) {
        throw new Error('Invalid audio format. Expected 16kHz mono PCM.');
      }

      // Store audio chunk
      stream.audioChunks.push(audioChunk);

      // Process with WhisperX for real-time transcription
      const transcription = await this.whisperXService.transcribeAudio(audioChunk);

      return {
        type: 'transcription',
        data: transcription,
        timestamp: Date.now(),
      };
    } catch (error) {
      this.logger.error(`Error processing audio chunk for session ${sessionId}:`, error);
      
      return {
        type: 'error',
        data: error instanceof Error ? error.message : 'Unknown error',
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Stop voice stream and get final transcription
   */
  async stopVoiceStream(sessionId: string): Promise<VoiceStreamResponse> {
    try {
      const stream = this.activeStreams.get(sessionId);
      if (!stream) {
        throw new Error(`Voice stream session ${sessionId} not found`);
      }

      stream.isActive = false;
      this.logger.log(`Stopping voice stream session: ${sessionId}`);

      // Get final transcription from all audio chunks
      const finalTranscription = await this.whisperXService.transcribeStream(stream.audioChunks);

      // Clean up session
      this.activeStreams.delete(sessionId);

      return {
        type: 'transcription',
        data: finalTranscription,
        timestamp: Date.now(),
      };
    } catch (error) {
      this.logger.error(`Error stopping voice stream session ${sessionId}:`, error);
      
      return {
        type: 'error',
        data: error instanceof Error ? error.message : 'Unknown error',
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Convert text to speech and return audio response
   */
  async textToSpeech(request: TTSRequest): Promise<VoiceStreamResponse> {
    try {
      // Validate TTS request
      if (!this.sesameAIService.validateRequest(request)) {
        throw new Error('Invalid TTS request parameters');
      }

      const ttsResponse = await this.sesameAIService.textToSpeech(request);

      return {
        type: 'tts',
        data: ttsResponse,
        timestamp: Date.now(),
      };
    } catch (error) {
      this.logger.error('Error in text-to-speech conversion:', error);
      
      return {
        type: 'error',
        data: error instanceof Error ? error.message : 'Unknown error',
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Stream text-to-speech conversion
   */
  async streamTextToSpeech(request: TTSRequest): Promise<AsyncGenerator<VoiceStreamResponse>> {
    try {
      // Validate TTS request
      if (!this.sesameAIService.validateRequest(request)) {
        throw new Error('Invalid TTS request parameters');
      }

      const ttsStream = await this.sesameAIService.streamTextToSpeech(request);

      return this.convertTTSStreamToVoiceResponse(ttsStream);
    } catch (error) {
      this.logger.error('Error in streaming text-to-speech conversion:', error);
      throw error;
    }
  }

  /**
   * Get available voices for TTS
   */
  async getAvailableVoices(): Promise<string[]> {
    return this.sesameAIService.getAvailableVoices();
  }

  /**
   * Get active voice stream sessions
   */
  getActiveSessions(): string[] {
    return Array.from(this.activeStreams.keys());
  }

  /**
   * Get session status
   */
  getSessionStatus(sessionId: string): { exists: boolean; isActive: boolean; startTime: number } | null {
    const stream = this.activeStreams.get(sessionId);
    if (!stream) {
      return null;
    }
    
    return {
      exists: true,
      isActive: stream.isActive,
      startTime: stream.startTime,
    };
  }

  /**
   * Clean up inactive sessions
   */
  cleanupInactiveSessions(): void {
    const now = Date.now();
    const maxSessionDuration = 5 * 60 * 1000; // 5 minutes

    for (const [sessionId, stream] of this.activeStreams.entries()) {
      if (now - stream.startTime > maxSessionDuration) {
        this.logger.warn(`Cleaning up inactive session: ${sessionId}`);
        this.activeStreams.delete(sessionId);
      }
    }
  }

  /**
   * Get service configuration status
   */
  getServiceConfiguration(): { whisperX: boolean; sesameAI: boolean } {
    return this.voiceApiService.validateConfiguration();
  }

  /**
   * Convert TTS stream to voice response format
   */
  private async *convertTTSStreamToVoiceResponse(
    ttsStream: AsyncGenerator<TTSResponse>
  ): AsyncGenerator<VoiceStreamResponse> {
    for await (const ttsResponse of ttsStream) {
      yield {
        type: 'tts',
        data: ttsResponse,
        timestamp: Date.now(),
      };
    }
  }
} 
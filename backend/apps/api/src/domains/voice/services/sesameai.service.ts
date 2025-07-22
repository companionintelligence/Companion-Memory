import { Injectable, Logger } from '@nestjs/common';
import { TTSRequest, TTSResponse } from '../types';
import { VoiceApiService } from './voice-api.service';

@Injectable()
export class SesameAIService {
  private readonly logger = new Logger(SesameAIService.name);

  constructor(private readonly voiceApiService: VoiceApiService) {}

  /**
   * Convert text to speech using SesameAI/CSM
   * This is a placeholder implementation - in production, you would:
   * 1. Send text to SesameAI/CSM API
   * 2. Handle streaming audio responses
   * 3. Manage audio format and quality settings
   */
  async textToSpeech(request: TTSRequest): Promise<TTSResponse> {
    try {
      this.logger.debug(`Converting text to speech: "${request.text}"`);

      // Call SesameAI/CSM API through VoiceApiService
      const audioData = await this.voiceApiService.callSesameAI(request);
      
      return {
        audioData,
        duration: 2.5, // seconds - could be calculated from audio data
        format: 'wav',
      };
    } catch (error) {
      this.logger.error('Error converting text to speech:', error);
      throw error;
    }
  }

  /**
   * Stream text-to-speech conversion for real-time responses
   */
  async streamTextToSpeech(request: TTSRequest): Promise<AsyncGenerator<TTSResponse>> {
    try {
      this.logger.debug(`Streaming text to speech: "${request.text}"`);

      // Call SesameAI/CSM streaming API through VoiceApiService
      const audioStream = await this.voiceApiService.streamSesameAI(request);
      
      return this.convertAudioStreamToTTSResponse(audioStream);
    } catch (error) {
      this.logger.error('Error streaming text to speech:', error);
      throw error;
    }
  }

  /**
   * Get available voices from SesameAI/CSM
   */
  async getAvailableVoices(): Promise<string[]> {
    return this.voiceApiService.getSesameAIVoices();
  }

  /**
   * Validate TTS request parameters
   */
  validateRequest(request: TTSRequest): boolean {
    return (
      request.text.length > 0 &&
      request.text.length <= 1000 &&
      (!request.speed || (request.speed >= 0.5 && request.speed <= 2.0)) &&
      (!request.pitch || (request.pitch >= -20 && request.pitch <= 20))
    );
  }

  /**
   * Convert audio stream to TTS response format
   */
  private async *convertAudioStreamToTTSResponse(
    audioStream: AsyncGenerator<Buffer>
  ): AsyncGenerator<TTSResponse> {
    for await (const audioData of audioStream) {
      yield {
        audioData,
        duration: 0.8, // Could be calculated from audio data
        format: 'wav',
      };
    }
  }
} 
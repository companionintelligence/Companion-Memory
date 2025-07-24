import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class VoiceApiService {
  private readonly logger = new Logger(VoiceApiService.name);
  private readonly whisperXApiUrl: string;
  private readonly sesameAIApiUrl: string;
  private readonly sesameAIApiKey: string;

  constructor(private readonly configService: ConfigService) {
    this.whisperXApiUrl = this.configService.get<string>('WHISPERX_API_URL', 'http://dev.companionintelligence.com:9002');
    this.sesameAIApiUrl = this.configService.get<string>('SESAMEAI_API_URL', 'https://api.sesameai.com');
    this.sesameAIApiKey = this.configService.get<string>('SESAMEAI_API_KEY', '');
  }

  /**
   * Call WhisperX API for speech-to-text transcription
   */
  async callWhisperX(audioData: Buffer, options?: {
    language?: string;
    task?: 'transcribe' | 'translate';
    timestamp?: boolean;
  }): Promise<any> {
    try {
      this.logger.debug('Calling WhisperX API');

      // Convert Buffer to base64
      const base64Audio = audioData.toString('base64');
      
      // Call WhisperX service
      const response = await fetch(`${this.whisperXApiUrl}/transcribe`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          audio_data: base64Audio,
          sample_rate: 16000,
          language: options?.language || 'en',
          model_size: 'base',
        }),
      });

      if (!response.ok) {
        throw new Error(`WhisperX API returned ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();
      
      return {
        text: result.text,
        segments: result.segments || [],
        language: result.language,
        confidence: result.confidence || 0.95,
      };
    } catch (error) {
      this.logger.error('WhisperX API call failed:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`WhisperX transcription failed: ${errorMessage}`);
    }
  }

  /**
   * Call SesameAI/CSM API for text-to-speech conversion
   */
  async callSesameAI(request: {
    text: string;
    voice?: string;
    speed?: number;
    pitch?: number;
  }): Promise<Buffer> {
    try {
      this.logger.debug('Calling SesameAI/CSM API');

      if (!this.sesameAIApiKey) {
        throw new Error('SesameAI API key not configured');
      }

      // TODO: Implement actual SesameAI/CSM API call
      // For now, return empty audio data
      return Buffer.alloc(0);
    } catch (error) {
      this.logger.error('SesameAI/CSM API call failed:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`SesameAI TTS failed: ${errorMessage}`);
    }
  }

  /**
   * Stream SesameAI/CSM API for real-time TTS
   */
  async streamSesameAI(request: {
    text: string;
    voice?: string;
    speed?: number;
    pitch?: number;
  }): Promise<AsyncGenerator<Buffer>> {
    try {
      this.logger.debug('Streaming SesameAI/CSM API');

      if (!this.sesameAIApiKey) {
        throw new Error('SesameAI API key not configured');
      }

      // TODO: Implement actual SesameAI/CSM streaming API call
      // For now, return empty audio stream
      return this.generateEmptyAudioStream();
    } catch (error) {
      this.logger.error('SesameAI/CSM streaming API call failed:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`SesameAI streaming TTS failed: ${errorMessage}`);
    }
  }

  /**
   * Get available voices from SesameAI/CSM
   */
  async getSesameAIVoices(): Promise<string[]> {
    try {
      this.logger.debug('Getting SesameAI/CSM voices');

      if (!this.sesameAIApiKey) {
        throw new Error('SesameAI API key not configured');
      }

      // TODO: Implement actual SesameAI/CSM voices API call
      // For now, return mock voices
      return [
        'alloy',
        'echo',
        'fable',
        'onyx',
        'nova',
        'shimmer',
      ];
    } catch (error) {
      this.logger.error('SesameAI/CSM voices API call failed:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to get voices: ${errorMessage}`);
    }
  }

  /**
   * Validate API configuration
   */
  validateConfiguration(): { whisperX: boolean; sesameAI: boolean } {
    return {
      whisperX: !!this.whisperXApiUrl,
      sesameAI: !!this.sesameAIApiKey,
    };
  }

  /**
   * Generate empty audio stream for TTS placeholder
   */
  private async *generateEmptyAudioStream(): AsyncGenerator<Buffer> {
    yield Buffer.alloc(0);
  }


} 
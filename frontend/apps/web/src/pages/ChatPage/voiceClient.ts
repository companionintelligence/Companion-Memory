// Frontend voice client for communicating with the voice service

export interface VoiceStreamRequest {
  sessionId?: string;
}

export interface AudioChunkRequest {
  audioData: string; // Base64 encoded audio
  sampleRate: number;
  channels: number;
  timestamp: number;
}

export interface TTSRequest {
  text: string;
  voice?: string;
  speed?: number;
  pitch?: number;
}

export interface VoiceStreamResponse {
  type: 'transcription' | 'tts' | 'error';
  data: any;
  timestamp: number;
}

export class VoiceClient {
  private apiBaseUrl = '/api/voice'; // Use nginx proxy to voice-service container

  /**
   * Start a new voice stream session
   */
  async startVoiceStream(sessionId?: string): Promise<{ success: boolean; sessionId: string }> {
    try {
      const sessionIdToUse = sessionId || `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      // For direct voice service, we don't need to call a start endpoint
      // The session will be created when we send the first audio chunk
      return {
        success: true,
        sessionId: sessionIdToUse,
      };
    } catch (error) {
      console.error('Failed to start voice stream:', error);
      throw error;
    }
  }

  /**
   * Process audio chunk and get real-time transcription (streaming)
   */
  async processAudioChunkStream(
    sessionId: string,
    audioChunk: AudioChunkRequest
  ): Promise<VoiceStreamResponse> {
    try {
      console.log(`Sending audio chunk to voice service: ${this.apiBaseUrl}/transcribe-stream`);
      console.log(`Session ID: ${sessionId}, Audio size: ${audioChunk.audioData.length} chars`);
      
      const response = await fetch(`${this.apiBaseUrl}/transcribe-stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          audio_data: audioChunk.audioData,
          sample_rate: audioChunk.sampleRate,
          channels: audioChunk.channels,
          language: 'en',
          model_size: 'base',
          enable_diarization: false,
          sessionId: sessionId,
        }),
      });

      console.log(`Voice service response status: ${response.status}`);
      
      if (response.ok) {
        const result = await response.json();
        console.log('Voice service response:', result);
        return result;
      } else {
        const errorText = await response.text();
        console.error(`Voice service error response: ${response.status} - ${errorText}`);
        throw new Error(`Voice service error: ${response.status} - ${errorText}`);
      }
    } catch (error) {
      console.error('Voice service streaming transcription failed:', error);
      return {
        type: 'error',
        data: {
          message: error instanceof Error ? error.message : 'Streaming transcription failed',
        },
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Get final transcription for streaming session
   */
  async getFinalTranscription(sessionId: string): Promise<VoiceStreamResponse> {
    try {
      const response = await fetch(`${this.apiBaseUrl}/transcribe-stream-final`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          audio_data: '', // Not needed for final transcription
          sample_rate: 16000,
          language: 'en',
          model_size: 'base',
          enable_diarization: true,
          sessionId: sessionId,
        }),
      });

      if (response.ok) {
        const result = await response.json();
        return result;
      } else {
        throw new Error(`Voice service error: ${response.statusText}`);
      }
    } catch (error) {
      console.error('Voice service final transcription failed:', error);
      return {
        type: 'error',
        data: {
          message: error instanceof Error ? error.message : 'Final transcription failed',
        },
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Convert text to speech using local TTS
   */
  async textToSpeech(text: string, voice: string = "alloy", speed: number = 1.0, pitch: number = 1.0): Promise<{ audioData: string; duration: number; sampleRate: number }> {
    try {
      console.log(`Converting text to speech: "${text.substring(0, 50)}..."`);
      
      const response = await fetch(`${this.apiBaseUrl}/tts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          voice,
          speed,
          pitch,
        }),
      });

      console.log(`TTS response status: ${response.status}`);

      if (response.ok) {
        const result = await response.json();
        console.log('TTS response received');
        return {
          audioData: result.audio_data,
          duration: result.duration,
          sampleRate: result.sample_rate,
        };
      } else {
        const errorText = await response.text();
        console.error(`TTS error response: ${response.status} - ${errorText}`);
        throw new Error(`TTS error: ${response.status} - ${errorText}`);
      }
    } catch (error) {
      console.error('Text-to-speech failed:', error);
      throw error;
    }
  }

  /**
   * Check voice service health
   */
  async healthCheck(): Promise<{ status: string; whisperx: boolean; localTTS: boolean }> {
    try {
      console.log(`Checking voice service health at: ${this.apiBaseUrl}/health`);
      
      const response = await fetch(`${this.apiBaseUrl}/health`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      console.log(`Health check response status: ${response.status}`);

      if (response.ok) {
        const health = await response.json();
        console.log('Health check response:', health);
        return {
          status: health.status || 'healthy',
          whisperx: health.whisperx || health.model_loaded || false,
          localTTS: health.sesameai || false
        };
      } else {
        const errorText = await response.text();
        console.error(`Health check failed with status ${response.status}: ${errorText}`);
        throw new Error(`Health check failed: ${response.status} - ${errorText}`);
      }
    } catch (error) {
      console.error('Voice service health check failed:', error);
    }

    return {
      status: 'offline',
      whisperx: false,
      localTTS: false
    };
  }
}

// Export singleton instance
export const voiceClient = new VoiceClient(); 
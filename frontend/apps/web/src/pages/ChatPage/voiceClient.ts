// Frontend voice client for communicating with the backend voice API

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
  private baseUrl = 'https://dev.companionintelligence.com/api/voice'; // Point to nginx reverse proxy

  /**
   * Start a new voice stream session
   */
  async startVoiceStream(sessionId?: string): Promise<{ success: boolean; sessionId: string }> {
    const sessionIdToUse = sessionId || `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const response = await fetch(`${this.baseUrl}/stream/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sessionId: sessionIdToUse }),
    });

    if (!response.ok) {
      throw new Error(`Failed to start voice stream: ${response.statusText}`);
    }

    const result = await response.json();
    return { success: result.success, sessionId: result.sessionId };
  }

  /**
   * Process audio chunk and get real-time transcription
   */
  async processAudioChunk(
    sessionId: string,
    audioChunk: AudioChunkRequest
  ): Promise<VoiceStreamResponse> {
    const response = await fetch(`${this.baseUrl}/stream/audio/${sessionId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        audioData: audioChunk.audioData,
        sampleRate: audioChunk.sampleRate,
        channels: audioChunk.channels,
        timestamp: audioChunk.timestamp,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to process audio chunk: ${response.statusText}`);
    }

    const result = await response.json();
    return result;
  }

  /**
   * Stop voice stream and get final transcription
   */
  async stopVoiceStream(sessionId: string): Promise<VoiceStreamResponse> {
    const response = await fetch(`${this.baseUrl}/stream/stop/${sessionId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to stop voice stream: ${response.statusText}`);
    }

    const result = await response.json();
    return result;
  }

  /**
   * Convert text to speech
   */
  async textToSpeech(request: TTSRequest): Promise<VoiceStreamResponse> {
    const response = await fetch(`${this.baseUrl}/tts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`Failed to convert text to speech: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Stream text-to-speech conversion
   */
  async streamTextToSpeech(
    request: TTSRequest,
    onChunk: (response: VoiceStreamResponse) => void
  ): Promise<void> {
    const response = await fetch(`${this.baseUrl}/tts/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`Failed to stream text to speech: ${response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Failed to get response reader');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              onChunk(data);
            } catch (error) {
              console.error('Failed to parse SSE data:', error);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Get available voices for TTS
   */
  async getAvailableVoices(): Promise<string[]> {
    const response = await fetch(`${this.baseUrl}/voices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get available voices: ${response.statusText}`);
    }

    const result = await response.json();
    return result.voices || [];
  }

  /**
   * Get active voice sessions (for debugging)
   */
  async getActiveSessions(): Promise<string[]> {
    const response = await fetch(`${this.baseUrl}/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get active sessions: ${response.statusText}`);
    }

    const result = await response.json();
    return result.sessions || [];
  }

  /**
   * Check voice service health
   */
  async healthCheck(): Promise<{ status: string; whisperx: boolean; sesameai: boolean }> {
    const response = await fetch(`${this.baseUrl}/health`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Health check failed: ${response.statusText}`);
    }

    return response.json();
  }


}

// Export singleton instance
export const voiceClient = new VoiceClient(); 
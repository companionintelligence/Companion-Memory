import {
  Controller,
  Post,
  Body,
  Param,
  UseGuards,
  Req,
  Res,
  HttpStatus,
  HttpException,
} from '@nestjs/common';
import { Response } from 'express';
import { VoiceService } from '../services/voice.service';
import { TTSRequest, AudioChunk } from '../types';

@Controller('voice')
export class VoiceController {
  constructor(private readonly voiceService: VoiceService) {}

  /**
   * Start a new voice stream session
   */
  @Post('stream/start')
  async startVoiceStream(
    @Body() body: { sessionId: string },
    @Req() req: any,
  ): Promise<{ success: boolean; sessionId: string }> {
    try {
      const sessionId = body.sessionId || `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      await this.voiceService.startVoiceStream(sessionId);
      
      return {
        success: true,
        sessionId,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new HttpException(
        `Failed to start voice stream: ${errorMessage}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Process audio chunk and get real-time transcription
   */
  @Post('stream/audio/:sessionId')
  async processAudioChunk(
    @Param('sessionId') sessionId: string,
    @Body() body: {
      audioData: string; // Base64 encoded audio
      sampleRate: number;
      channels: number;
      timestamp: number;
    },
  ): Promise<any> {
    try {
      // Decode base64 audio data
      const audioBuffer = Buffer.from(body.audioData, 'base64');
      
      const audioChunk: AudioChunk = {
        data: audioBuffer,
        timestamp: body.timestamp || Date.now(),
        sampleRate: body.sampleRate || 16000,
        channels: body.channels || 1,
      };

      const response = await this.voiceService.processAudioChunk(sessionId, audioChunk);
      
      return response;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new HttpException(
        `Failed to process audio chunk: ${errorMessage}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Stop voice stream and get final transcription
   */
  @Post('stream/stop/:sessionId')
  async stopVoiceStream(
    @Param('sessionId') sessionId: string,
  ): Promise<any> {
    try {
      const response = await this.voiceService.stopVoiceStream(sessionId);
      
      return response;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new HttpException(
        `Failed to stop voice stream: ${errorMessage}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Convert text to speech
   */
  @Post('tts')
  async textToSpeech(
    @Body() request: TTSRequest,
  ): Promise<any> {
    try {
      const response = await this.voiceService.textToSpeech(request);
      
      return response;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new HttpException(
        `Failed to convert text to speech: ${errorMessage}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Stream text-to-speech conversion
   */
  @Post('tts/stream')
  async streamTextToSpeech(
    @Body() request: TTSRequest,
    @Res() res: Response,
  ): Promise<void> {
    try {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');

      const ttsStream = await this.voiceService.streamTextToSpeech(request);

      for await (const response of ttsStream) {
        res.write(`data: ${JSON.stringify(response)}\n\n`);
      }

      res.end();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        error: `Failed to stream text to speech: ${errorMessage}`,
      });
    }
  }

  /**
   * Get available voices for TTS
   */
  @Post('voices')
  async getAvailableVoices(): Promise<{ voices: string[] }> {
    try {
      const voices = await this.voiceService.getAvailableVoices();
      
      return { voices };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new HttpException(
        `Failed to get available voices: ${errorMessage}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get active voice sessions (for debugging)
   */
  @Post('sessions')
  async getActiveSessions(): Promise<{ sessions: string[] }> {
    try {
      const sessions = this.voiceService.getActiveSessions();
      
      return { sessions };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new HttpException(
        `Failed to get active sessions: ${errorMessage}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
} 
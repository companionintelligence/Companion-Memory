/**
 * This module handles speech-related functionalities, including Speech-to-Text (STT)
 * and Text-to-Speech (TTS) conversions. It provides API endpoints that likely proxy
 * requests to an external speech processing service.
 *
 * ### Key Components:
 * - **`STTController`**: Exposes an endpoint for converting spoken audio into text.
 * - **`TTSController`**: Exposes an endpoint for converting text into spoken audio.
 * - **`VoiceboxController`**: Exposes endpoints for voice cloning and custom voice synthesis.
 * - **`ProxyService`**: A generic service used to forward requests to third-party APIs,
 *   in this case, the underlying speech service.
 *
 * @module SpeechModule
 */

import { Module } from '@nestjs/common';

import { ProxyService } from '@ci/common/services/ProxyService';

import { STTController } from './controllers/STTController';
import { TTSController } from './controllers/TTSController';
import { VoiceboxController } from './controllers/VoiceboxController';

/**
 * @internal
 */
@Module({
  imports: [],
  providers: [ProxyService],
  controllers: [STTController, TTSController, VoiceboxController],
  exports: [],
})
export class SpeechModule {}

// Entities
export {};

// Services
export {};

// Types
export type { TTSConvertRequest, TTSConvertResponse, VoiceProfile, VoiceProfileCreateRequest, VoiceSynthesizeRequest } from './types';

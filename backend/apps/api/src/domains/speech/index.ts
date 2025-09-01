import { Module } from '@nestjs/common';

import { ProxyService } from '@ci/common/services/ProxyService';

import { STTController } from './controllers/STTController';
import { TTSController } from './controllers/TTSController';
import { AudioChunkingService } from './services/AudioChunkingService';
import { TranscriptStreamService } from './services/TranscriptStreamService';
import { AudioStreamGateway } from './gateways/AudioStreamGateway';

@Module({
  imports: [],
  providers: [
    ProxyService,
    AudioChunkingService,
    TranscriptStreamService,
    AudioStreamGateway,
  ],
  controllers: [STTController, TTSController],
  exports: [AudioChunkingService, TranscriptStreamService],
})
export class SpeechModule {}

// Entities
export {};

// Services
export { AudioChunkingService, type AudioChunk, type ChunkingOptions } from './services/AudioChunkingService';
export { TranscriptStreamService, type TranscriptSegment, type TranscriptStream } from './services/TranscriptStreamService';

// Types
export type {} from './types';

import { Module } from '@nestjs/common';

import { ProxyService } from '@ci/common/services/ProxyService';

import { STTController } from './controllers/STTController';
import { TTSController } from './controllers/TTSController';

@Module({
  imports: [],
  providers: [ProxyService],
  controllers: [STTController, TTSController],
  exports: [],
})
export class SpeechModule {}

// Entities
export {};

// Services
export {};

// Types
export type {} from './types';

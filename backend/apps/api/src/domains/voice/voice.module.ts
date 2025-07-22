import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { VoiceController } from './controllers/voice.controller';
import { VoiceService } from './services/voice.service';
import { WhisperXService } from './services/whisperx.service';
import { SesameAIService } from './services/sesameai.service';
import { VoiceApiService } from './services/voice-api.service';

@Module({
  imports: [ConfigModule],
  controllers: [VoiceController],
  providers: [VoiceService, WhisperXService, SesameAIService, VoiceApiService],
  exports: [VoiceService],
})
export class VoiceModule {} 
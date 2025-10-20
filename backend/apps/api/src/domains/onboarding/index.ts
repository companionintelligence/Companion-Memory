import { Module } from '@nestjs/common';

import { ConversationModule } from '@ci/domains/conversations';
import { GraphModule } from '@ci/domains/graph';
import { IntelligenceModule } from '@ci/domains/intelligence';
import { MemoryModule } from '@ci/domains/memory';
import { UserModule } from '@ci/domains/user';

import { OnboardingController } from './controllers/OnboardingController';
import { OnboardingService } from './services/OnboardingService';

@Module({
  imports: [ConversationModule, IntelligenceModule, UserModule, MemoryModule, GraphModule],
  providers: [OnboardingService],
  controllers: [OnboardingController],
  exports: [OnboardingService],
})
export class OnboardingModule {}

// Entities
export {};

// Services
export { OnboardingService } from './services/OnboardingService';

// Types
export type {} from './types';

import { Module } from '@nestjs/common';

import { ConversationModule } from '@ci/domains/conversations';
import { IntelligenceModule } from '@ci/domains/intelligence';
import { UserModule } from '@ci/domains/user';

import { OnboardingController } from './controllers/OnboardingController';

@Module({
  imports: [ConversationModule, IntelligenceModule, UserModule],
  providers: [],
  controllers: [OnboardingController],
  exports: [],
})
export class OnboardingModule {}

// Entities
export {};

// Services
export {};

// Types
export type {} from './types';

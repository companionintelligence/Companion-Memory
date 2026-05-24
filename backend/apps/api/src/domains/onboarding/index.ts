/**
 * This module orchestrates the user onboarding process. It provides the necessary
 * endpoints to guide a new user through the initial setup steps of the application.
 *
 * ### Key Components:
 * - **OnboardingController**: Exposes REST API endpoints that coordinate the various
 *   stages of onboarding, such as creating initial user data or setting up
 *   introductory conversations.
 *
 * ### Module Integration:
 * - **`UserModule`**: To create and configure the user's account.
 * - **`ConversationModule`**: To initialize welcome messages or introductory threads.
 * - **`IntelligenceModule`**: To potentially trigger initial data processing or
 *   intelligence-gathering tasks for the new user.
 *
 * @module OnboardingModule
 */

import { Module } from '@nestjs/common';

import { ConversationModule } from '@ci/domains/conversations';
import { GraphModule } from '@ci/domains/graph';
import { IntelligenceModule } from '@ci/domains/intelligence';
import { MemoryModule } from '@ci/domains/memory';
import { UserModule } from '@ci/domains/user';

import { OnboardingController } from './controllers/OnboardingController';
import { OnboardingService } from './services/OnboardingService';

/**
 * @internal
 */
@Module({
  imports: [ConversationModule, GraphModule, IntelligenceModule, UserModule, MemoryModule],
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

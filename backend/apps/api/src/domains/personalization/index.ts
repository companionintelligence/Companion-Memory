import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DailyMetricsModule } from '@ci/domains/daily-metrics';
import { EventsModule } from '@ci/domains/events';
import { GraphModule } from '@ci/domains/graph';
import { IntelligenceModule } from '@ci/domains/intelligence';
import { BrowserActivityInsightPreferenceModule } from '@ci/domains/llm/browser-activity-insight-preference.module';
import { ChatModelPreferenceModule } from '@ci/domains/llm/chat-model-preference.module';
import { LlmCoreModule } from '@ci/domains/llm/core.module';
import { ImageDescriptionPreferenceModule } from '@ci/domains/llm/image-description-preference.module';
import { MemoryModule } from '@ci/domains/memory';

import './events';

import { ContextPromptController } from './controllers/ContextPromptController';
import { PersonalizationController } from './controllers/PersonalizationController';
import { ContextPromptEntity } from './entities/ContextPromptEntity';
import { ContextPromptPersistListener } from './listeners/ContextPromptPersistListener';
import { FeedQueuePopulationListener } from './listeners/FeedQueuePopulationListener';
import { PlacementService } from './placement';
import { ConceptExtractionService } from './services/ConceptExtractionService';
import { ContextPromptGenerateService } from './services/ContextPromptGenerateService';
import { ContextPromptPersistService } from './services/ContextPromptPersistService';
import { ContextPromptService } from './services/ContextPromptService';
import { CrossTableHydrationService } from './services/CrossTableHydrationService';
import { LifeContextService } from './services/LifeContextService';
import { PersonalizationService } from './services/PersonalizationService';

@Module({
  imports: [
    DailyMetricsModule,
    EventsModule,
    TypeOrmModule.forFeature([ContextPromptEntity]),
    MemoryModule,
    GraphModule,
    IntelligenceModule,
    LlmCoreModule,
    ImageDescriptionPreferenceModule,
    BrowserActivityInsightPreferenceModule,
    ChatModelPreferenceModule,
  ],
  controllers: [PersonalizationController, ContextPromptController],
  providers: [
    PersonalizationService,
    ContextPromptService,
    PlacementService,
    ContextPromptGenerateService,
    ContextPromptPersistService,
    ContextPromptPersistListener,
    ConceptExtractionService,
    CrossTableHydrationService,
    LifeContextService,
    FeedQueuePopulationListener,
  ],
  exports: [
    PersonalizationService,
    ContextPromptService,
    PlacementService,
    ContextPromptGenerateService,
    CrossTableHydrationService,
    LifeContextService,
  ],
})
export class PersonalizationModule {}

export {
  PersonalizationService,
  ContextPromptService,
  ContextPromptGenerateService,
  CrossTableHydrationService,
  LifeContextService,
  PlacementService,
};
export { estimateActivityDurationMinutes, flexWindow } from './placement';
export type {
  PersonalizationProfile,
  TrustMode,
  PersonalizationDecision,
  PersonalizationActionKind,
} from './types';

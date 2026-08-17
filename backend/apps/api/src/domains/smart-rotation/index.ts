import { Module } from '@nestjs/common';

import { LoggingModule } from '@ci/common/logging';
import { EventsModule } from '@ci/domains/events';
import { IntelligenceModule } from '@ci/domains/intelligence';
import { LLMModule } from '@ci/domains/llm';
import { MaintenanceModule } from '@ci/domains/maintenance';
import { MemoryModule } from '@ci/domains/memory';
import { PersonalizationModule } from '@ci/domains/personalization';
import { PythonFunctionsModule } from '@ci/domains/python-functions';
import { ScheduleModule } from '@ci/domains/schedule';
import { SearchNextModule } from '@ci/domains/search-next';

import './events';

import { AnswerInferenceCron } from './cron/AnswerInferenceCron';
import { EntityPromotionCron } from './cron/EntityPromotionCron';
import {
  SmartRotationAnswerInferCron,
  SmartRotationGraphEnrichCron,
  SmartRotationGraphLinkCron,
  SmartRotationHydrateAnswersCron,
  SmartRotationHydrateInventoryCron,
  SmartRotationInsightsCron,
  SmartRotationContextPromptCron,
  SmartRotationQuestionFeedCron,
  SmartRotationScheduleSyncCron,
  SmartRotationSummariesCron,
} from './cron/SmartRotationScheduledCrons';
import { AnswerInferenceListener } from './listeners/AnswerInferenceListener';
import { SmartRotationListener } from './listeners/SmartRotationListener';
import { ContextGapQuestionService } from './services/ContextGapQuestionService';
import { SmartRotationService } from './services/SmartRotationService';

@Module({
  imports: [
    EventsModule,
    IntelligenceModule,
    LLMModule,
    MemoryModule,
    ScheduleModule,
    MaintenanceModule,
    PersonalizationModule,
    SearchNextModule,
    PythonFunctionsModule,
    LoggingModule,
  ],
  providers: [
    SmartRotationService,
    ContextGapQuestionService,
    SmartRotationListener,
    AnswerInferenceListener,
    AnswerInferenceCron,
    SmartRotationQuestionFeedCron,
    SmartRotationAnswerInferCron,
    SmartRotationScheduleSyncCron,
    SmartRotationInsightsCron,
    SmartRotationSummariesCron,
    SmartRotationGraphLinkCron,
    SmartRotationGraphEnrichCron,
    SmartRotationContextPromptCron,
    SmartRotationHydrateAnswersCron,
    SmartRotationHydrateInventoryCron,
    EntityPromotionCron,
  ],
  exports: [SmartRotationService],
})
export class SmartRotationModule {}

export { SmartRotationService };

import { Module } from '@nestjs/common';

import { LoggingModule } from '@ci/common/logging';
import { AgentModule } from '@ci/domains/agent';
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
import {
  SmartRotationAnswerInferCron,
  SmartRotationGraphEnrichCron,
  SmartRotationGraphLinkCron,
  SmartRotationHydrateAnswersCron,
  SmartRotationHydrateThingsCron,
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
    // Provides RecallService — the retrieval pipeline AnswerInferenceListener
    // grounds inferred answers in. Not a cycle: nothing in the Agent graph
    // imports SmartRotationModule (only application.ts does), which is the same
    // reason ScheduleModule can import AgentModule for the same service.
    AgentModule,
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
    SmartRotationHydrateThingsCron,
  ],
  exports: [SmartRotationService],
})
export class SmartRotationModule {}

export { SmartRotationService };

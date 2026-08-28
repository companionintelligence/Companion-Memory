/**
 * @module LLMModule
 */

import { Module } from '@nestjs/common';

import { ConversationModule } from '@ci/domains/conversations';
import { DailyMetricsModule } from '@ci/domains/daily-metrics';
import { EventsModule } from '@ci/domains/events';
import { FilesModule } from '@ci/domains/files';
import { IntelligenceModule } from '@ci/domains/intelligence';
import { MemoryModule } from '@ci/domains/memory';
import { PlanningModule } from '@ci/domains/planning';
import { PredictionsModule } from '@ci/domains/predictions';
import { SearchNextModule } from '@ci/domains/search-next';
import { SummariesModule } from '@ci/domains/summaries';
import { ToolsModule } from '@ci/domains/tools';

import { LlmEndpointController } from './controllers/LlmEndpointController';
import { OllamaController } from './controllers/OllamaController';
import { LlmCoreModule } from './core.module';
import { ImageDescriptionPreferenceModule } from './image-description-preference.module';
import { ChatGenerateListener } from './listeners/ChatGenerateListener';
import { CvDetectionsListener } from './listeners/CvDetectionsListener';
import { ImageDescriptionBackfillListener } from './listeners/ImageDescriptionBackfillListener';
import { ImageDescriptionListener } from './listeners/ImageDescriptionListener';
import { ThingVisionListener } from './listeners/ThingVisionListener';
import { ChatGenerationBroker } from './services/ChatGenerationBroker';
import { ChatTurnService } from './services/ChatTurnService';

/**
 * @internal
 */
@Module({
  imports: [
    LlmCoreModule,
    ConversationModule,
    DailyMetricsModule,
    EventsModule,
    FilesModule,
    IntelligenceModule,
    ImageDescriptionPreferenceModule,
    MemoryModule,
    PlanningModule,
    PredictionsModule,
    SearchNextModule,
    SummariesModule,
    ToolsModule,
  ],
  providers: [
    ChatGenerationBroker,
    ChatTurnService,
    ChatGenerateListener,
    CvDetectionsListener,
    ImageDescriptionListener,
    ImageDescriptionBackfillListener,
    ThingVisionListener,
  ],
  controllers: [OllamaController, LlmEndpointController],
  exports: [LlmCoreModule],
})
export class LLMModule {}

export { LlmCoreModule } from './core.module';
export { OllamaService } from './services/OllamaService';
export { PROMPT_MODEL, UTILITY_MODEL, type ChatRequestContext } from './services/OllamaService';
export { LLM_QUEUE, LLM_QUEUE_OPTIONS } from './constants';
export {
  ANSWER_SUPPORT_LEVELS,
  type AnswerSupport,
  answersTheQuestion,
  calibrateInferredConfidence,
  confidenceLabel,
  CONFIDENCE_IMPLIED_CEILING,
  CONFIDENCE_NON_ANSWER,
  CONFIDENCE_OFF_QUESTION,
  CONFIDENCE_UNATTRIBUTED,
  DEFAULT_MIN_ANSWER_CONFIDENCE,
  enforceEvidenceIsAboutThePerson,
  enforceFirstPersonEvidence,
  enforceForcedChoiceCommitment,
  enforceYesNoQualifierIsInformative,
  estimateInferredAnswerConfidence,
  extractForcedChoiceAlternatives,
  type ForcedChoiceAlternative,
  type ForcedChoiceQuestion,
  INFERRED_ANSWER_JSON_SCHEMA,
  INFERRED_ANSWER_PROMPT_RULES,
  type InferredAnswer,
  isAboutSomethingElse,
  isNarratedVoice,
  isNonAnswer,
  normalizeAnswerSupport,
  normalizeEvidenceRefs,
  parseInferredAnswer,
  sanitizeInferredAnswerVoice,
  supportConfidenceCeiling,
} from './inferredAnswerConfidence';
export { CV_DETECTION_LINKED_TABLE } from './listeners/CvDetectionsListener';
export {
  CvDetectionsCapturedEvent,
  type CvDetection,
  type CvDetectionKind,
  type CvBBoxNormalized,
  type CvDetectionsCapturedPayload,
} from './events';

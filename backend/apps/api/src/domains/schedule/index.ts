import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { LoggingModule } from '@ci/common/logging';
import { AgentModule } from '@ci/domains/agent';
import { ActionEntity } from '@ci/domains/intelligence';
import { LLMModule } from '@ci/domains/llm';
import { MemoryModule } from '@ci/domains/memory';
import { PersonalizationModule } from '@ci/domains/personalization';
import { PredictionsModule } from '@ci/domains/predictions';
import { SummaryEntity } from '@ci/domains/summaries';

import { EventCandidateEntity } from './entities/EventCandidateEntity';
import { RhythmEntity } from './entities/RhythmEntity';
import { CandidateService } from './services/CandidateService';
import { SuggestionSyncService } from './services/SuggestionSyncService';
import { TaskBreakdownService } from './services/TaskBreakdownService';

@Module({
  imports: [
    // ActionEntity/SummaryEntity are registered for read-only projection into
    // candidates; the schedule domain deliberately depends on their tables, not
    // on IntelligenceModule/SummariesModule, to keep the coupling one-way.
    TypeOrmModule.forFeature([EventCandidateEntity, RhythmEntity, ActionEntity, SummaryEntity]),
    MemoryModule,
    PersonalizationModule,
    AgentModule,
    LLMModule,
    LoggingModule,
    PredictionsModule,
  ],
  providers: [CandidateService, SuggestionSyncService, TaskBreakdownService],
  exports: [CandidateService, SuggestionSyncService, TaskBreakdownService],
})
export class ScheduleModule {}

export { EventCandidateEntity, RhythmEntity };
export { CandidateService, SuggestionSyncService, TaskBreakdownService };
export type {
  EventCandidate,
  CandidateStatus,
  RationaleSource,
  TimeFlex,
} from './entities/EventCandidateEntity';
export type { Rhythm, RhythmKind, RhythmSource, RhythmStrength } from './entities/RhythmEntity';
export {
  USER_AUTHORED_GENERATOR_PREFIX,
  type CreateCandidateDto,
  type CreateRhythmDto,
  type DeclineReason,
  type UpdateRhythmDto,
} from './types';
